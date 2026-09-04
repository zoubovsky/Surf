# @surf/strike

Strike Finance V2 client: Ed25519 API-wallet signing, typed REST, reconnecting WebSockets, position
maths, and mappers onto the core `AccountSnapshot` / `MarketSnapshot` contracts. Prices and sizes are
parsed to numbers at the boundary; outgoing sizes/prices may be numbers and are formatted to the
symbol's step/tick (`0.00001` / `0.1` for BTC-USD) before sending.

## REST — `new StrikeRestClient({ credentials?, baseUrl?, fetch?, clock?, nonce?, logger?, retry? })`

Public (retried on 5xx/network): `exchangeInfo()`, `premiumIndex(sym)` (mark, index, hourly `fundingRate`,
`nextFundingTime`), `markPrice(sym)`, `bookTicker(sym)`, `depth(sym, limit)` (`lastUpdateId` is a `bigint`),
`klines({symbol, interval: "1h"|"4h"|"1d", priceType?, startTime?, endTime?, limit?})` -> core `Candle[]`
(venue `"strike"`; last row may be the open bar), `klinesRaw(...)` for any interval, `openInterest(sym)`,
`market(sym)` (semi-official `/v2/markets/{sym}`: `marginTiers`, `limitTakeBound` = 0.05, bounds, top of book),
`feeTiers()`, `symbolRules(sym)`, `ping()`, `serverTime()`.

Authenticated (need `credentials: { privateKey }`): `account()`, `balances()`, `positions(sym?)` (signed
`size`, `direction`, `liquidationPrice|null`), `openOrders(sym?)` and `getOrder({symbol, client_order_id})`
(PascalCase `Order` normalised to camelCase `StrikeOrder`), `orderHistory()`, `fillHistory()`,
`fundingHistory()`, `closedPositions()`.

Trading (never retried; 201 is an acknowledgement, not a fill — always set `client_order_id` and watch the
user stream): `createOrder(req)`, `createStrategyOrder({strategy_id, ..., tp_order?, sl_order?})` (bracket /
OTOCO), `replaceOrder({cancel, new_order})`, `cancelOrder({order_id, symbol})`, `cancelAll(sym?)`,
`setLeverage(sym, n)`, `setMarginMode(sym, "isolated"|"cross")`. Request field names are the wire names
(snake_case, per the OpenAPI spec).

Errors: `StrikeApiError { status, code?, message, body, requestId?, isRetryable, isAuthError }`,
`StrikeParseError` (2xx with unexpected shape), `StrikeNetworkError`, `StrikeConfigError`.
Check limit prices with `isWithinPriceBound(price, mark, market.limitTakeBound)` before placing.

## WebSockets (injectable `webSocketFactory`, newline-delimited multi-event frames, backoff, resubscribe)

`StrikePublicStream` — `subscribeMarkPrice(sym)`, `subscribeKline(sym, "1h")`, events `markPrice`
(`MarkPriceUpdate`), `kline` (`KlineEvent` with `closed`), `ack`, `open`, `close`, `reconnecting`, `giveUp`, `raw`.

`StrikeUserStream({ privateKey, accountId? })` — logs on with `session.logon`, subscribes `userstream`;
events `authenticated`, `subscribed`, `authError`, `orderUpdate` (`OrderTradeUpdate` with `isFill`/`isFinal`),
`accountUpdate` (balances + signed `positionAmount`), `strategyUpdate`. Auth close codes stop reconnecting.

## Signing and maths

`signRequest({method, path, body?, timestamp, nonce, privateKey})` -> headers + message (pure, testable);
`userStreamLogon({privateKey, timestampMs})`; `generateApiWallet()`; `verifyRequestSignature()`.
`calculations.ts`: `getMarginTier`, `calcUnrealizedPnl`, `calcMaintenanceMargin`, `calcMarginRatio`,
`calcLiquidationPriceIsolated/Cross`, `calcPositionSummary`, `estimateFunding`, `BTC_USD_MARGIN_TIERS`.
`mappers.ts`: `toAccountSnapshot(account, positions, {openOrders})`,
`toMarketSnapshot({premiumIndex, bookTicker, depth, referencePrice, lastCandleCloseTime, direction?})`.

Tests: `pnpm exec vitest run packages/strike`; live public smoke test with `STRIKE_LIVE_TESTS=1`.
