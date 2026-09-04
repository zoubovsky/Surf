---
name: strike-klines
description: Strike Finance kline/candlestick data — historical via REST, real-time via WebSocket, mark/index price klines. Use when building charts or price analysis tools.
---

# Strike Finance Klines (Candlestick Data)

Historical and real-time OHLCV candlestick data. Supports last, mark, and index price types with gap filling for chart continuity.

## REST Endpoint

**GET** `https://api.strikefinance.org/price/v2/klines`

### Query Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | e.g. `BTC-USD` |
| `interval` | string | Yes | Candle interval (see below) |
| `priceType` | string | No | `"last"` (default), `"mark"`, or `"index"` |
| `limit` | number | No | Max bars to return (max 5000) |
| `startTime` | number | No | Start time in milliseconds |
| `endTime` | number | No | End time in milliseconds |

### Supported Intervals

`1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`

### Response

Array of OHLCV bar objects:

```typescript
interface KlineBar {
  open_time: number;  // bar open time (ms)
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
```

### Example Request

```
GET https://api.strikefinance.org/price/v2/klines?symbol=BTC-USD&interval=15m&limit=500&priceType=last
```

## WebSocket (Last Price Klines)

**URL:** `wss://api.strikefinance.org/ws/price`

Only **last price** klines are available via the WebSocket kline channel. Mark and index price klines must be constructed client-side (see below).

### Subscribe

```json
{"id": 1713960000000, "method": "subscribe", "channel": "kline_15m", "symbol": "ada-usd"}
```

Channel format: `kline_{interval}` (e.g. `kline_1m`, `kline_1h`, `kline_1d`).

**Symbol must be lowercase** in subscribe/unsubscribe messages.

### Unsubscribe

```json
{"id": 1713960000000, "method": "unsubscribe", "channel": "kline_15m", "symbol": "ada-usd"}
```

### Event Format

```typescript
interface KlineEvent {
  e: "kline";
  k: {
    s: string;  // symbol, e.g. "ADAUSD" (no hyphen)
    i: string;  // interval, e.g. "15m"
    t: number;  // bar open time (ms)
    o: string;  // open
    h: string;  // high
    l: string;  // low
    c: string;  // close
    v: string;  // volume
  };
}
```

## Mark/Index Price Klines

Mark and index klines are **NOT** available via separate WS kline channels. Construct them client-side from `markPriceUpdate` events.

### markPriceUpdate Event

```typescript
interface MarkPriceUpdateEvent {
  e: "markPriceUpdate";
  s: string;   // symbol, e.g. "BTC-USD"
  p: string;   // mark price, e.g. "45000"
  i: string;   // index price, e.g. "44990"
}
```

### Construction Algorithm

For each `markPriceUpdate`:

1. Extract the relevant price (`p` for mark, `i` for index).
2. Calculate the aligned bar open time for the current interval.
3. If the bar open time matches the current bar: update `high`, `low`, and `close`.
4. If the bar open time is newer: finalize the current bar, fill gaps, start a new bar.

```typescript
function alignBarTime(timestampMs: number, intervalMs: number): number {
  return Math.floor(timestampMs / intervalMs) * intervalMs;
}

function updateBar(bar: KlineBar, price: string): void {
  const p = parseFloat(price);
  if (p > parseFloat(bar.high)) bar.high = price;
  if (p < parseFloat(bar.low)) bar.low = price;
  bar.close = price;
}

function createBar(openTime: number, price: string): KlineBar {
  return {
    open_time: openTime,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: "0",
  };
}
```

## Gap Filling

When a new bar arrives and there is a time gap since the last known bar, create synthetic bars to maintain chart continuity:

```typescript
function fillGaps(
  lastBar: KlineBar,
  newBarTime: number,
  intervalMs: number
): KlineBar[] {
  const gaps: KlineBar[] = [];
  let gapTime = lastBar.open_time + intervalMs;

  while (gapTime < newBarTime) {
    gaps.push({
      open_time: gapTime,
      open: lastBar.close,
      high: lastBar.close,
      low: lastBar.close,
      close: lastBar.close,
      volume: "0",
    });
    gapTime += intervalMs;
  }

  return gaps;
}
```

