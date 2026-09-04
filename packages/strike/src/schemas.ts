/**
 * Zod schemas for Strike V2 wire shapes and the parsed (camelCase, numeric) types the rest of the
 * system consumes. Field names on the wire follow the vendored OpenAPI specs, cross-checked against
 * live mainnet responses (2026-09-04). Where the spec and the live API disagree, both are accepted.
 */
import { z } from "zod";
import type { Direction } from "@surf/core";
import { decimalsFromStep } from "./precision.js";

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Decimal string (or number) -> finite number. */
export const dec = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v.trim());
  if (v === "" || !Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: `not a finite decimal: ${JSON.stringify(v)}` });
    return z.NEVER;
  }
  return n;
});

/** Decimal that may be missing, null or empty; empty/null/missing -> null. */
export const decOrNull = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v.trim());
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: `not a finite decimal: ${JSON.stringify(v)}` });
      return z.NEVER;
    }
    return n;
  });

export const int = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) {
    ctx.addIssue({ code: "custom", message: `not an integer: ${JSON.stringify(v)}` });
    return z.NEVER;
  }
  return n;
});

export const bigId = z.union([z.bigint(), z.number(), z.string()]).transform((v, ctx) => {
  try {
    return BigInt(v);
  } catch {
    ctx.addIssue({ code: "custom", message: `not an integer id: ${JSON.stringify(v)}` });
    return z.NEVER;
  }
});

const optStr = z.string().optional();
const nullableStr = z.string().nullable().optional();

export const OrderSide = z.enum(["buy", "sell"]);
export type OrderSide = z.infer<typeof OrderSide>;

export const OrderType = z.enum([
  "limit",
  "market",
  "stop",
  "stop_limit",
  "take_profit",
  "take_profit_limit",
  "trailing_stop_market",
]);
export type OrderType = z.infer<typeof OrderType>;

export const StrategyLegType = z.enum(["take_profit", "take_profit_limit", "stop", "stop_limit"]);
export type StrategyLegType = z.infer<typeof StrategyLegType>;

