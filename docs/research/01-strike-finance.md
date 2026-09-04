# Strike Finance — Research Report for a BTC Perpetuals Trading Bot

*Researched 2026-09-04. Method: `docs.strikefinance.org` returns 403 to generic fetchers, so pages were pulled via GitBook's `.md` endpoints (append `.md` to any page URL; index at <https://docs.strikefinance.org/llms.txt>), the six OpenAPI YAML specs the docs are generated from were downloaded (vendored in `strike-openapi/`), the official `strike-finance-skills` repo was read, and only public, unauthenticated endpoints were probed live on mainnet and testnet. Items marked **live** were observed on 2026-09-04.*

## 1. What Strike Finance is

- **V1 (May 2025)** was Cardano's first perps DEX, GMX-style pooled liquidity with oracle pricing. **V2 (current)** is a **central limit order book running on an off-chain deterministic "Strike Node"**; matching, funding and liquidations happen off-chain, while custody/settlement stays on-chain in "locker" contracts on **Cardano and Ethereum** (Solana wallets can also connect). Sources: [welcome](https://docs.strikefinance.org/getting-started/welcome.md), [strike-node](https://docs.strikefinance.org/perpetuals/strike-node.md), [deposits-and-withdrawals](https://docs.strikefinance.org/perpetuals/deposits-and-withdrawals.md).
- **Accounts are USD-denominated.** Volatile deposits (ADA, ETH) are auto-swapped to stablecoins (docs example: ADA → USDM) via a DEX aggregator before entering the locker; the API reports the margin asset as `USDT`/`USD`. There is no iBTC/ADA-collateral BTC market in V2. Source: [exchanger](https://docs.strikefinance.org/perpetuals/deposits-and-withdrawals/exchanger.md).
- **Products:** perpetuals only in V2 docs (31 live markets: BTC, ETH, ADA, SOL, XRP, HYPE, ZEC, NEAR, NIGHT, BNB, PUMP plus TradFi like XAU, SP500, NAS100, TSLA, NVDA). Also vaults, copy trading, TWAP/grid/trailing-stop bots, sub-accounts, RFQ.

### BTC market (live: `GET https://api.strikefinance.org/price/v2/exchangeInfo` and `GET https://api.strikefinance.org/v2/markets/BTC-USD`)

| Item | Value |
|---|---|
| Symbol | `BTC-USD` (contractType `PERPETUAL`, base `BTC`, quote/margin `USDT`) |
| Tick size / step size | 0.10 USD / 0.00001 BTC; min notional $10 |
| Max order size | 1000 BTC (limit), 120 BTC (market) |
| Price bounds | limit & market orders rejected/bounded beyond 5% of mark (`limitTakeBound`/`marketTakeBound` 0.05); `triggerProtect` 0.05 |
| Default leverage | 10x |
| Margin tiers (max leverage / MMR / maint. amount) | ≤$10k: 100x / 0.4% / 0 · ≤$50k: 75x / 0.4% · ≤$100k: 50x / 0.4% · ≤$250k: 40x / 0.4% · ≤$300k: 25x / 0.4% · ≤$800k: 25x / 0.5% / $300 · ≤$1M: 25x / 0.65% / $1,500 · ≤$2.5M: 20x · ≤$3M: 10x · ≤$10M: 10x / 1% / $12k · … ≤$100M: 1x / 2.5% / $482k |
| Liquidation fee | `liquidation_fee_rate` 1.25%, `liquidation_fee_retention_factor` 0.8 |
| Liquidity (live) | 24h volume ≈ 25.8 BTC (~$2.07M); open interest ≈ 4.5 BTC; top-of-book ~$1.30 spread. **Thin.** Relevant for slippage and kline quality. |

Note: `/v2/markets/{symbol}` is **not in the published OpenAPI specs** but is live and returns the tier table plus mark/index/last/bid/ask/funding fields; the builder reference app uses it. Treat as semi-official.

### Fees, funding, liquidation

- **Trading fees** ([trading-fees](https://docs.strikefinance.org/perpetuals/trading-fees.md); live `GET /v2/fee-tiers` matches): taker 0.050% (Tier 0, <$100k 30-day volume) down to 0.028%; **maker −0.005% (rebate)** at all base tiers. Staked STRIKE gives 5–40% discounts on positive fees.
- **Funding** ([funding-rates](https://docs.strikefinance.org/perpetuals/funding-rates.md)): paid **hourly on the hour UTC**, only to positions open at that instant. Rate = 8-hour-basis `clamp(P + E, −4%, +4%) / 8` (max ±0.5%/h); crypto interest rate 0.01% (8h). Premium sampled every 5s from impact bid/ask (impact notional $2,500 for BTC). Live BTC hourly rate ≈ 0.00118%/h. Positive → longs pay. Uses mark price.
- **Prices** ([prices](https://docs.strikefinance.org/perpetuals/prices.md)): Index = outlier-filtered weighted average of external exchanges (BTC/USDT, BTC/USD converted to USD). Mark = median(funding-adjusted index, basis-adjusted index, median(bid, ask, last)), guard-railed to index. PnL, liquidation, and default conditional-order triggers use **mark price**.
- **Liquidation** ([liquidations](https://docs.strikefinance.org/perpetuals/liquidations.md)): Margin Ratio = Maintenance Margin / (balance + uPnL). ≥70% margin call; ≥90% **reduce-only**; ≥100% staged liquidation (up to 5 reduce-only IOC attempts on the public book), then Insurance Fund / ADL. Isolated liquidation price: `LP = (EP − (IsoBalance + MA)/Size) / (1 − Dir·MMR)`. Cross and isolated per-symbol; mode switch only when flat.

## 2. The API

### Base URLs and auth

| Service | Mainnet | Testnet |
|---|---|---|
| Trade / User / Common REST | `https://api.strikefinance.org` | `https://api-v2-testnet.strikefinance.org` |
| Market data REST | `https://api.strikefinance.org/price` | `…testnet…/price` |
| Stats REST | `https://api.strikefinance.org/stat` | `…testnet…/stat` |
| Public WS | `wss://api.strikefinance.org/ws/price` | `wss://api-v2-testnet.strikefinance.org/ws/price` |
| User WS | `wss://api.strikefinance.org/ws/user-api` (docs also cite `wss://api-v2.strikefinance.org/ws/user-api`) | `wss://api-v2-testnet.strikefinance.org/ws/user-api` |

Sources: [api/getting-started](https://docs.strikefinance.org/api/getting-started.md), OpenAPI `servers` blocks, [strike-finance-skills](https://github.com/strike-finance/strike-finance-skills).

**Authentication model: API Wallet (Ed25519). Not an API key, not CIP-30/CIP-8, no CBOR.** Trading in V2 is entirely off-chain messaging; the API does **not** return unsigned Cardano transactions for orders. You generate an Ed25519 keypair (raw 32-byte hex), register the public key at <https://app.strikefinance.org/api-keys> (requires logging in with your Cardano/EVM/Solana wallet once), and sign every request:

```
Headers: X-API-Wallet-Public-Key (64 hex), X-API-Wallet-Signature (128 hex),
         X-API-Wallet-Timestamp (unix seconds, within 3 min), X-API-Wallet-Nonce (UUID v4, single-use)
Message: {METHOD}:{PATH_WITH_QUERY}:{TIMESTAMP}:{NONCE}:{SHA256_HEX(body or "")}
```

The docs contain complete Python (`cryptography`), TypeScript (`@noble/ed25519`), Go and Rust examples. API wallets **can** view/trade/change leverage but **cannot deposit or withdraw** (those need the JWT/wallet flow). Body must be serialized once and sent byte-identical to what was hashed.

Wallet signing (CIP-30 etc.) is only involved in **funding the account**: deposit = `POST /v2/deposit/quote` → `POST /v2/deposit/build-tx` (unsigned tx) → sign + submit on-chain → `POST /v2/deposit`; withdrawal = `POST /v2/withdraw/quote` → sign message → `POST /v2/withdraw`. Documented under [Builder Codes](https://docs.strikefinance.org/api/builder-codes.md) and the reference app <https://github.com/strike-finance/strike-builder-reference>. For a personal bot the simplest path is to deposit via the web app.

### Endpoints relevant to the bot

**Market data (public, base `/price`)** — [market/rest-api](https://docs.strikefinance.org/api/market/rest-api.md)
- `GET /v2/exchangeInfo` — symbols, filters, and `rateLimits`.
- `GET /v2/premiumIndex?symbol=BTC-USD` → live: `{markPrice, indexPrice, latestPremiumIndex, averagePremiumIndex, fundingRate, nextFundingTime, interestRate, interestRateDampener, time}`.
- `GET /v2/markPrice`, `GET /v2/indexPrice`, `GET /v2/ticker/price`, `GET /v2/ticker/24hr`, `GET /v2/ticker/bookTicker`, `GET /v2/depth?symbol&limit≤1000`, `GET /v2/trades?symbol&limit≤1000`, `GET /v2/openInterest`.
- `GET /v2/klines?symbol&interval&startTime&endTime&limit≤1500&priceType=last|mark|index` — Binance-format 12-element arrays; 5s server cache. Intervals `1m…1M` incl. `1h`.
- `GET /v2/l3/snapshot?symbol=BTC-USD` (base `api.strikefinance.org`) — full market-by-order book; BTC is the only L3 symbol.

**Account / positions (auth, base `api.strikefinance.org`)** — [user/rest-api](https://docs.strikefinance.org/api/user/rest-api.md)
- `GET /v2/account` → `wallet_balance, available_balance, unrealized_pnl, margin_balance, total_margin, position_initial_margin, maintenance_margin, symbol_settings (per-symbol leverage & margin mode), sub_accounts`.
- `GET /v2/balances` → array `{asset:"USDT", walletBalance, availableBalance, marginBalance, maintMargin, initialMargin, openOrderInitialMargin, maxWithdrawAmount, …}`.
- `GET /v2/positions?symbol=` → `{positions:[{id, symbol, margin_mode, leverage, size (signed), entry_price, iso_balance, upnl, maintenance_margin, bankruptcy_price, liquidation_price, accumulated_funding_fees, …}], count}`.
- `GET /v2/closedPositions`, `GET /v2/history/order` (status ints 1 pending…7 expired; cursor `fromOrderID`), `GET /v2/history/fill` (`realized_pnl, fee, role, entry_price, close_price, roi_pct, leverage`; cursor `since_trade_id`), `GET /v2/history/funding`, `GET /v2/history/transaction`. All `limit` clamped to 1000.

**Trading (auth)** — [trade/orders](https://docs.strikefinance.org/api/trade/orders.md), [trade/trading](https://docs.strikefinance.org/api/trade/trading.md)
- `POST /v2/order` — body `CreateOrderRequest`: `symbol*, side* (buy|sell), type* (limit|market|stop|stop_limit|take_profit|take_profit_limit|trailing_stop_market), size* (string, base units), price, stop_price, time_in_force (GTC|IOC|FOK), working_type (mark_price|contract_price), post_only, reduce_only, close_position, price_protect, slippage ("0.05"), callback_rate ("0.1"–"5"), activation_price, client_order_id, sub_account_id`. **Response 201 is an acknowledgement, not a fill:** `{client_order_id, account_id, symbol, sequence_id, message_id}` — no server `order_id`. Retrieve via `GET /v2/order?symbol=&client_order_id=` or the user WebSocket.
- `POST /v2/order/strategy` — bracket/OTOCO (see §3).
- `POST /v2/orders/batch`, `POST /v2/order/replace` (atomic cancel+create `{cancel:{order_id,symbol}, new_order:{…}}`), `POST /v2/order/replace-batch`, `POST /v2/orders/replace`.
- `DELETE /v2/order/cancel` body `{order_id (int), symbol}`; `DELETE /v2/order/cancel-all` body `{symbol?}` (`canceled_count: -1` = async).
- `GET /v2/openOrders?symbol=` → `Order` objects (**PascalCase** fields: `ID, ClientOrderID, Symbol, Side, Status, Type, Size, Filled, Price, StopPrice, ReduceOnly, ClosePosition, Strategy, Trailing, …`).
- `POST /v2/leverage` `{symbol, leverage (int)}` → `{leverage, maxNotionalValue}` (affects new positions only); `POST /v2/marginMode` `{symbol, marginMode: cross|isolated}` (only when flat); `POST /v2/isoMargin` `{symbol, amount, modify_type: add|remove}`.
- **Closing a position:** no dedicated endpoint; send an opposite-side `market` order with `reduce_only: true` (or a conditional with `close_position: true`).
- Algo: `POST/GET/DELETE /v2/algo/twap[/{id}]`, `POST/GET/DELETE /v2/grid/bot[/{id}]`.

**WebSockets**
- Public ([market/websocket](https://docs.strikefinance.org/api/market/websocket.md)): `{"method":"subscribe","channel":"markprice"|"kline_1h"|"depth"|"trade"|"miniticker"|"!markprice@arr","symbol":"BTC-USD","id":1}`; events mirror Binance futures (`markPriceUpdate` with `p` mark, `i` index, `r` funding, `T` next funding; `kline` with `k.x` closed flag). Server pings every 54s, drops after 60s without pong.
- User ([user/websocket](https://docs.strikefinance.org/api/user/websocket.md)): connect to `/ws/user-api`, send `{"method":"session.logon","params":{"apiKey":<pubkey hex>,"signature":hex(Ed25519("session.logon:${timestamp_ms}:${apiKey}")),"timestamp":ms}}`, then `{"method":"subscribe","channel":"userstream","account_id":"…"}`. Events: `ORDER_TRADE_UPDATE` (order lifecycle/fills: `i` order id, `c` client id, `X` status, `x` exec type, `ap`, `l`, `z`, `L`, `n` commission), `ACCOUNT_UPDATE` (balances `B`, positions `P`; reasons ORDER/FUNDING/LIQUIDATION/ADL), `strategyUpdate`. **Frames can contain multiple newline-delimited JSON events** — split on `\n`.

## 3. Resting orders with attached SL/TP — natively supported

`POST /v2/order/strategy` implements an **OTOCO bracket**: primary `type` ∈ {`limit`, `market`} (limit = a resting entry), plus `tp_order` and/or `sl_order` legs (`type` ∈ take_profit | take_profit_limit | stop | stop_limit, `stop_price*`, optional `price`, `working_type`). Legs are dormant until the primary fills, then become live reduce-only orders sized to close the position; when one fills the other is cancelled; cancelling the unfilled primary cancels the legs. Source: [order-types](https://docs.strikefinance.org/perpetuals/order-types.md) and the `CreateStrategyOrderRequest` schema.

```json
POST /v2/order/strategy
{"strategy_id":"s-001","client_order_id":"entry-001","symbol":"BTC-USD","side":"buy","type":"limit",
 "size":"0.01","price":"78000","time_in_force":"GTC",
 "tp_order":{"type":"take_profit","size":"0.01","stop_price":"82000","working_type":"mark_price"},
 "sl_order":{"type":"stop","size":"0.01","stop_price":"76500","working_type":"mark_price"}}
```

Standalone conditional orders (`stop`, `take_profit`, `trailing_stop_market` with `reduce_only`/`close_position`) are also native. Client-side logic is only needed for: stop-entry brackets (primary cannot be a stop type), moving TP/SL after entry (use `POST /v2/order/replace` on the leg, or cancel + re-place), and partial-close ladders.

## 4. SDKs, examples, rate limits, testnet, signing

- **No official TypeScript/Python SDK package.** Official assets: code samples in 4 languages ([getting-started](https://docs.strikefinance.org/api/getting-started.md)), npm `strike-finance-skills` (`npx strike-finance-skills install` — agent skills bundling the OpenAPI specs; MIT), the React reference app <https://github.com/strike-finance/strike-builder-reference> (Ed25519 auth, order/strategy placement, WS clients, PnL/liquidation math), and the OpenAPI YAMLs (generate a client with openapi-generator).
- **Signing programmatically:** pure Ed25519 over a string — any library (`@noble/ed25519`, `tweetnacl`, `pynacl`, `cryptography`). Lucid/MeshJS and seed phrases are **not needed** for trading.
- **Rate limits:** documented only via `exchangeInfo.rateLimits` (live): `REQUEST_WEIGHT 2400/min`, `ORDERS 1200/min` (Binance-style; per-endpoint weights not published). Public WS returns `429 Rate limit exceeded`; L3 has a per-IP limit.
- **Testnet:** `https://api-v2-testnet.strikefinance.org` is live (ping and `BTC-USD` ticker responded). How to obtain testnet funds or register a testnet API wallet is not documented.

## 5. Data for backtesting

- **Strike OHLCV exists**: `GET https://api.strikefinance.org/price/v2/klines?symbol=BTC-USD&interval=1h&priceType=index&limit=1500` (paginate with `startTime`/`endTime` ms). Live history starts **2026-03-20** for 1h and 1d (≈5.5 months). `last`-price candles are **gap-filled** (previous close, zero volume) because volume is thin; `mark`/`index` series are smoother and match what liquidations/funding use. Public stats: `GET https://api.strikefinance.org/stat/v1/stats/coin/history/funding?symbol=BTC-USD`, `…/history/open-interest`, `…/history/long-short-ratio` ([coin-history](https://docs.strikefinance.org/api/platform-stats/coin-history.md)).
- **Oracle:** Strike's own index = filtered weighted average of external spot venues, not a Cardano on-chain oracle.
- **External 1h BTC source for longer backtests:** Coinbase Exchange `GET https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=&end=` (reachable from this environment; 300 candles/request). Binance (`/fapi/v1/klines` BTCUSDT 1h — identical array layout to Strike's) and Bybit are alternatives but were geo-blocked from the probe location.

## 6. Not available / unclear (open questions)

1. **Testnet onboarding**: no documented faucet, testnet web app URL, or way to register an API wallet against the testnet API.
2. **Order ID on placement**: `POST /v2/order` returns only `client_order_id`/`sequence_id`; whether a rejection is returned synchronously as 400 or only asynchronously via `ORDER_TRADE_UPDATE` is not stated — always set `client_order_id` and consume the user stream.
3. **Per-endpoint rate-limit weights** and whether limits are per API wallet, per account, or per IP.
4. **Editing bracket legs**: whether `POST /v2/order/replace` on a TP/SL leg preserves the OCO linkage is not documented.
5. **`/v2/markets` and `/v2/markets/{symbol}`** are live but absent from the OpenAPI specs; stability not guaranteed.
6. **`quoteAsset`/`marginAsset` = `USDT`** in the API vs. "USD" balances and USDM in the Cardano exchanger docs — the exact stablecoin held for Cardano deposits and any depeg handling is unclear.
7. **Historical depth**: BTC-USD klines begin 2026-03-20; `/v2/history/*` capped at 1000 rows per call.
8. **V1 Cardano API** pages now 404; everything above is V2.
9. **JWT auth for bots**: `BearerAuth` exists but no programmatic login flow is documented outside the Builder Codes handshake.
10. **Fee-tier discrepancy**: OpenAPI example shows positive maker fees (0.02%), docs page and live `/v2/fee-tiers` show maker rebates (−0.005%); trust the live endpoint.
11. **User WS host**: docs list both `api.strikefinance.org` and `api-v2.strikefinance.org`.
