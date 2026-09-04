# @surf/ingestion

Loop A plumbing: detect new **More Crypto Online** long-form Bitcoin videos and fetch their transcripts.
No LLM calls live here. Everything this package returns (titles, descriptions, transcript text) is
**untrusted data** — delimit it as such before it reaches a model, and never route it into tool arguments.

## Feed detection

```ts
import {
  FeedWatcher,
  InMemorySeenStore,
  fetchLongFormFeed,
  isBitcoinTitle,
  classifyTitle,
  isShortLike,
} from "@surf/ingestion";

const watcher = new FeedWatcher({ fetch, seen: sqliteSeenStore, clock, logger, lookbackMs: 24 * 3600_000 });
watcher.on("video", (v) => enqueueTranscriptJob(v)); // v: FeedVideo { videoId, title, publishedAt, updatedAt, url, channelId, description }
watcher.on("error", (err) => log.error(err));
watcher.start(5 * 60_000); // or call `await watcher.poll()` from your own scheduler
```

- Source: `https://www.youtube.com/feeds/videos.xml?playlist_id=UULFngIhBkikUe6e7tZTjpKK7Q` (long-form only, no Shorts, no
  live streams; 15 newest entries; `cache-control: max-age=900`). `channel_id=` feeds are supported too but include Shorts.
- `SeenStore { has(videoId); add(videoId, meta) }` is the daemon's job (SQLite). Every video inside the lookback window is
  recorded with `meta.matched`; only matched ones are emitted. Videos published before `startedAt - lookbackMs` are ignored, so
  a restart with a persistent store never re-ingests history.
- Filter: `isBitcoinTitle` = `/\bbitcoin\b|\bbtc\b/i` (also catches "Bitcoin & Ethereum"; `classifyTitle` flags `combined`).
  Do not filter on "Elliott Wave". `isShortLike(durationSec)` needs a duration from the Data API; the feed has none.
- Conditional requests (`If-None-Match` / `If-Modified-Since`, 304 handling) are implemented, but as of Sep 2026 YouTube sends no
  `ETag`/`Last-Modified` on this feed, so every poll is a full 87 KB response. Poll every 5–10 min.

## Transcripts

```ts
import {
  TranscriptChain,
  supadataFromEnv,
  InnertubeProvider,
  YtDlpProvider,
  cleanTranscript,
  windowByKeyword,
} from "@surf/ingestion";

const providers = [supadataFromEnv(), new InnertubeProvider(), new YtDlpProvider()].filter((p) => p !== null);
const chain = new TranscriptChain(providers, { clock, logger });
const r = await chain.fetchWithRetry(videoId, { deadlineMs: 6 * 3600_000 }); // waits T+10min, retries 20/40/80/160 min
// r.status: "ok" (r.transcript) | "pending" (reschedule after r.nextRetryMs) | "blocked" (every provider blocked/fatal — alert)
// r.attempts: per-provider { provider, outcome: ok|none|blocked|rate-limited|fatal|error, at, durationMs, error? }
const clean = cleanTranscript(r.transcript); // strips [Music], fixes BTC/ETH casing, "79 k" -> "79K"
const evidence = windowByKeyword(clean); // compact passages mentioning prices / support / invalidation / wave ...
```

Providers implement `TranscriptProvider { name; fetch(videoId, lang="en"): Promise<Transcript | null> }`. `null` means "no transcript for
this video (yet)"; thrown `TranscriptError`s (`TranscriptBlockedError`, `TranscriptAuthError`, `TranscriptRateLimitError`) describe provider
problems. `Transcript = { videoId, language, source, segments: {start, duration, text}[] (seconds), text, fetchedAt, isGenerated? }`.
`chain.fetch()` is the single-pass variant if the daemon runs its own retry scheduler; `fetchWithRetry` uses the injected `sleep`, so it is
safe to run inside a long-lived job (pass `immediate: true` when the daemon has already waited).

| Provider                       | Env / requirement                                                                             | Notes                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SupadataProvider` (primary)   | **`SUPADATA_API_KEY`** (`supadataFromEnv()` returns `null` without it)                        | `GET api.supadata.ai/v1/youtube/transcript?videoId=&lang=en&text=false`, header `x-api-key`. Free plan 100 credits/month at 1 req/s; 1 credit per transcript, **206 "transcript-unavailable" also costs 1 credit**; 202+`jobId` is polled at `/v1/transcript/{jobId}`. `provider.stats.credits` tracks the `x-billable-requests` header. |
| `InnertubeProvider` (fallback) | none                                                                                          | Direct watch-page + timedtext scrape. **Blocked from datacenter IPs** (verified 2026-09-04: HTTP 429 reCAPTCHA / `LOGIN_REQUIRED` bot check) — works from residential IPs.                                                                                                                                                               |
| `YtDlpProvider` (last resort)  | `yt-dlp` on `PATH` (returns `null` otherwise); pass `extraArgs` for `--proxy`/PO-token plugin | `--skip-download --write-auto-subs --sub-langs en.*,en --sub-format json3`.                                                                                                                                                                                                                                                              |

Live check of the direct path: `TRANSCRIPT_LIVE_TESTS=1 pnpm exec vitest run packages/ingestion` (skipped by default).