export const OrderStatus = z.enum([
  "pending",
  "open",
  "filled",
  "canceled",
  "untriggered",
  "rejected",
  "expired",
  "none",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const TimeInForce = z.enum(["GTC", "IOC", "FOK"]);
export type TimeInForce = z.infer<typeof TimeInForce>;

export const WorkingType = z.enum(["mark_price", "contract_price"]);
export type WorkingType = z.infer<typeof WorkingType>;

export const MarginMode = z.enum(["cross", "isolated"]);
export type MarginMode = z.infer<typeof MarginMode>;

export const PriceType = z.enum(["last", "mark", "index"]);
export type PriceType = z.infer<typeof PriceType>;

export const KlineInterval = z.enum([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
]);
export type KlineInterval = z.infer<typeof KlineInterval>;

export const KLINE_INTERVAL_MS: Record<KlineInterval, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

/** Sign of a signed position size -> direction; zero -> null. */
export function directionFromSize(size: number): Direction | null {
  if (size > 0) return "long";
  if (size < 0) return "short";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Market data (public, base /price)
// ---------------------------------------------------------------------------------------------

export interface PremiumIndex {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  /** Funding rate for the next hourly settlement (fraction per hour, e.g. 0.0000118 = 0.00118%/h). */
  fundingRate: number;
  nextFundingTime: number;
  interestRate: number | null;
  latestPremiumIndex: number | null;
  averagePremiumIndex: number | null;
  estimatedSettlePrice: number | null;
  time: number;
}

export const PremiumIndexSchema: z.ZodType<PremiumIndex, unknown> = z
  .looseObject({
    symbol: z.string(),
    markPrice: dec,
    indexPrice: dec,
    // Live API uses `fundingRate`; the OpenAPI spec says `lastFundingRate`. Accept both.
    fundingRate: decOrNull,
    lastFundingRate: decOrNull,
    nextFundingTime: int,
    interestRate: decOrNull,
    latestPremiumIndex: decOrNull,
    averagePremiumIndex: decOrNull,
    estimatedSettlePrice: decOrNull,
    time: int,
  })
  .transform((r, ctx) => {
    const fundingRate = r.fundingRate ?? r.lastFundingRate;
    if (fundingRate === null) {
      ctx.addIssue({ code: "custom", message: "missing fundingRate/lastFundingRate" });
      return z.NEVER;
    }
    return {
      symbol: r.symbol,
      markPrice: r.markPrice,
      indexPrice: r.indexPrice,
      fundingRate,
      nextFundingTime: r.nextFundingTime,
      interestRate: r.interestRate,
      latestPremiumIndex: r.latestPremiumIndex,
      averagePremiumIndex: r.averagePremiumIndex,
      estimatedSettlePrice: r.estimatedSettlePrice,
      time: r.time,
    };
  });

/** Shared by REST `/v2/markPrice` and the WS `markPriceUpdate` event. */
export interface MarkPriceUpdate {
  eventTime: number;
  symbol: string;
  markPrice: number;
  indexPrice: number;
  settlePrice: number | null;
  fundingRate: number;
  nextFundingTime: number;
}

export const MarkPriceUpdateSchema: z.ZodType<MarkPriceUpdate, unknown> = z
  .looseObject({
    e: z.literal("markPriceUpdate").optional(),
    E: int,
    s: z.string(),
    p: dec,
    i: dec,
    P: decOrNull,
    r: dec,
    T: int,
  })
  .transform((r) => ({
    eventTime: r.E,
    symbol: r.s,
    markPrice: r.p,
    indexPrice: r.i,
    settlePrice: r.P,
    fundingRate: r.r,
    nextFundingTime: r.T,
  }));

export interface BookTicker {
  symbol: string;
  bidPrice: number | null;
  bidQty: number | null;
  askPrice: number | null;
  askQty: number | null;
  time: number;
}

export const BookTickerSchema: z.ZodType<BookTicker, unknown> = z
  .looseObject({
    symbol: z.string(),
    bidPrice: decOrNull,
    bidQty: decOrNull,
    askPrice: decOrNull,
    askQty: decOrNull,
    time: int,
  })
  .transform((r) => {
    const nz = (v: number | null): number | null => (v !== null && v > 0 ? v : null);
    return {
      symbol: r.symbol,
      bidPrice: nz(r.bidPrice),
      bidQty: nz(r.bidQty),
      askPrice: nz(r.askPrice),
      askQty: nz(r.askQty),
      time: r.time,
    };
  });

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface Depth {
  /** Engine sequence id; can exceed Number.MAX_SAFE_INTEGER. */
  lastUpdateId: bigint;
  eventTime: number;
  transactionTime: number;
  /** Best (highest) first. */
  bids: DepthLevel[];
  /** Best (lowest) first. */
  asks: DepthLevel[];
}

const LevelsSchema = z.array(z.array(z.union([z.string(), z.number()])).min(2)).transform((levels, ctx) =>
  levels.map((l, idx): DepthLevel => {
    const price = Number(l[0]);
    const qty = Number(l[1]);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) {
      ctx.addIssue({ code: "custom", message: `bad depth level at ${idx}: ${JSON.stringify(l)}` });
      return { price: 0, qty: 0 };
    }
    return { price, qty };
  }),
);

export const DepthSchema: z.ZodType<Depth, unknown> = z
  .looseObject({
    lastUpdateId: bigId,
    E: int.optional(),
    T: int.optional(),
    bids: LevelsSchema,
    asks: LevelsSchema,
  })
  .transform((r) => ({
    lastUpdateId: r.lastUpdateId,
    eventTime: r.E ?? r.T ?? 0,
    transactionTime: r.T ?? r.E ?? 0,
    bids: r.bids,
    asks: r.asks,
  }));

/**
 * Preserve the uint64 `lastUpdateId` before JSON.parse truncates it. The venue does not quote it.
 */
export function quoteBigIds(text: string, keys: readonly string[] = ["lastUpdateId", "U", "u"]): string {
  let out = text;
  for (const k of keys) {
    out = out.replace(new RegExp(`"${k}"\\s*:\\s*(-?\\d{16,})`, "g"), `"${k}":"$1"`);
  }
  return out;
}

export interface StrikeKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  takerBuyBase: number;
  takerBuyQuote: number;
}

/** Binance-style 12-element kline array. */
export const KlineRowSchema: z.ZodType<StrikeKline, unknown> = z
  .array(z.unknown())
  .min(6)
  .transform((row, ctx) => {
    const num = (i: number, required: boolean): number => {
      const v = row[i];
      if (v === undefined || v === null || v === "") {
        if (required) ctx.addIssue({ code: "custom", message: `kline field ${i} missing` });
        return 0;
      }
      const n = Number(v);
      if (!Number.isFinite(n))
        ctx.addIssue({ code: "custom", message: `kline field ${i} not numeric: ${String(v)}` });
      return n;
    };
    return {
      openTime: num(0, true),
      open: num(1, true),
      high: num(2, true),
      low: num(3, true),
      close: num(4, true),
      volume: num(5, true),
      closeTime: num(6, false),
      quoteVolume: num(7, false),
      trades: num(8, false),
      takerBuyBase: num(9, false),
      takerBuyQuote: num(10, false),
    };
  });

export const KlinesSchema = z.array(KlineRowSchema);

export interface OpenInterest {
  symbol: string;
  /** Base-asset units (BTC). */
  openInterest: number;
  time: number;
}

export const OpenInterestSchema: z.ZodType<OpenInterest, unknown> = z
  .looseObject({ symbol: z.string(), openInterest: dec, time: int })
  .transform((r) => ({ symbol: r.symbol, openInterest: r.openInterest, time: r.time }));

/** Trading rules for one symbol, distilled from exchangeInfo filters (numbers, plus decimals). */
export interface SymbolRules {
  symbol: string;
  tickSize: number;
  priceDecimals: number;
  minPrice: number | null;
  maxPrice: number | null;
  stepSize: number;
  sizeDecimals: number;
  minQty: number | null;
  maxQty: number | null;
  marketStepSize: number | null;
  marketMinQty: number | null;
  marketMaxQty: number | null;
  minNotional: number | null;
  /** Limit orders further than this fraction from mark are rejected (0.05 = 5%). */
  limitTakeBound: number | null;
  marketTakeBound: number | null;
}

export interface SymbolInfo {
  symbol: string;
  pair: string;
  contractType: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  triggerProtect: number | null;
  liquidationFee: number | null;
  limitTakeBound: number | null;
  marketTakeBound: number | null;
  orderTypes: string[];
  timeInForce: string[];
  rules: SymbolRules;
}

export interface RateLimit {
  rateLimitType: string;
  interval: string;
  intervalNum: number;
  limit: number;
}

export interface ExchangeInfo {
  timezone: string;
  serverTime: number;
  rateLimits: RateLimit[];
  symbols: SymbolInfo[];
}

const FilterSchema = z.looseObject({
  filterType: z.string(),
  maxPrice: decOrNull,
  minPrice: decOrNull,
  tickSize: decOrNull,
  maxQty: decOrNull,
  minQty: decOrNull,
  stepSize: decOrNull,
  notional: decOrNull,
});

function decimalsOf(step: number): number {
  return step > 0 ? decimalsFromStep(step) : 0;
}

const SymbolInfoSchema: z.ZodType<SymbolInfo, unknown> = z
  .looseObject({
    symbol: z.string(),
    pair: optStr,
    contractType: optStr,
    status: optStr,
    baseAsset: optStr,
    quoteAsset: optStr,
    marginAsset: optStr,
    pricePrecision: int.optional(),
    quantityPrecision: int.optional(),
    triggerProtect: decOrNull,
    liquidationFee: decOrNull,
    limitTakeBound: decOrNull,
    marketTakeBound: decOrNull,
    filters: z.array(FilterSchema).default([]),
    orderType: z.array(z.string()).optional(),
    timeInForce: z.array(z.string()).optional(),
  })
  .transform((r, ctx) => {
    const byType = new Map(r.filters.map((f) => [f.filterType, f] as const));
    const price = byType.get("PRICE_FILTER");
    const lot = byType.get("LOT_SIZE");
    const mlot = byType.get("MARKET_LOT_SIZE");
    const notional = byType.get("MIN_NOTIONAL");
    const tickSize = price?.tickSize ?? null;
    const stepSize = lot?.stepSize ?? null;
    if (tickSize === null || stepSize === null) {
      ctx.addIssue({ code: "custom", message: `symbol ${r.symbol} lacks PRICE_FILTER/LOT_SIZE` });
      return z.NEVER;
    }
    const rules: SymbolRules = {
      symbol: r.symbol,
      tickSize,
      priceDecimals: decimalsOf(tickSize),
      minPrice: price?.minPrice ?? null,
      maxPrice: price?.maxPrice ?? null,
      stepSize,
      sizeDecimals: decimalsOf(stepSize),
      minQty: lot?.minQty ?? null,
      maxQty: lot?.maxQty ?? null,
      marketStepSize: mlot?.stepSize ?? null,
      marketMinQty: mlot?.minQty ?? null,
      marketMaxQty: mlot?.maxQty ?? null,
      minNotional: notional?.notional ?? null,
      limitTakeBound: r.limitTakeBound,
      marketTakeBound: r.marketTakeBound,
    };
    return {
      symbol: r.symbol,
      pair: r.pair ?? r.symbol,
      contractType: r.contractType ?? "",
      status: r.status ?? "",
      baseAsset: r.baseAsset ?? "",
      quoteAsset: r.quoteAsset ?? "",
      marginAsset: r.marginAsset ?? "",
      pricePrecision: r.pricePrecision ?? rules.priceDecimals,
      quantityPrecision: r.quantityPrecision ?? rules.sizeDecimals,
      triggerProtect: r.triggerProtect,
      liquidationFee: r.liquidationFee,
      limitTakeBound: r.limitTakeBound,
      marketTakeBound: r.marketTakeBound,
      orderTypes: r.orderType ?? [],
      timeInForce: r.timeInForce ?? [],
      rules,
    };
  });

export const ExchangeInfoSchema: z.ZodType<ExchangeInfo, unknown> = z
  .looseObject({
    timezone: optStr,
    serverTime: int.optional(),
    rateLimits: z
      .array(z.looseObject({ rateLimitType: z.string(), interval: z.string(), intervalNum: int, limit: int }))
      .default([]),
    symbols: z.array(SymbolInfoSchema),
  })
  .transform((r) => ({
    timezone: r.timezone ?? "UTC",
    serverTime: r.serverTime ?? 0,
    rateLimits: r.rateLimits.map((l) => ({
      rateLimitType: l.rateLimitType,
      interval: l.interval,
      intervalNum: l.intervalNum,
      limit: l.limit,
    })),
    symbols: r.symbols,
  }));

// ---------------------------------------------------------------------------------------------
// Semi-official /v2/markets/{symbol} (not in the OpenAPI specs; used by the builder reference app)
// ---------------------------------------------------------------------------------------------

export interface MarginTier {
  maxNotional: number;
  maxLeverage: number;
  maintenanceMarginRate: number;
  maintenanceAmount: number;
}

export const MarginTierSchema: z.ZodType<MarginTier, unknown> = z
  .looseObject({
    max_notional: dec,
    max_leverage: dec,
    maintenance_margin_rate: dec,
    maintenance_amount: dec,
  })
  .transform((t) => ({
    maxNotional: t.max_notional,
    maxLeverage: t.max_leverage,
    maintenanceMarginRate: t.maintenance_margin_rate,
    maintenanceAmount: t.maintenance_amount,
  }));

export interface StrikeMarket {
  symbol: string;
  name: string;
  baseAsset: string;
  status: string;
  defaultLeverage: number;
  marginTiers: MarginTier[];
  reduceOnly: boolean;
  tickSize: number;
  minPrice: number | null;
  maxPrice: number | null;
  /** Limit orders beyond this fraction of mark are rejected (live BTC-USD: 0.05). */
  limitTakeBound: number;
  marketTakeBound: number;
  stepSize: number;
  minSize: number | null;
  maxLimitSize: number | null;
  marketStepSize: number | null;
  marketMinSize: number | null;
  maxMarketSize: number | null;
  minNotional: number | null;
  liquidationFeeRate: number | null;
  liquidationFeeRetentionFactor: number | null;
  triggerProtect: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  lastPrice: number | null;
  bestBid: number | null;
  bestBidSize: number | null;
  bestAsk: number | null;
  bestAskSize: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  impactNotional: number | null;
  rules: SymbolRules;
}

export const StrikeMarketSchema: z.ZodType<StrikeMarket, unknown> = z
  .looseObject({
    symbol: z.string(),
    name: optStr,
    base_asset: optStr,
    status: optStr,
    default_leverage: int.optional(),
    margin_tiers: z.array(MarginTierSchema).default([]),
    reduce_only: z.boolean().optional(),
    order_tick_price: dec,
    order_min_price: decOrNull,
    order_max_price: decOrNull,
    order_limit_price_bound: dec,
    order_market_price_bound: decOrNull,
    order_limit_step_size: dec,
    order_limit_min_size: decOrNull,
    order_limit_max_size: decOrNull,
    order_market_step_size: decOrNull,
    order_market_min_size: decOrNull,
    order_market_max_size: decOrNull,
    order_min_notional: decOrNull,
    liquidation_fee_rate: decOrNull,
    liquidation_fee_retention_factor: decOrNull,
    trigger_protect: decOrNull,
    mark_price: decOrNull,
    index_price: decOrNull,
    last_price: decOrNull,
    bid1_price: decOrNull,
    bid1_size: decOrNull,
    ask1_price: decOrNull,
    ask1_size: decOrNull,
    funding_rate: decOrNull,
    next_funding_time: int.nullable().optional(),
    impact_notional: decOrNull,
  })
  .transform((r) => {
    const rules: SymbolRules = {
      symbol: r.symbol,
      tickSize: r.order_tick_price,
      priceDecimals: decimalsOf(r.order_tick_price),
      minPrice: r.order_min_price,
      maxPrice: r.order_max_price,
      stepSize: r.order_limit_step_size,
      sizeDecimals: decimalsOf(r.order_limit_step_size),
      minQty: r.order_limit_min_size,
      maxQty: r.order_limit_max_size,
      marketStepSize: r.order_market_step_size,
      marketMinQty: r.order_market_min_size,
      marketMaxQty: r.order_market_max_size,
      minNotional: r.order_min_notional,
      limitTakeBound: r.order_limit_price_bound,
      marketTakeBound: r.order_market_price_bound,
    };
    return {
      symbol: r.symbol,
      name: r.name ?? r.symbol,
      baseAsset: r.base_asset ?? "",
      status: r.status ?? "",
      defaultLeverage: r.default_leverage ?? 0,
      marginTiers: [...r.margin_tiers].sort((a, b) => a.maxNotional - b.maxNotional),
      reduceOnly: r.reduce_only ?? false,
      tickSize: r.order_tick_price,
      minPrice: r.order_min_price,
      maxPrice: r.order_max_price,
      limitTakeBound: r.order_limit_price_bound,
      marketTakeBound: r.order_market_price_bound ?? r.order_limit_price_bound,
      stepSize: r.order_limit_step_size,
      minSize: r.order_limit_min_size,
      maxLimitSize: r.order_limit_max_size,
      marketStepSize: r.order_market_step_size,
      marketMinSize: r.order_market_min_size,
      maxMarketSize: r.order_market_max_size,
      minNotional: r.order_min_notional,
      liquidationFeeRate: r.liquidation_fee_rate,
      liquidationFeeRetentionFactor: r.liquidation_fee_retention_factor,
      triggerProtect: r.trigger_protect,
      markPrice: r.mark_price,
      indexPrice: r.index_price,
      lastPrice: r.last_price,
      bestBid: r.bid1_price,
      bestBidSize: r.bid1_size,
      bestAsk: r.ask1_price,
      bestAskSize: r.ask1_size,
      fundingRate: r.funding_rate,
      nextFundingTime: r.next_funding_time ?? null,
      impactNotional: r.impact_notional,
      rules,
    };
  });

// ---------------------------------------------------------------------------------------------
// Fee tiers (common API). Live serialises the base tiers PascalCase; the spec says camelCase.
// ---------------------------------------------------------------------------------------------

export interface FeeTier {
  tier: number;
  minVolume: number;
  takerRate: number;
  /** Negative = rebate. */
  makerRate: number;
}

export interface FeeTiers {
  feeTiers: FeeTier[];
  makerRebateTiers: { tier: number; minMakerVolumeShare: number; makerRate: number }[];
  stakingFeeDiscountTiers: { tier: number; minStakedStrike: number; discountRate: number }[];
}

const FeeTierSchema: z.ZodType<FeeTier, unknown> = z
  .looseObject({
    tier: int.optional(),
    Tier: int.optional(),
    minVolume: decOrNull,
    MinVolume: decOrNull,
    takerRate: decOrNull,
    TakerRate: decOrNull,
    makerRate: decOrNull,
    MakerRate: decOrNull,
  })
  .transform((r, ctx) => {
    const tier = r.tier ?? r.Tier;
    const minVolume = r.minVolume ?? r.MinVolume;
    const takerRate = r.takerRate ?? r.TakerRate;
    const makerRate = r.makerRate ?? r.MakerRate;
    if (tier === undefined || minVolume === null || takerRate === null || makerRate === null) {
      ctx.addIssue({ code: "custom", message: "fee tier missing fields" });
      return z.NEVER;
    }
    return { tier, minVolume, takerRate, makerRate };
  });

export const FeeTiersSchema: z.ZodType<FeeTiers, unknown> = z
  .looseObject({
    feeTiers: z.array(FeeTierSchema),
    makerRebateTiers: z
      .array(z.looseObject({ tier: int, minMakerVolumeShare: dec, makerRate: dec }))
      .default([]),
    stakingFeeDiscountTiers: z
      .array(z.looseObject({ tier: int, minStakedStrike: dec, discountRate: dec }))
      .default([]),
  })
  .transform((r) => ({
    feeTiers: r.feeTiers,
    makerRebateTiers: r.makerRebateTiers.map((t) => ({
      tier: t.tier,
      minMakerVolumeShare: t.minMakerVolumeShare,
      makerRate: t.makerRate,
    })),
    stakingFeeDiscountTiers: r.stakingFeeDiscountTiers.map((t) => ({
      tier: t.tier,
      minStakedStrike: t.minStakedStrike,
      discountRate: t.discountRate,
    })),
  }));

// ---------------------------------------------------------------------------------------------
// Account (authenticated)
// ---------------------------------------------------------------------------------------------

export interface SymbolSetting {
  marginMode: MarginMode;
  leverage: number;
  allowPreTrade: boolean;
}

export interface StrikeAccount {
  accountId: string;
  blockchain: string;
  blockchainAddress: string | null;
  walletBalance: number;
  availableBalance: number;
  copyReservedBalance: number;
  unrealizedPnl: number;
  /** walletBalance + unrealizedPnl: the equity figure. */
  marginBalance: number;
  totalMargin: number;
  positionInitialMargin: number;
  maintenanceMargin: number;
  symbolSettings: Record<string, SymbolSetting>;
  subAccounts: { accountId: string; name: string }[];
}

export const StrikeAccountSchema: z.ZodType<StrikeAccount, unknown> = z
  .looseObject({
    account_id: z.string(),
    blockchain: z.string().nullable().optional(),
    blockchain_address: z.string().nullable().optional(),
    wallet_balance: dec,
    available_balance: dec,
    copy_reserved_balance: decOrNull,
    unrealized_pnl: dec,
    margin_balance: dec,
    total_margin: dec,
    position_initial_margin: dec,
    maintenance_margin: dec,
    symbol_settings: z
      .record(
        z.string(),
        z.looseObject({ margin_mode: MarginMode, leverage: int, allow_pre_trade: z.boolean().optional() }),
      )
      .optional(),
    sub_accounts: z.array(z.looseObject({ account_id: z.string(), name: z.string().optional() })).optional(),
  })
  .transform((r) => ({
    accountId: r.account_id,
    blockchain: r.blockchain ?? "",
    blockchainAddress: r.blockchain_address ?? null,
    walletBalance: r.wallet_balance,
    availableBalance: r.available_balance,
    copyReservedBalance: r.copy_reserved_balance ?? 0,
    unrealizedPnl: r.unrealized_pnl,
    marginBalance: r.margin_balance,
    totalMargin: r.total_margin,
    positionInitialMargin: r.position_initial_margin,
    maintenanceMargin: r.maintenance_margin,
    symbolSettings: Object.fromEntries(
      Object.entries(r.symbol_settings ?? {}).map(([k, v]) => [
        k,
        { marginMode: v.margin_mode, leverage: v.leverage, allowPreTrade: v.allow_pre_trade ?? false },
      ]),
    ),
    subAccounts: (r.sub_accounts ?? []).map((s) => ({ accountId: s.account_id, name: s.name ?? "" })),
  }));

export interface StrikeBalance {
  asset: string;
  walletBalance: number;
  unrealizedPnl: number;
  marginBalance: number;
  maintMargin: number;
  initialMargin: number;
  positionInitialMargin: number;
  openOrderInitialMargin: number;
  crossWalletBalance: number;
  crossUnPnl: number;
  availableBalance: number;
  maxWithdrawAmount: number;
  marginAvailable: boolean;
  updateTime: number;
}

const StrikeBalanceSchema: z.ZodType<StrikeBalance, unknown> = z
  .looseObject({
    asset: z.string().optional(),
    walletBalance: dec,
    unrealizedPnl: dec,
    marginBalance: dec,
    maintMargin: dec,
    initialMargin: dec,
    positionInitialMargin: dec,
    openOrderInitialMargin: dec,
    crossWalletBalance: decOrNull,
    crossUnPnl: decOrNull,
    availableBalance: dec,
    maxWithdrawAmount: decOrNull,
    marginAvailable: z.boolean().optional(),
    updateTime: int.optional(),
  })
  .transform((r) => ({
    asset: r.asset ?? "USDT",
    walletBalance: r.walletBalance,
    unrealizedPnl: r.unrealizedPnl,
    marginBalance: r.marginBalance,
    maintMargin: r.maintMargin,
    initialMargin: r.initialMargin,
    positionInitialMargin: r.positionInitialMargin,
    openOrderInitialMargin: r.openOrderInitialMargin,
    crossWalletBalance: r.crossWalletBalance ?? r.walletBalance,
    crossUnPnl: r.crossUnPnl ?? r.unrealizedPnl,
    availableBalance: r.availableBalance,
    maxWithdrawAmount: r.maxWithdrawAmount ?? 0,
    marginAvailable: r.marginAvailable ?? true,
    updateTime: r.updateTime ?? 0,
  }));

/** `/v2/balances` returns an array per the spec; a bare object (skill docs) is also accepted. */
export const StrikeBalancesSchema: z.ZodType<StrikeBalance[], unknown> = z.union([
  z.array(StrikeBalanceSchema),
  StrikeBalanceSchema.transform((b) => [b]),
]);

export interface StrikePosition {
  id: number;
  symbol: string;
  marginMode: MarginMode;
  leverage: number;
  /** Signed: positive long, negative short. */
  size: number;
  direction: Direction | null;
  entryPrice: number;
  isoBalance: number;
  accumulatedFundingFees: number;
  unrealizedPnl: number;
  maintenanceMargin: number;
  bankruptcyPrice: number | null;
  /** null when the venue reports 0 (no liquidation level). */
  liquidationPrice: number | null;
  createTimestamp: number;
  updateTimestamp: number;
}

/**
 * The OpenAPI spec (and live docs) use snake_case; the vendored strike-history skill shows a
 * PascalCase variant with `Side`. Both are accepted.
 */
const PositionSchema: z.ZodType<StrikePosition, unknown> = z
  .looseObject({
    id: int.optional(),
    PositionID: int.optional(),
    symbol: optStr,
    Symbol: optStr,
    margin_mode: MarginMode.optional(),
    MarginMode: MarginMode.optional(),
    leverage: int.optional(),
    Leverage: int.optional(),
    size: decOrNull,
    Size: decOrNull,
    Side: z.string().optional(),
    entry_price: decOrNull,
    EntryPrice: decOrNull,
    iso_balance: decOrNull,
    IsolatedMargin: decOrNull,
    accumulated_funding_fees: decOrNull,
    upnl: decOrNull,
    maintenance_margin: decOrNull,
    bankruptcy_price: decOrNull,
    liquidation_price: decOrNull,
    create_timestamp: int.optional(),
    update_timestamp: int.optional(),
  })
  .transform((r, ctx) => {
    const symbol = r.symbol ?? r.Symbol;
    let size = r.size ?? r.Size;
    const entryPrice = r.entry_price ?? r.EntryPrice;
    if (
      symbol === undefined ||
      size === null ||
      size === undefined ||
      entryPrice === null ||
      entryPrice === undefined
    ) {
      ctx.addIssue({ code: "custom", message: "position missing symbol/size/entry_price" });
      return z.NEVER;
    }
    if (r.Side && r.Side.toLowerCase() === "short" && size > 0) size = -size;
    const nz = (v: number | null | undefined): number | null =>
      v !== null && v !== undefined && v > 0 ? v : null;
    return {
      id: r.id ?? r.PositionID ?? 0,
      symbol,
      marginMode: r.margin_mode ?? r.MarginMode ?? "cross",
      leverage: r.leverage ?? r.Leverage ?? 0,
      size,
      direction: directionFromSize(size),
      entryPrice,
      isoBalance: r.iso_balance ?? r.IsolatedMargin ?? 0,
      accumulatedFundingFees: r.accumulated_funding_fees ?? 0,
      unrealizedPnl: r.upnl ?? 0,
      maintenanceMargin: r.maintenance_margin ?? 0,
      bankruptcyPrice: nz(r.bankruptcy_price),
      liquidationPrice: nz(r.liquidation_price),
      createTimestamp: r.create_timestamp ?? 0,
      updateTimestamp: r.update_timestamp ?? 0,
    };
  });

export const PositionsResponseSchema: z.ZodType<StrikePosition[], unknown> = z.union([
  z.looseObject({ positions: z.array(PositionSchema) }).transform((r) => r.positions),
  z.array(PositionSchema),
]);

// ---------------------------------------------------------------------------------------------
// Orders (authenticated). Open/get-order return PascalCase `Order`; history returns snake_case.
// ---------------------------------------------------------------------------------------------

export interface StrikeOrder {
  id: number;
  clientOrderId: string;
  accountId: string;
  symbol: string;
  side: OrderSide | "none";
  status: OrderStatus;
  type: OrderType;
  originType: OrderType | null;
  autoCloseType: string | null;
  timeInForce: TimeInForce | null;
  workingType: WorkingType | "none" | null;
  size: number;
  filled: number;
  price: number;
  stopPrice: number;
  boundPrice: number | null;
  postOnly: boolean;
  reduceOnly: boolean;
  closePosition: boolean;
  priceProtect: boolean;
  strategy: { id: string; isPrimary: boolean } | null;
  trailing: {
    callbackRate: number;
    activationPrice: number | null;
    extreme: number | null;
    activated: boolean;
  } | null;
  closeReason: string;
  createTimestamp: number;
  entryTimestamp: number;
  eventTimestamp: number;
}

export const FINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "filled",
  "canceled",
  "rejected",
  "expired",
]);

