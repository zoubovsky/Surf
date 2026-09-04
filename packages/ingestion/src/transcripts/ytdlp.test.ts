import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptBlockedError, TranscriptError } from "./errors.js";
import { whichBinary, YtDlpProvider, type ExecFn } from "./ytdlp.js";

const JSON3 = readFileSync(new URL("../__fixtures__/innertube/captions.json3", import.meta.url), "utf8");

describe("YtDlpProvider", () => {
  it("returns null without running anything when yt-dlp is not installed", async () => {
    let ran = false;
    const p = new YtDlpProvider({
      which: async () => null,
      exec: async () => {
        ran = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    expect(await p.available()).toBe(false);
    expect(await p.fetch("3wXfppSKkpg")).toBeNull();
    expect(ran).toBe(false);
  });

  it("runs the documented command and parses the json3 subtitle file", async () => {
    let seen: { file: string; args: string[] } | null = null;
    const exec: ExecFn = async (file, args, opts) => {
      seen = { file, args };
      await writeFile(join(opts.cwd, "3wXfppSKkpg.en.json3"), JSON3);
      await writeFile(join(opts.cwd, "3wXfppSKkpg.en-orig.json3"), JSON3);
      return { stdout: "[info] Writing video subtitles", stderr: "", code: 0 };
    };
    const p = new YtDlpProvider({
      which: async () => "/usr/local/bin/yt-dlp",
      exec,
      tmpDir: tmpdir(),
      clock: { now: () => 7 },
    });
    const t = await p.fetch("3wXfppSKkpg");
    expect(t).toMatchObject({ videoId: "3wXfppSKkpg", language: "en", source: "yt-dlp", fetchedAt: 7 });
    expect(t!.segments).toHaveLength(5);
    const s = seen!;
    expect(s.file).toBe("/usr/local/bin/yt-dlp");
    expect(s.args).toEqual(
      expect.arrayContaining([
        "--skip-download",
        "--write-auto-subs",
        "--sub-langs",
        "en.*,en",
        "--sub-format",
        "json3",
        "-o",
      ]),
    );
    expect(s.args[s.args.length - 1]).toBe("https://www.youtube.com/watch?v=3wXfppSKkpg");
    expect(s.args[s.args.indexOf("-o") + 1]).toMatch(/%\(id\)s$/);
  });

  it("classifies bot checks as blocked and missing subtitles as null", async () => {
    const botCheck = new YtDlpProvider({
      which: async () => "yt-dlp",
      exec: async () => ({
        stdout: "",
        stderr: "ERROR: [youtube] 3wXfppSKkpg: Sign in to confirm you’re not a bot.",
        code: 1,
      }),
    });
    await expect(botCheck.fetch("3wXfppSKkpg")).rejects.toBeInstanceOf(TranscriptBlockedError);

    const noSubs = new YtDlpProvider({
      which: async () => "yt-dlp",
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    expect(await noSubs.fetch("3wXfppSKkpg")).toBeNull();

    const gone = new YtDlpProvider({
      which: async () => "yt-dlp",
      exec: async () => ({ stdout: "", stderr: "ERROR: Private video", code: 1 }),
    });
    expect(await gone.fetch("3wXfppSKkpg")).toBeNull();

    const other = new YtDlpProvider({
      which: async () => "yt-dlp",
      exec: async () => ({ stdout: "", stderr: "ERROR: Unable to download webpage", code: 1 }),
    });
    const e = (await other.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e).toBeInstanceOf(TranscriptError);
    expect(e.retryable).toBe(true);
  });

  it("whichBinary scans PATH without a shell", async () => {
    expect(await whichBinary("definitely-not-a-real-binary-xyz")).toBeNull();
    expect(await whichBinary("node")).toMatch(/node$/);
    expect(await whichBinary("/nonexistent/path/yt-dlp")).toBeNull();
  });
});