- Synthetic bars use the previous bar's close for all OHLC values.
- Volume is `"0"` for synthetic bars.
- This handles periods with no trading activity.

## TradingView Integration Pattern

Full datafeed implementation for TradingView charting library:

```typescript
const INTERVAL_MAP: Record<string, { api: string; ms: number }> = {
  "1":    { api: "1m",  ms: 60_000 },
  "3":    { api: "3m",  ms: 180_000 },
  "5":    { api: "5m",  ms: 300_000 },
  "15":   { api: "15m", ms: 900_000 },
  "30":   { api: "30m", ms: 1_800_000 },
  "60":   { api: "1h",  ms: 3_600_000 },
  "120":  { api: "2h",  ms: 7_200_000 },
  "240":  { api: "4h",  ms: 14_400_000 },
  "360":  { api: "6h",  ms: 21_600_000 },
  "480":  { api: "8h",  ms: 28_800_000 },
  "720":  { api: "12h", ms: 43_200_000 },
  "1D":   { api: "1d",  ms: 86_400_000 },
  "3D":   { api: "3d",  ms: 259_200_000 },
  "1W":   { api: "1w",  ms: 604_800_000 },
  "1M":   { api: "1M",  ms: 2_592_000_000 },
};

type BarCallback = (bar: TradingViewBar) => void;

interface TradingViewBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

class StrikeDatafeed {
  private ws: WebSocket | null = null;
  private barCallback: BarCallback | null = null;
  private currentBar: TradingViewBar | null = null;
  private currentResolution: string = "";
  private currentSymbol: string = "";
  private priceType: "last" | "mark" | "index" = "last";

  // Step 1: onReady
  onReady(callback: (config: any) => void): void {
    setTimeout(() => {
      callback({
        supported_resolutions: Object.keys(INTERVAL_MAP),
        supports_time: true,
        supports_marks: false,
        supports_timescale_marks: false,
      });
    }, 0);
  }

  // Step 2: resolveSymbol
  resolveSymbol(
    symbolName: string,
    onResolve: (info: any) => void,
    onError: (reason: string) => void
  ): void {
    setTimeout(() => {
      onResolve({
        name: symbolName,
        full_name: symbolName,
        description: symbolName,
        type: "crypto",
        session: "24x7",
        timezone: "Etc/UTC",
        exchange: "Strike",
        listed_exchange: "Strike",
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: Object.keys(INTERVAL_MAP),
        pricescale: 100,
        minmov: 1,
        volume_precision: 2,
      });
    }, 0);
  }

  // Step 3: getBars
  async getBars(
    symbolInfo: any,
    resolution: string,
    periodParams: { from: number; to: number; firstDataRequest: boolean },
    onResult: (bars: TradingViewBar[], meta: { noData: boolean }) => void,
    onError: (reason: string) => void
  ): Promise<void> {
    const interval = INTERVAL_MAP[resolution];
    if (!interval) {
      onError(`Unsupported resolution: ${resolution}`);
      return;
    }

    try {
      const params = new URLSearchParams({
        symbol: symbolInfo.name,
        interval: interval.api,
        startTime: String(periodParams.from * 1000),
        endTime: String(periodParams.to * 1000),
        limit: "5000",
      });
      if (this.priceType !== "last") {
        params.set("priceType", this.priceType);
      }

      const res = await fetch(
        `https://api.strikefinance.org/price/v2/klines?${params}`
      );
      const klines: KlineBar[] = await res.json();

      if (!klines || klines.length === 0) {
        onResult([], { noData: true });
        return;
      }

      const bars: TradingViewBar[] = klines.map((k) => ({
        time: k.open_time,
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
      }));

      // Cache the last bar for real-time updates
      if (periodParams.firstDataRequest) {
        this.currentBar = bars[bars.length - 1];
      }

      onResult(bars, { noData: false });
    } catch (err) {
      onError(String(err));
    }
  }

  // Step 4: subscribeBars
  subscribeBars(
    symbolInfo: any,
    resolution: string,
    onTick: BarCallback
  ): void {
    this.barCallback = onTick;
    this.currentResolution = resolution;
    this.currentSymbol = symbolInfo.name;

    const interval = INTERVAL_MAP[resolution];
    if (!interval) return;

    if (this.priceType === "last") {
      this.subscribeLastPriceKlines(interval.api);
    } else {
      this.subscribeMarkPriceUpdates(interval.ms);
    }
  }

  private subscribeLastPriceKlines(apiInterval: string): void {
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({
        id: Date.now(),
        method: "subscribe",
        channel: `kline_${apiInterval}`,
        symbol: this.currentSymbol.toLowerCase(),
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.e !== "kline") return;

      const k = data.k;
      const bar: TradingViewBar = {
        time: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
      };

      // Step 5: Fill gaps then call callback
      if (this.currentBar) {
        const interval = INTERVAL_MAP[this.currentResolution];
        if (interval && bar.time > this.currentBar.time + interval.ms) {
          // Fill gap bars
          const gaps = fillGaps(
            {
              open_time: this.currentBar.time,
              open: String(this.currentBar.open),
              high: String(this.currentBar.high),
              low: String(this.currentBar.low),
              close: String(this.currentBar.close),
              volume: String(this.currentBar.volume),
            },
            bar.time,
            interval.ms
          );
          for (const gap of gaps) {
            this.barCallback?.({
              time: gap.open_time,
              open: parseFloat(gap.open),
              high: parseFloat(gap.high),
              low: parseFloat(gap.low),
              close: parseFloat(gap.close),
              volume: parseFloat(gap.volume),
            });
          }
        }
      }

      this.currentBar = bar;
      this.barCallback?.(bar);
    };
  }

  private subscribeMarkPriceUpdates(intervalMs: number): void {
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({
        id: Date.now(),
        method: "subscribe",
        channel: "markPrice",
        symbol: this.currentSymbol.toLowerCase(),
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.e !== "markPriceUpdate") return;

      // Use mark or index price depending on priceType
      const price = this.priceType === "mark" ? data.p : data.i;
      const now = Date.now();
      const barTime = alignBarTime(now, intervalMs);

      if (this.currentBar && this.currentBar.time === barTime) {
        // Same bar — update high/low/close
        const p = parseFloat(price);
        if (p > this.currentBar.high) this.currentBar.high = p;
        if (p < this.currentBar.low) this.currentBar.low = p;
        this.currentBar.close = p;
      } else {
        // New bar — fill gaps and create
        if (this.currentBar) {
          const gaps = fillGaps(
            {
              open_time: this.currentBar.time,
              open: String(this.currentBar.open),
              high: String(this.currentBar.high),
              low: String(this.currentBar.low),
              close: String(this.currentBar.close),
              volume: String(this.currentBar.volume),
            },
            barTime,
            intervalMs
          );
          for (const gap of gaps) {
            this.barCallback?.({
              time: gap.open_time,
              open: parseFloat(gap.open),
              high: parseFloat(gap.high),
              low: parseFloat(gap.low),
              close: parseFloat(gap.close),
              volume: 0,
            });
          }
        }

        this.currentBar = {
          time: barTime,
          open: parseFloat(price),
          high: parseFloat(price),
          low: parseFloat(price),
          close: parseFloat(price),
          volume: 0,
        };
      }

      this.barCallback?.({ ...this.currentBar });
    };
  }

  unsubscribeBars(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.barCallback = null;
  }

  setPriceType(priceType: "last" | "mark" | "index"): void {
    this.priceType = priceType;
  }
}
```

### Usage

```typescript
const datafeed = new StrikeDatafeed();

// Use with TradingView widget
const widget = new TradingView.widget({
  datafeed: datafeed,
  symbol: "BTC-USD",
  interval: "15",
  container: "chart_container",
  library_path: "/charting_library/",
  timezone: "Etc/UTC",
});

// Switch to mark price klines
datafeed.setPriceType("mark");
// Then trigger TradingView to reload data (e.g. via resetData())

// Cleanup
datafeed.unsubscribeBars();
```

### Fetching Historical Data Directly

```typescript
async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  priceType: "last" | "mark" | "index" = "last"
): Promise<KlineBar[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
    priceType,
  });

  const res = await fetch(
    `https://api.strikefinance.org/price/v2/klines?${params}`
  );
  return res.json();
}

// Fetch last 500 15-minute mark price candles for BTC
const bars = await fetchKlines("BTC-USD", "15m", 500, "mark");
console.log("Latest bar:", bars[bars.length - 1]);
```