export const StrikeOrderSchema: z.ZodType<StrikeOrder, unknown> = z
  .looseObject({
    ID: int,
    ClientOrderID: z.string().optional(),
    AccountID: z.string().optional(),
    Symbol: z.string(),
    Strategy: z.looseObject({ ID: z.string(), IsPrimary: z.boolean().optional() }).nullable().optional(),
    CloseReason: z.string().nullable().optional(),
    Side: z.enum(["buy", "sell", "none"]),
    Status: OrderStatus,
    Type: OrderType,
    OriginType: z
      .union([OrderType, z.literal("")])
      .nullable()
      .optional(),
    AutoCloseType: nullableStr,
    TimeInForce: z
      .union([TimeInForce, z.literal("")])
      .nullable()
      .optional(),
    WorkingType: z
      .union([WorkingType, z.literal("none"), z.literal("")])
      .nullable()
      .optional(),
    Size: dec,
    Filled: decOrNull,
    Price: decOrNull,
    StopPrice: decOrNull,
    BoundPrice: decOrNull,
    PostOnly: z.boolean().optional(),
    ReduceOnly: z.boolean().optional(),
    ClosePosition: z.boolean().optional(),
    PriceProtect: z.boolean().optional(),
    Trailing: z
      .looseObject({
        CallbackRate: dec,
        ActivationPrice: decOrNull,
        Extreme: decOrNull,
        Activated: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    CreateTimestamp: int.optional(),
    EntryTimestamp: int.optional(),
    EventTimestamp: int.optional(),
  })
  .transform((r) => ({
    id: r.ID,
    clientOrderId: r.ClientOrderID ?? "",
    accountId: r.AccountID ?? "",
    symbol: r.Symbol,
    side: r.Side,
    status: r.Status,
    type: r.Type,
    originType: r.OriginType ? r.OriginType : null,
    autoCloseType: r.AutoCloseType ? r.AutoCloseType : null,
    timeInForce: r.TimeInForce ? r.TimeInForce : null,
    workingType: r.WorkingType ? r.WorkingType : null,
    size: r.Size,
    filled: r.Filled ?? 0,
    price: r.Price ?? 0,
    stopPrice: r.StopPrice ?? 0,
    boundPrice: r.BoundPrice,
    postOnly: r.PostOnly ?? false,
    reduceOnly: r.ReduceOnly ?? false,
    closePosition: r.ClosePosition ?? false,
    priceProtect: r.PriceProtect ?? false,
    strategy: r.Strategy ? { id: r.Strategy.ID, isPrimary: r.Strategy.IsPrimary ?? false } : null,
    trailing: r.Trailing
      ? {
          callbackRate: r.Trailing.CallbackRate,
          activationPrice: r.Trailing.ActivationPrice,
          extreme: r.Trailing.Extreme,
          activated: r.Trailing.Activated ?? false,
        }
      : null,
    closeReason: r.CloseReason ?? "",
    createTimestamp: r.CreateTimestamp ?? 0,
    entryTimestamp: r.EntryTimestamp ?? 0,
    eventTimestamp: r.EventTimestamp ?? 0,
  }));

export const OpenOrdersSchema: z.ZodType<StrikeOrder[], unknown> = z.union([
  z.looseObject({ orders: z.array(StrikeOrderSchema).nullable() }).transform((r) => r.orders ?? []),
  z.array(StrikeOrderSchema),
]);

export interface CreateOrderAck {
  clientOrderId: string;
  accountId: string;
  symbol: string;
  sequenceId: number;
  messageId: string;
}

export const CreateOrderAckSchema: z.ZodType<CreateOrderAck, unknown> = z
  .looseObject({
    client_order_id: z.string().optional(),
    account_id: z.string().optional(),
    symbol: z.string().optional(),
    sequence_id: int.optional(),
    message_id: z.string().optional(),
  })
  .transform((r) => ({
    clientOrderId: r.client_order_id ?? "",
    accountId: r.account_id ?? "",
    symbol: r.symbol ?? "",
    sequenceId: r.sequence_id ?? 0,
    messageId: r.message_id ?? "",
  }));

export interface CreateStrategyOrderAck {
  strategyId: string;
  primaryClientOrderId: string;
  tpClientOrderId: string | null;
  slClientOrderId: string | null;
  accountId: string;
  symbol: string;
  sequenceId: number;
  messageId: string;
}

export const CreateStrategyOrderAckSchema: z.ZodType<CreateStrategyOrderAck, unknown> = z
  .looseObject({
    strategy_id: z.string().optional(),
    primary_client_order_id: z.string().optional(),
    tp_client_order_id: nullableStr,
    sl_client_order_id: nullableStr,
    account_id: z.string().optional(),
    symbol: z.string().optional(),
    sequence_id: int.optional(),
    message_id: z.string().optional(),
  })
  .transform((r) => ({
    strategyId: r.strategy_id ?? "",
    primaryClientOrderId: r.primary_client_order_id ?? "",
    tpClientOrderId: r.tp_client_order_id || null,
    slClientOrderId: r.sl_client_order_id || null,
    accountId: r.account_id ?? "",
    symbol: r.symbol ?? "",
    sequenceId: r.sequence_id ?? 0,
    messageId: r.message_id ?? "",
  }));

export interface CancelOrderAck {
  orderId: number;
  symbol: string;
  sequenceId: number;
  messageId: string;
}

export const CancelOrderAckSchema: z.ZodType<CancelOrderAck, unknown> = z
  .looseObject({
    order_id: int.optional(),
    symbol: z.string().optional(),
    sequence_id: int.optional(),
    message_id: z.string().optional(),
  })
  .transform((r) => ({
    orderId: r.order_id ?? 0,
    symbol: r.symbol ?? "",
    sequenceId: r.sequence_id ?? 0,
    messageId: r.message_id ?? "",
  }));

export interface CancelAllAck {
  accountId: string;
  symbol: string;
  /** -1 = processed asynchronously, count unknown. */
  canceledCount: number;
  sequenceId: number;
  messageId: string;
}

export const CancelAllAckSchema: z.ZodType<CancelAllAck, unknown> = z
  .looseObject({
    account_id: z.string().optional(),
    symbol: z.string().optional(),
    canceled_count: int.optional(),
    sequence_id: int.optional(),
    message_id: z.string().optional(),
  })
  .transform((r) => ({
    accountId: r.account_id ?? "",
    symbol: r.symbol ?? "",
    canceledCount: r.canceled_count ?? -1,
    sequenceId: r.sequence_id ?? 0,
    messageId: r.message_id ?? "",
  }));

export interface ReplaceOrderAck {
  cancel: CancelOrderAck | null;
  newOrder: CreateOrderAck | null;
  sequenceId: number;
  messageId: string;
}

export const ReplaceOrderAckSchema: z.ZodType<ReplaceOrderAck, unknown> = z
  .looseObject({
    cancel: CancelOrderAckSchema.nullable().optional(),
    new_order: CreateOrderAckSchema.nullable().optional(),
    sequence_id: int.optional(),
    message_id: z.string().optional(),
  })
  .transform((r) => ({
    cancel: r.cancel ?? null,
    newOrder: r.new_order ?? null,
    sequenceId: r.sequence_id ?? 0,
    messageId: r.message_id ?? "",
  }));

export interface LeverageAck {
  symbol: string;
  leverage: number;
  maxNotionalValue: number | null;
}

export const LeverageAckSchema: z.ZodType<LeverageAck, unknown> = z
  .looseObject({ symbol: z.string().optional(), leverage: int, maxNotionalValue: decOrNull })
  .transform((r) => ({ symbol: r.symbol ?? "", leverage: r.leverage, maxNotionalValue: r.maxNotionalValue }));

export interface MarginModeAck {
  symbol: string;
  marginMode: MarginMode;
}

export const MarginModeAckSchema: z.ZodType<MarginModeAck, unknown> = z
  .looseObject({ symbol: z.string().optional(), marginMode: MarginMode })
  .transform((r) => ({ symbol: r.symbol ?? "", marginMode: r.marginMode }));

// ---------------------------------------------------------------------------------------------
// History (authenticated)
// ---------------------------------------------------------------------------------------------

export interface StrikeOrderHistoryEntry {
  id: number;
  clientOrderId: string;
  accountId: string;
  symbol: string;
  strategyId: string | null;
  isPrimary: boolean | null;
  closeReason: string | null;
  side: OrderSide;
  status: OrderStatus;
  type: OrderType;
  originType: OrderType | null;
  autoCloseType: string | null;
  timeInForce: TimeInForce | null;
  workingType: string | null;
  size: number;
  filled: number;
  price: number;
  stopPrice: number;
  postOnly: boolean;
  reduceOnly: boolean;
  closePosition: boolean;
  priceProtect: boolean;
  callbackRate: number | null;
  activationPrice: number | null;
  createTimestamp: number;
  entryTimestamp: number;
  eventTimestamp: number;
}

const OrderHistoryEntrySchema: z.ZodType<StrikeOrderHistoryEntry, unknown> = z
  .looseObject({
    id: int,
    client_order_id: z.string().nullable().optional(),
    account_id: z.string().optional(),
    symbol: z.string(),
    strategy_id: nullableStr,
    is_primary: z.boolean().nullable().optional(),
    close_reason: nullableStr,
    side: OrderSide,
    status: OrderStatus,
    type: OrderType,
    origin_type: z
      .union([OrderType, z.literal("")])
      .nullable()
      .optional(),
    auto_close_type: nullableStr,
    time_in_force: z
      .union([TimeInForce, z.literal("")])
      .nullable()
      .optional(),
    working_type: nullableStr,
    size: dec,
    filled: decOrNull,
    price: decOrNull,
    stop_price: decOrNull,
    post_only: z.boolean().optional(),
    reduce_only: z.boolean().optional(),
    close_position: z.boolean().optional(),
    price_protect: z.boolean().optional(),
    callback_rate: decOrNull,
    activation_price: decOrNull,
    create_timestamp: int.optional(),
    entry_timestamp: int.optional(),
    event_timestamp: int.optional(),
  })
  .transform((r) => ({
    id: r.id,
    clientOrderId: r.client_order_id ?? "",
    accountId: r.account_id ?? "",
    symbol: r.symbol,
    strategyId: r.strategy_id || null,
    isPrimary: r.is_primary ?? null,
    closeReason: r.close_reason || null,
    side: r.side,
    status: r.status,
    type: r.type,
    originType: r.origin_type ? r.origin_type : null,
    autoCloseType: r.auto_close_type || null,
    timeInForce: r.time_in_force ? r.time_in_force : null,
    workingType: r.working_type && r.working_type !== "none" ? r.working_type : null,
    size: r.size,
    filled: r.filled ?? 0,
    price: r.price ?? 0,
    stopPrice: r.stop_price ?? 0,
    postOnly: r.post_only ?? false,
    reduceOnly: r.reduce_only ?? false,
    closePosition: r.close_position ?? false,
    priceProtect: r.price_protect ?? false,
    callbackRate: r.callback_rate,
    activationPrice: r.activation_price,
    createTimestamp: r.create_timestamp ?? 0,
    entryTimestamp: r.entry_timestamp ?? 0,
    eventTimestamp: r.event_timestamp ?? 0,
  }));

export const OrderHistorySchema: z.ZodType<StrikeOrderHistoryEntry[], unknown> = z.union([
  z.looseObject({ orders: z.array(OrderHistoryEntrySchema).nullable() }).transform((r) => r.orders ?? []),
  z.array(OrderHistoryEntrySchema),
]);

export interface StrikeFill {
  id: number;
  tradeId: number;
  orderId: number;
  accountId: string;
  symbol: string;
  side: OrderSide;
  role: "maker" | "taker";
  price: number;
  size: number;
  realizedPnl: number;
  /** Positive = paid; a maker rebate shows as negative. */
  fee: number;
  feeType: string;
  liquidationFee: number | null;
  entryPrice: number | null;
  closePrice: number | null;
  margin: number | null;
  roiPct: number | null;
  leverage: number | null;
  timestamp: number;
  autoCloseType: string | null;
}

const FillSchema: z.ZodType<StrikeFill, unknown> = z
  .looseObject({
    id: int,
    trade_id: int.optional(),
    order_id: int.optional(),
    account_id: z.string().optional(),
    symbol: z.string(),
    side: OrderSide,
    role: z.enum(["maker", "taker"]).optional(),
    is_maker: z.boolean().optional(),
    price: dec,
    size: decOrNull,
    qty: decOrNull,
    realized_pnl: decOrNull,
    fee: decOrNull,
    commission: decOrNull,
    fee_type: z.string().optional(),
    liquidation_fee: decOrNull,
    entry_price: decOrNull,
    close_price: decOrNull,
    margin: decOrNull,
    roi_pct: decOrNull,
    leverage: int.nullable().optional(),
    timestamp: int.optional(),
    time: int.optional(),
    auto_close_type: nullableStr,
  })
  .transform((r, ctx) => {
    const size = r.size ?? r.qty;
    if (size === null || size === undefined) {
      ctx.addIssue({ code: "custom", message: "fill missing size" });
      return z.NEVER;
    }
    return {
      id: r.id,
      tradeId: r.trade_id ?? 0,
      orderId: r.order_id ?? 0,
      accountId: r.account_id ?? "",
      symbol: r.symbol,
      side: r.side,
      role: r.role ?? (r.is_maker ? "maker" : "taker"),
      price: r.price,
      size,
      realizedPnl: r.realized_pnl ?? 0,
      fee: r.fee ?? r.commission ?? 0,
      feeType: r.fee_type ?? "commission",
      liquidationFee: r.liquidation_fee,
      entryPrice: r.entry_price,
      closePrice: r.close_price,
      margin: r.margin,
      roiPct: r.roi_pct,
      leverage: r.leverage ?? null,
      timestamp: r.timestamp ?? r.time ?? 0,
      autoCloseType: r.auto_close_type || null,
    };
  });

export const FillHistorySchema: z.ZodType<StrikeFill[], unknown> = z.union([
  z.looseObject({ fills: z.array(FillSchema).nullable() }).transform((r) => r.fills ?? []),
  z.array(FillSchema),
]);

export interface StrikeFundingPayment {
  id: number;
  transactionId: number;
  accountId: string;
  positionId: number;
  symbol: string;
  positionSize: number;
  positionSide: "Long" | "Short" | null;
  fundingRate: number;
  /** Positive = received, negative = paid. */
  amount: number;
  timestamp: number;
}

const FundingPaymentSchema: z.ZodType<StrikeFundingPayment, unknown> = z
  .looseObject({
    id: int,
    transaction_id: int.optional(),
    account_id: z.string().optional(),
    position_id: int.optional(),
    symbol: z.string(),
    position_size: decOrNull,
    position_side: z.enum(["Long", "Short"]).nullable().optional(),
    funding_rate: decOrNull,
    amount: decOrNull,
    income: decOrNull,
    timestamp: int.optional(),
    time: int.optional(),
  })
  .transform((r, ctx) => {
    const amount = r.amount ?? r.income;
    if (amount === null || amount === undefined) {
      ctx.addIssue({ code: "custom", message: "funding row missing amount" });
      return z.NEVER;
    }
    return {
      id: r.id,
      transactionId: r.transaction_id ?? 0,
      accountId: r.account_id ?? "",
      positionId: r.position_id ?? 0,
      symbol: r.symbol,
      positionSize: r.position_size ?? 0,
      positionSide: r.position_side ?? null,
      fundingRate: r.funding_rate ?? 0,
      amount,
      timestamp: r.timestamp ?? r.time ?? 0,
    };
  });

export const FundingHistorySchema: z.ZodType<StrikeFundingPayment[], unknown> = z.union([
  z.looseObject({ funding: z.array(FundingPaymentSchema).nullable() }).transform((r) => r.funding ?? []),
  z.array(FundingPaymentSchema),
]);

/**
 * Closed positions: the spec documents a sparse PascalCase row; the skill shows a rich snake_case
 * one. We accept both and expose whatever detail is present.
 */
export interface StrikeClosedPosition {
  id: number;
  accountId: string;
  symbol: string;
  marginMode: MarginMode | null;
  openTimestamp: number;
  closeTimestamp: number | null;
  side: Direction | null;
  size: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  realizedPnl: number | null;
  leverage: number | null;
  raw: Record<string, unknown>;
}

const ClosedPositionSchema: z.ZodType<StrikeClosedPosition, unknown> = z
  .looseObject({
    ID: int.optional(),
    id: int.optional(),
    position_id: int.optional(),
    AccountID: z.string().optional(),
    account_id: z.string().optional(),
    Symbol: z.string().optional(),
    symbol: z.string().optional(),
    MarginMode: MarginMode.optional(),
    margin_mode: MarginMode.optional(),
    OpenTimestamp: int.optional(),
    opened_at: int.optional(),
    CloseTimestamp: int.nullable().optional(),
    closed_at: int.nullable().optional(),
    side: z.string().optional(),
    size: decOrNull,
    entry_price: decOrNull,
    exit_price: decOrNull,
    realized_pnl: decOrNull,
    leverage: int.optional(),
  })
  .transform((r, ctx) => {
    const symbol = r.Symbol ?? r.symbol;
    if (symbol === undefined) {
      ctx.addIssue({ code: "custom", message: "closed position missing symbol" });
      return z.NEVER;
    }
    const sideStr = r.side?.toLowerCase();
    return {
      id: r.ID ?? r.id ?? r.position_id ?? 0,
      accountId: r.AccountID ?? r.account_id ?? "",
      symbol,
      marginMode: r.MarginMode ?? r.margin_mode ?? null,
      openTimestamp: r.OpenTimestamp ?? r.opened_at ?? 0,
      closeTimestamp: r.CloseTimestamp ?? r.closed_at ?? null,
      side: sideStr === "long" ? "long" : sideStr === "short" ? "short" : null,
      size: r.size,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      realizedPnl: r.realized_pnl,
      leverage: r.leverage ?? null,
      raw: r as Record<string, unknown>,
    };
  });

export const ClosedPositionsSchema: z.ZodType<StrikeClosedPosition[], unknown> = z.union([
  z.looseObject({ positions: z.array(ClosedPositionSchema).nullable() }).transform((r) => r.positions ?? []),
  z.array(ClosedPositionSchema),
]);

// ---------------------------------------------------------------------------------------------
// Requests (wire format, snake_case, matches the OpenAPI CreateOrderRequest etc.)
// ---------------------------------------------------------------------------------------------

/** Decimal input: pre-formatted string, or a number the client formats with the symbol's rules. */
export type DecimalInput = string | number;

export interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: DecimalInput;
  price?: DecimalInput;
  stop_price?: DecimalInput;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  post_only?: boolean;
  reduce_only?: boolean;
  close_position?: boolean;
  price_protect?: boolean;
  /** Trailing stops: "0.1".."5" percent. */
  callback_rate?: string;
  activation_price?: DecimalInput;
  /** Market orders: fraction, e.g. "0.05". */
  slippage?: string;
  client_order_id?: string;
  vault_id?: string;
  sub_account_id?: string;
}

export interface StrategyLegRequest {
  type: StrategyLegType;
  size: DecimalInput;
  stop_price: DecimalInput;
  price?: DecimalInput;
  client_order_id?: string;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  post_only?: boolean;
  price_protect?: boolean;
}

export interface CreateStrategyOrderRequest {
  strategy_id: string;
  symbol: string;
  side: OrderSide;
  type: "limit" | "market";
  size: DecimalInput;
  price?: DecimalInput;
  stop_price?: DecimalInput;
  client_order_id?: string;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  post_only?: boolean;
  reduce_only?: boolean;
  close_position?: boolean;
  price_protect?: boolean;
  tp_order?: StrategyLegRequest;
  sl_order?: StrategyLegRequest;
  vault_id?: string;
  sub_account_id?: string;
}

export interface CancelOrderRequest {
  order_id: number;
  symbol: string;
  vault_id?: string;
  sub_account_id?: string;
}

export interface ReplaceOrderRequest {
  cancel?: CancelOrderRequest;
  new_order?: CreateOrderRequest;
  vault_id?: string;
  sub_account_id?: string;
}
