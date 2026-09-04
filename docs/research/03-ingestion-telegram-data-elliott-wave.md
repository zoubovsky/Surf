# Ingestion & Notification Plumbing — Research Report

*Researched 2026-09-04. Channel facts were verified live (channel HTML, RSS feeds, watch pages).*

---

## A. YouTube: "More Crypto Online" monitoring + transcripts

### A1. Channel identity and content profile

| Item | Value (verified) |
|---|---|
| Name / handle | More Crypto Online — `@morecryptoonline` |
| Channel ID | **`UCngIhBkikUe6e7tZTjpKK7Q`** |
| Stats (About page) | 325K subscribers, **27,201 videos**, 82.5M views, joined 11 Jun 2021, United Kingdom |
| Operator | MCO Global Ltd, London |
| Description | "professional Elliott Wave and technical analysis on global markets, focusing cryptocurrencies and cryptocurrency related stocks" |
| Paid content | Patreon (patreon.com/morecryptoonline); no YouTube membership detected |
| Sister channel | German-language "More Crypto Online DE" — `UCRRrpK63KNPZMTLbv61UKRw` (ignore) |

**Cadence is very high.** The RSS feed held 15 entries spanning ~62 hours. About half are duplicates: each long-form video is re-posted as a Short with the **identical title**. Verified pairs:

- `bBNu9b3HyWw` "Bitcoin Must Hold These 3 Support Levels" — 535 s, long-form
- `Z0HPtP95Fx0` same title — 83 s, Short
- `3wXfppSKkpg` "Bitcoin Price: Why 79K Is the Level to Watch Today" — 1,082 s, long-form

Net long-form output is roughly **4–6 videos/day**, of which **1–2/day are Bitcoin**.

**Title conventions.** Bitcoin videos reliably contain "Bitcoin" (occasionally "BTC"). Older titles carried an "Elliott Wave Analysis" suffix; current titles do not, so **do not filter on "Elliott Wave"**. Titles frequently embed the key level (79K), which is itself a cheap signal.

**Filtering is mandatory.** The same feed window included ETH, SOL, XRP and HYPE; the channel also covers ADA, MATIC, AVAX, LINK and crypto-related stocks. Recommended filter: `/\bbitcoin\b|\bbtc\b/i` on title, with a combined-video allowance ("Bitcoin & Ethereum…").

### A2. Detecting new uploads without getting banned

**Option 1 — RSS, no key, no quota (recommended primary).**
`https://www.youtube.com/feeds/videos.xml?channel_id=UCngIhBkikUe6e7tZTjpKK7Q` returns the 15 newest items (Shorts included). Better: hidden per-type playlists by swapping the `UC` prefix — `UULF` = long-form only, `UUSH` = Shorts, `UULV` = live streams. Verified that
`https://www.youtube.com/feeds/videos.xml?playlist_id=UULFngIhBkikUe6e7tZTjpKK7Q`
returns **only long-form videos with no duplicate Shorts**. Poll every 5–10 min with `If-None-Match`/`If-Modified-Since`.

**Option 2 — YouTube Data API v3.** `search.list` costs 100 units; `playlistItems.list` costs 1 unit; default quota 10,000 units/day. Uploads playlist ID = `UU` + channel-ID suffix. Poll `playlistItems.list` on `UULF…` every 5 min = 288 units/day. Add `videos.list` (1 unit, `part=contentDetails,liveStreamingDetails`) to get duration and live/premiere status — the RSS feed carries neither.

**Option 3 — WebSub/PubSubHubbub push.** Hub `https://pubsubhubbub.appspot.com/subscribe`, topic `https://www.youtube.com/xml/feeds/videos.xml?channel_id=…`. Max lease **10 days**; renew before expiry. Quirks: pings can arrive before the video shows in the feed; private/scheduled videos can ping; old videos ping on edits. Treat a ping as a *trigger* and then fetch the feed. Requires a public HTTPS callback.

**Recommendation:** UULF RSS polling as primary, WebSub as optional latency booster, Data API `videos.list` for duration/live enrichment.

### A3. Transcript retrieval — 2026 reality

All five sampled videos had an auto-generated English track (`kind: asr`). Captions exist; the problem is *access from servers*.

