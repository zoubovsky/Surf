import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { systemClock, type Clock } from "@surf/core";
import { TranscriptBlockedError, TranscriptError } from "./errors.js";
import { parseJson3 } from "./timedtext.js";
import { assertVideoId, buildTranscript, type Transcript, type TranscriptProvider } from "./types.js";

/**
 * Last-resort provider that shells out to yt-dlp:
 *   yt-dlp --skip-download --write-auto-subs --write-subs --sub-langs en.*,en --sub-format json3 -o <tmp>/%(id)s <url>
 * Returns null when the binary is not installed. Needs a PO-token plugin on datacenter IPs
 * (see docs/research/03 §A3); bot checks surface as `TranscriptBlockedError`.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number; cwd: string }) => Promise<ExecResult>;

export interface YtDlpOptions {
  /** Binary name or absolute path. Default "yt-dlp". */
  binary?: string;
  /** Extra CLI args (e.g. `--cookies`, `--proxy`, PO-token provider flags). */
  extraArgs?: string[];
  timeoutMs?: number;
  /** Parent directory for the per-call temp dir. Default `os.tmpdir()`. */
  tmpDir?: string;
  clock?: Clock;
  /** Injection points for tests. */
  exec?: ExecFn;
  which?: (binary: string) => Promise<string | null>;
}

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr) + (err && code === 1 && !stderr ? `\n${err.message}` : ""), code });
    });
  });

/** Locate an executable on PATH without spawning a shell. */
export async function whichBinary(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (binary.includes("/")) return access(binary).then(() => binary, () => null);
  for (const dir of (env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binary);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

const BOT_CHECK_RE = /Sign in to confirm you(?:'|’)re not a bot|HTTP Error 429|Too Many Requests/i;
const NO_SUBS_RE = /no subtitles|There are no subtitles|Requested format is not available/i;
const GONE_RE = /Video unavailable|Private video|This video is not available|removed by the uploader|members-only/i;

export class YtDlpProvider implements TranscriptProvider {
  readonly name = "yt-dlp";
  private readonly clock: Clock;
  private readonly exec: ExecFn;
  private readonly which: (binary: string) => Promise<string | null>;
  private resolvedBinary: string | null | undefined;

  constructor(private readonly opts: YtDlpOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.exec = opts.exec ?? defaultExec;
    this.which = opts.which ?? ((b) => whichBinary(b));
  }

  /** Whether yt-dlp is available (cached after first lookup). */
  async available(): Promise<boolean> {
    if (this.resolvedBinary === undefined) this.resolvedBinary = await this.which(this.opts.binary ?? "yt-dlp");
    return this.resolvedBinary !== null;
  }

  async fetch(videoId: string, lang = "en"): Promise<Transcript | null> {
    assertVideoId(videoId);
    if (!(await this.available())) return null;
    const binary = this.resolvedBinary as string;
    const dir = await mkdtemp(join(this.opts.tmpDir ?? tmpdir(), "surf-ytdlp-"));
    try {
      const args = [
        "--skip-download",
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs",
        `${lang}.*,${lang}`,
        "--sub-format",
        "json3",
        "--no-playlist",
        "--no-warnings",
        "-o",
        join(dir, "%(id)s"),
        ...(this.opts.extraArgs ?? []),
        "--",
        `https://www.youtube.com/watch?v=${videoId}`,
      ];
      const res = await this.exec(binary, args, { timeoutMs: this.opts.timeoutMs ?? 120_000, cwd: dir });
      const err = `${res.stderr}\n${res.stdout}`;
      if (BOT_CHECK_RE.test(err)) throw new TranscriptBlockedError(this.name, "bot-check");
      if (res.code !== 0) {
        if (GONE_RE.test(err) || NO_SUBS_RE.test(err)) return null;
        throw new TranscriptError(`yt-dlp exited ${res.code}: ${res.stderr.trim().slice(-400)}`, { provider: this.name, retryable: true });
      }
      const files = (await readdir(dir)).filter((f) => f.startsWith(`${videoId}.`) && f.endsWith(".json3"));
      // Prefer an exact language file (id.en.json3) over variants (id.en-orig.json3).
      files.sort((a, b) => (a === `${videoId}.${lang}.json3` ? -1 : b === `${videoId}.${lang}.json3` ? 1 : a.localeCompare(b)));
      const file = files[0];
      if (!file) return null;
      const language = file.slice(videoId.length + 1, -".json3".length) || lang;
      const segments = parseJson3(await readFile(join(dir, file), "utf8"));
      if (segments.length === 0) return null;
      return buildTranscript({ videoId, language, source: this.name, segments, fetchedAt: this.clock.now() });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