| Method | Status Sep 2026 | Notes |
|---|---|---|
| **youtube-transcript-api** (Python, v1.2.4) | Works from residential IPs; **blocked from AWS/GCP/Azure**. Built-in `WebshareProxyConfig` — must be *rotating Residential* ([#593](https://github.com/jdepoix/youtube-transcript-api/issues/593)) | Reverse-engineered, no SLA |
| **yt-dlp** `--skip-download --write-auto-subs` | Needs a **PO token for subtitle requests** (`bgutil-ytdlp-pot-provider`); datacenter IPs hit bot checks and subtitle-specific 429s ([PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)) | Heavier, breaks periodically, actively maintained |
| **Official `captions.download`** | **OAuth as the video owner only; third-party videos return 403 by design** | Not usable |
| **Supadata** (paid) | Free 100 credits/mo; Basic $5/300; Pro $17/3,000. 1 credit per transcript; AI-fallback transcription 2 credits/min ([pricing](https://supadata.ai/pricing)). Reported reliable from cloud | Alternatives: TranscriptAPI, ChocoData, SocialCrawl |
| **Audio + STT** | yt-dlp audio (same PO-token issues) → Deepgram Nova-3 $0.0043/min, OpenAI gpt-4o-mini-transcribe $0.003/min | ~2 BTC videos/day × 15 min ≈ $0.15/day |

**Recommended chain (BTC-only volume ≈ 40–60 videos/month):**
1. **Primary: Supadata** (Basic tier, $5) — simplest cloud-safe path. If the agent runs on a residential box, run youtube-transcript-api direct as primary and Supadata as fallback.
2. **Fallback: youtube-transcript-api via Webshare rotating-residential** (~$6–10/mo).
3. **Last resort: yt-dlp + PO-token plugin → audio → Deepgram Nova-3**, also covers videos where ASR captions are not yet generated.
4. Schedule: attempt at T+10 min after feed detection; retry with backoff for 6 h (live VODs take 12–24 h).

### A4. Members-only / live streams?

- **Live streams: occasional, not the main format** (30 past streams; most recent months ago). Excluded from `UULF`; poll `UULV…` separately if wanted, and fetch transcripts only after `liveStreamingDetails.actualEndTime` is set.
- **Membership:** paid content lives on Patreon; the public pipeline is unaffected.

---

## B. Telegram bot (two-way, single operator)

**Update delivery.** `getUpdates` long polling and `setWebhook` are mutually exclusive. For a single-user bot without inbound ports, **long polling is simpler and equally reliable**.

**Restricting to one chat.** `ALLOWED_CHAT_ID` in config; enforce at the outermost middleware (grammY: first `bot.use()` drops any `ctx.chat?.id !== ALLOWED`). Keep privacy mode on, disable inline mode, never add the bot to groups. Treat unknown chats as an alert-worthy event.

**Formatting & limits.** Text 4,096 chars; implement a splitter that breaks at newlines and preserves open `<pre>` tags. Prefer **HTML parse_mode** over MarkdownV2 (which requires escaping 18 characters and constantly 400s on prices like "-3.2%"). Inline keyboards: `callback_data` 1–64 bytes; always `answerCallbackQuery`; use `editMessageText` to update a live "positions card" in place. Rate: ~1 msg/s per chat.

**Library choice.** **grammY** (TypeScript-first, tracks the Bot API within days, official plugins: `menu`, `conversations`, `runner`, `ratelimiter`). Telegraf v4 support ended Feb 2025 — avoid. python-telegram-bot v22.8 is the Python equivalent.

**Command structure** (register via `setMyCommands`):

| Command | Behavior |
|---|---|
| `/pnl [today\|7d\|30d\|all]` | Realized/unrealized PnL, fees, max drawdown; `<pre>` table |
| `/positions` | Open positions with entry, size, stop, invalidation level, current EW count tag; inline buttons `[Close 50%] [Close all] [Move stop]` → confirmation step |
| `/brief` | Latest research brief: last MCO BTC video summary (primary/alt count, invalidation), funding/OI snapshot, macro calendar next 48 h |
| `/pause` / `/resume` | Persisted `trading_enabled` flag checked before every order; `[Pause new entries only] [Pause + flatten]` with a nonce in `callback_data` |
| `/status` | Heartbeat: last candle time, feed/transcript pipeline health, last error |
| `/why <trade_id>` | Stored rationale for a trade |

Push side: outbound queue (new-video-digested, trade opened/closed, invalidation hit, pipeline failure) with severity → `disable_notification` for low severity.

---

## C. Market data

### C1. BTC 1h OHLCV — historical and live

| Source | Historical | Live | Limits | Geo |
|---|---|---|---|---|
| **Binance** | REST `/api/v3/klines` 1,000 bars/req. **Bulk: `data.binance.vision` daily/monthly zips, spot + USD-M futures, all intervals** | `wss://stream.binance.com:9443/ws/btcusdt@kline_1h` | Generous | **HTTP 451 from US IPs, including public endpoints** |
| **Bybit v5** | `/v5/market/kline` 1,000 bars/req | Public WS kline | 600 req / 5 s per IP | US IPs 403; **CloudFront blocks cloud-provider ranges even for public data** |
| **Coinbase Advanced Trade** | Public candles, no auth, **300 candles/req**; full BTC-USD history since 2015 in <300 requests | WS `candles` channel | 10 req/s | US-friendly |
| **Kraken** | `/0/public/OHLC` returns **only the last 720 candles** — unusable for backfill | WS v2 `ohlc` | ~1 req/s | US-friendly |
| **CoinGecko** | Hourly granularity only for 2–90-day ranges — not a 1h source | none | 30 calls/min demo | Reference price only |
| **CryptoCompare / CoinDesk Data** | **Free tier retired 21 May 2026** | — | — | Drop |
| **Strike Finance** | `/price/v2/klines` 1h since 2026-03-20 (index/mark/last) | WS `kline_1h`, `markprice` | 2400 weight/min | Reachable |

**Recommendation:** Canonical history = `data.binance.vision` monthly 1h zips for `BTCUSDT` if egress permits, else Coinbase BTC-USD. Live = Coinbase or Kraken WebSocket if US-hosted, Binance WS otherwise; always cross-check the closed 1h bar against a second venue and store the venue tag. Never mix spot and perp series inside one EW count. Strike's own index klines are the execution-venue truth for the 2026 window.

### C2. Funding, open interest, derivatives

- **Binance USD-M:** `/fapi/v1/fundingRate` (history to 2019) and `/futures/data/openInterestHist` — **only the last 30 days**. Same 451 geo issue.
- **Bybit:** `/v5/market/funding/history` and `/v5/market/open-interest`.
- **Coinalyze (free, key required):** aggregated cross-exchange OI/funding/liquidations, 40 calls/min.
- **Coinglass (paid, from $29/mo):** CME OI, ETF net flows/AUM. The only turnkey ETF+CME source found.
- **Strike stats:** `/stat/v1/stats/coin/history/funding|open-interest|long-short-ratio`.

### C3. News / macro feed for the research agent

- **RSS (free, robust):** CoinDesk, The Block, Cointelegraph, CME Group RSS.
- **Finnhub** — free 60 calls/min, `/news?category=crypto`, economic calendar.
- **Alpha Vantage `NEWS_SENTIMENT`** with `topics=blockchain` — 25 req/day free; fine for one daily brief.
- **CryptoPanic API** — free plan limited.
- **Macro calendar:** ForexFactory wrappers; FRED API (free) for rates/CPI series; SEC EDGAR full-text search for ETF filings.

---

## D. Elliott Wave — algorithmic state of the art and a workable hybrid

### D1. Open-source libraries (honest inventory)

| Repo | What it does | Maturity |
|---|---|---|
| [btcorgtfo/ElliottWaveAnalyzer](https://github.com/btcorgtfo/ElliottWaveAnalyzer) (Python) | MonoWaves → WavePatterns (12345, ABC) validated by pluggable WaveRules | 203 stars; README: "first version of a (not yet) iterative scanner" |
| [DrEdwardPCB/python-taew](https://github.com/DrEdwardPCB/python-taew) | MATLAB port; finds wave-1 candidates then valid 2…5 | 26 stars; author disclaims accuracy |
| Various (alessioricco, ESJavadex, Wkemery) | Pattern finders / Flask apps with Fib projections | Hobby projects, unmaintained |
| TypeScript | **No credible EW library found.** Swing detection via `technicalindicators` or hand-rolled ZigZag | — |
| Best-engineered reference | LuxAlgo "Elliott Wave Rule Engine" (Pine): pivot length 10, last six swings form a candidate 1-5, three hard rules as PASS/FAIL, diagonal toggle relaxes only the overlap rule, auto re-anchoring ([page](https://www.luxalgo.com/library/indicator/pU115xkA-elliott-wave-rule-engine/)) | Design spec |

**Verdict:** nothing production-grade exists. Plan to write ~500 lines: ZigZag → candidate enumeration → rule pruning → Fibonacci scoring.

### D2. Rules and guidelines to encode

Hard rules (violating any = invalid impulse):
1. Wave 2 never retraces >100% of wave 1.
2. Wave 3 is never the shortest of 1, 3, 5.
3. Wave 4 never enters wave 1's price territory — **except in diagonals** (leading diagonal = wave 1/A, ending diagonal = wave 5/C).

Guidelines (scoring, not pruning): W2 retraces 50–61.8% of W1; W3 extends 138.2–161.8% of W1; W4 retraces 23.6–38.2% of W3; W5 ≈ W1 or 0.618×(W1+W3); alternation between W2 and W4; one wave usually extends; corrections are 3-wave (zigzag 5-3-5, flat 3-3-5, triangle 3-3-3-3-3).

Confluence practitioners use: wave 3 carries the highest volume and RSI of the cycle; wave 5 shows bearish RSI/MACD divergence vs wave 3; counts must agree across two timeframes; Fib target clusters coinciding with horizontal S/R get priority.

### D3. Academic and LLM work

- Rule/heuristic algorithms (Vantuch et al. 2018; Kotyrba & Volná 2013; a 2025/26 IEEE Access pivot-detection paper). Reported >70% "trend prediction" accuracies are in-sample or lightly validated.
- LLM/agents: **ElliottAgents** ([arXiv 2507.03435](https://arxiv.org/abs/2507.03435)); **StockGenChaR** ([arXiv 2412.04041](https://arxiv.org/pdf/2412.04041)) shows vision-language models are unreliable at precise pivot placement; "Reasoning on Time-Series" ([arXiv 2511.08616](https://arxiv.org/pdf/2511.08616)) shows LLMs do better when price is serialised as text than as images.

### D4. Honest assessment

Elliott Wave is under-determined: for any swing sequence there are typically several rule-valid counts, and counts get relabeled after the fact. No peer-reviewed work demonstrates out-of-sample trading edge from automated counting. LLMs looking at chart images hallucinate pivots. What *is* tractable: (a) deterministic swing detection, (b) deterministic hard-rule checking and Fib scoring, (c) LLM reasoning over *structured* swing data and reconciliation with a human analyst's stated count.

**Proposed hybrid:**
1. **Deterministic layer (no LLM):** multi-threshold ZigZag on 1h and 4h (ATR-scaled thresholds) → last N swings → enumerate 5-wave and 3-wave candidates → prune by hard rules → score by Fib guidelines, alternation, RSI/volume → emit top-k counts each with **explicit invalidation price** and Fib target zones as JSON.
2. **Analyst-prior layer:** the MCO transcript pipeline extracts `{primary_count, alt_count, invalidation_levels, targets, timeframe, bias}` — the channel's format maps almost 1:1 onto this schema.
3. **LLM reconciliation:** given deterministic candidates and the MCO prior, the LLM ranks a working count, explains disagreement, outputs confidence. It may *not* override hard-rule failures or move invalidation levels.
4. **Risk hooks:** trade only when deterministic count, MCO prior, and momentum confluence agree; size scales with confidence; a breach of the invalidation level auto-flattens regardless of LLM opinion.
5. **Evaluation:** log every count and its later relabeling; measure how often the "primary" survived N bars; backtest the invalidation-stop framework separately from the count picker.

---

## Open questions

1. **Egress geography:** where will the agent run? Binance (451) and Bybit (403) block US and many cloud IP ranges even for public data.
2. **Residential IP availability:** a home box makes youtube-transcript-api viable as primary, cutting recurring cost to ~$0.
3. **Which MCO content counts as "Bitcoin":** combined "Bitcoin & Ethereum" videos? Live streams? Patreon content (operator's own paid account, ToS considerations)?
4. **Spot vs perp for the EW series:** BTCUSDT spot, USD-M perp, Coinbase BTC-USD, or Strike index? Counts differ at wicks.
5. **Latency requirement:** is 5–10 min detection plus 10–60 min ASR delay acceptable?
6. **ETF/CME data:** is the $29/mo Coinglass tier justified?
7. **Confirmation model for risky Telegram commands:** second factor beyond an inline-keyboard confirm?
8. **Evaluation baseline:** what benchmark decides whether the EW component adds value over a plain trend rule set, and over simply trading MCO's stated invalidation levels?
