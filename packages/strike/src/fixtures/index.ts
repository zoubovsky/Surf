/**
 * Recorded response fixtures. Public shapes were captured from mainnet on 2026-09-04; authenticated
 * shapes follow the OpenAPI examples and the official skills (no keys available here).
 */

export const exchangeInfoFixture = {
  timezone: "UTC",
  serverTime: 1788519205651,
  rateLimits: [
    { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 2400 },
    { rateLimitType: "ORDERS", interval: "MINUTE", intervalNum: 1, limit: 1200 },
  ],
  symbols: [
    {
      symbol: "BTC-USD",
      pair: "BTC-USD",
      contractType: "PERPETUAL",
      status: "trading",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      pricePrecision: 8,
      quantityPrecision: 8,
      baseAssetPrecision: 8,
      quotePrecision: 8,
      underlyingType: "COIN",
      underlyingSubType: ["BTC"],
      settlePlan: 0,
      triggerProtect: "0.05",
      liquidationFee: "0.0125",
      limitTakeBound: "0.05",
      marketTakeBound: "0.05",
      filters: [
        { filterType: "PRICE_FILTER", maxPrice: "100000", minPrice: "10", tickSize: "0.10" },
        { filterType: "LOT_SIZE", maxQty: "1000", minQty: "0.00001", stepSize: "0.00001" },
        { filterType: "MARKET_LOT_SIZE", maxQty: "120", minQty: "0.00001", stepSize: "0.00001" },
        { filterType: "MIN_NOTIONAL", notional: "10" },
      ],
      orderType: ["LIMIT", "MARKET", "STOP", "STOP_MARKET", "TAKE_PROFIT", "TAKE_PROFIT_MARKET"],
      timeInForce: ["GTC", "IOC", "FOK"],
    },
    {
      symbol: "XAU-USD",
      pair: "XAU-USD",
      contractType: "PERPETUAL",
      status: "trading",
      baseAsset: "XAU",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      pricePrecision: 8,
      quantityPrecision: 8,
      triggerProtect: "0.05",
      liquidationFee: "0.0125",
      limitTakeBound: "0.05",
      marketTakeBound: "0.05",
      filters: [
        { filterType: "PRICE_FILTER", maxPrice: "200000", minPrice: "0.01", tickSize: "0.01" },
        { filterType: "LOT_SIZE", maxQty: "600", minQty: "0.001", stepSize: "0.001" },
        { filterType: "MARKET_LOT_SIZE", maxQty: "60", minQty: "0.001", stepSize: "0.001" },
        { filterType: "MIN_NOTIONAL", notional: "10" },
      ],
      orderType: ["LIMIT", "MARKET"],
      timeInForce: ["GTC", "IOC", "FOK"],
    },
  ],
};

export const premiumIndexFixture = {
  symbol: "BTC-USD",
  markPrice: "79780.79063272754451",
  indexPrice: "79780.67910433444817",
  latestPremiumIndex: "0",
  averagePremiumIndex: "-0.0000052193034318743",
  premiumIndexCount: 619,
  fundingRate: "0.0000118475870710157",
  nextFundingTime: 1788541200000,
  interestRate: "0.0001",
  interestRateDampener: "0",
  time: 1788540794990,
};

export const markPriceFixture = {
  e: "markPriceUpdate",
  E: 1788540798020,
  s: "BTC-USD",
  p: "79780.79063273",
  i: "79780.67910433",
  r: "0.0000118475870710157",
  T: 1788541200000,
};

export const klinesFixture = [
  [
    1788526800000,
    "79482.10",
    "79689.10",
    "78987.80",
    "79368.10",
    "1.761950000000000000",
    1788530399999,
    "139961.5838500000000",
    316,
    "0.73411",
    "58249.6732890",
    "0",
  ],
  [
    1788530400000,
    "79368.10",
    "79368.10",
    "78995.20",
    "78995.20",
    "0.0089000000000000000",
    1788533999999,
    "703.0572800000000000",
    4,
    "0",
    "0",
    "0",
  ],
  [
    1788534000000,
    "78995.20",
    "79543.60",
    "78858.80",
    "79414.10",
    "4.220180000000000000",
    1788537599999,
    "333824.1557380000000",
    475,
    "2.432950000000000000",
    "192278.8260680000000",
    "0",
  ],
];

/** Raw text so the uint64 handling is exercised; the id here exceeds Number.MAX_SAFE_INTEGER. */
export const depthFixtureText =
  '{"lastUpdateId":18446744073709551615,"E":1788540799931,"T":1788540798975,' +
  '"bids":[["79765.70","0.03007"],["79764.90","0.06014"],["79764.20","0.12029"],["79760.70","0.00626"],["79757.50","0.06269"],["79300.00","1.5"]],' +
  '"asks":[["79769.50","0.12536"],["79771.50","0.25071"],["79773.50","0.31338"],["79777.40","0.25069"],["79779.40","0.31336"],["80300.00","2.0"]]}';

export const bookTickerFixture = {
  symbol: "BTC-USD",
  bidPrice: "79808.80",
  bidQty: "0.00626",
  askPrice: "79810.40",
  askQty: "0.0013600000000000000",
  time: 1788540802016,
};

export const openInterestFixture = {
  symbol: "BTC-USD",
  openInterest: "4.374660000000000000",
  time: 1788540803226,
};

export const marketFixture = {
  symbol: "BTC-USD",
  name: "Bitcoin / USD",
  base_asset: "BTC",
  status: "trading",
  created_at: 0,
  base_prec: 8,
  quote_prec: 8,
  default_leverage: 10,
  margin_tiers: [
    { max_notional: "10000", max_leverage: 100, maintenance_margin_rate: "0.004", maintenance_amount: "0" },
    {
      max_notional: "50000",
      max_leverage: 75,
      maintenance_margin_rate: "0.004",
      maintenance_amount: "0.000",
    },
    {
      max_notional: "100000",
      max_leverage: 50,
      maintenance_margin_rate: "0.004",
      maintenance_amount: "0.000",
    },
    {
      max_notional: "250000",
      max_leverage: 40,
      maintenance_margin_rate: "0.004",
      maintenance_amount: "0.000",
    },
    {
      max_notional: "300000",
      max_leverage: 25,
      maintenance_margin_rate: "0.004",
      maintenance_amount: "0.000",
    },
    {
      max_notional: "800000",
      max_leverage: 25,
      maintenance_margin_rate: "0.005",
      maintenance_amount: "300.000",
    },
    {
      max_notional: "1000000",
      max_leverage: 25,
      maintenance_margin_rate: "0.0065",
      maintenance_amount: "1500.0000",
    },
    {
      max_notional: "2500000",
      max_leverage: 20,
      maintenance_margin_rate: "0.0065",
      maintenance_amount: "1500.0000",
    },
    {
      max_notional: "3000000",
      max_leverage: 10,
      maintenance_margin_rate: "0.0065",
      maintenance_amount: "1500.0000",
    },
    {
      max_notional: "10000000",
      max_leverage: 10,
      maintenance_margin_rate: "0.01",
      maintenance_amount: "12000.0000",
    },
    {
      max_notional: "12000000",
      max_leverage: 5,
      maintenance_margin_rate: "0.01",
      maintenance_amount: "12000.0000",
    },
    {
      max_notional: "25000000",
      max_leverage: 5,
      maintenance_margin_rate: "0.02",
      maintenance_amount: "132000.0000",
    },
    {
      max_notional: "70000000",
      max_leverage: 1,
      maintenance_margin_rate: "0.02",
      maintenance_amount: "132000.0000",
    },
    {
      max_notional: "100000000",
      max_leverage: 1,
      maintenance_margin_rate: "0.025",
      maintenance_amount: "482000.0000",
    },
  ],
  reduce_only: false,
  order_tick_price: "0.10",
  order_min_price: "10",
  order_max_price: "100000",
  order_limit_price_bound: "0.05",
  order_market_price_bound: "0.05",
  order_limit_step_size: "0.00001",
  order_limit_min_size: "0.00001",
  order_limit_max_size: "1000",
  order_market_step_size: "0.00001",
  order_market_min_size: "0.00001",
  order_market_max_size: "120",
  order_min_notional: "10",
  liquidation_fee_rate: "0.0125",
  liquidation_fee_retention_factor: "0.8",
  trigger_protect: "0.05",
  mark_price: "79762.34563747",
  index_price: "79762.23611569",
  last_price: "79810.40",
  bid1_price: "79808.80",
  bid1_size: "0.00626",
  ask1_price: "79810.40",
  ask1_size: "0.0013600000000000000",
  funding_rate: "0.0000118648519940629",
  next_funding_time: 1788541200000,
  impact_notional: "2500",
};

export const feeTiersFixture = {
  feeTiers: [
    { Tier: 0, MinVolume: 0, TakerRate: 0.0005, MakerRate: -0.00005 },
    { Tier: 1, MinVolume: 100000, TakerRate: 0.00045, MakerRate: -0.00005 },
    { Tier: 6, MinVolume: 200000000, TakerRate: 0.00028, MakerRate: -0.00005 },
  ],
  makerRebateTiers: [{ tier: 1, minMakerVolumeShare: 0.05, makerRate: -0.00008 }],
  referralTiers: [
    { tier: 0, name: "bronze", min_referred_volume: 0, reward_rate: 0.2, referee_discount_rate: 0.04 },
  ],
  stakingFeeDiscountTiers: [{ tier: 1, minStakedStrike: 5000, discountRate: 0.05 }],
};

// ---- authenticated shapes (OpenAPI examples / skills) ----

export const accountFixture = {
  account_id: "019d1935-5bba-726e-a38e-838a892245f3",
  blockchain: "cardano",
  blockchain_address: "addr1qx...",
  wallet_balance: "10000",
  available_balance: "7500",
  copy_reserved_balance: "0",
  unrealized_pnl: "250.5",
  margin_balance: "10250.5",
  total_margin: "2500",
  position_initial_margin: "2000",
  maintenance_margin: "500",
  sub_accounts: [{ account_id: "019d1935-0000-726e-a38e-838a892245f3", name: "Market making" }],
  symbol_settings: {
    "BTC-USD": { margin_mode: "isolated", leverage: 5, allow_pre_trade: false },
    "ETH-USD": { margin_mode: "cross", leverage: 10, allow_pre_trade: false },
  },
};

export const balancesFixture = [
  {
    asset: "USDT",
    walletBalance: "10000",
    unrealizedPnl: "250.5",
    marginBalance: "10250.5",
    maintMargin: "500",
    initialMargin: "2500",
    positionInitialMargin: "2000",
    openOrderInitialMargin: "0",
    crossWalletBalance: "10000",
    crossUnPnl: "250.5",
    availableBalance: "7500",
    maxWithdrawAmount: "7500",
    marginAvailable: true,
    updateTime: 1709000000000,
    lockedRewards: "0",
    maxWithdrawAfterRewards: "7500",
    stakingRewardBalance: "0",
  },
];

export const positionsFixture = {
  positions: [
    {
      id: 1,
      margin_mode: "isolated",
      leverage: 5,
      size: "0.5",
      entry_price: "50000",
      iso_balance: "5000",
      accumulated_funding_fees: "-1.25",
      create_timestamp: 1709000000000,
      update_timestamp: 1709000001000,
      symbol: "BTC-USD",
      upnl: "250.5",
      maintenance_margin: "125",
      bankruptcy_price: "45000",
      liquidation_price: "45500",
    },
    {
      id: 2,
      margin_mode: "cross",
      leverage: 10,
      size: "-2",
      entry_price: "3000",
      iso_balance: "0",
      accumulated_funding_fees: "0",
      create_timestamp: 1709000000000,
      update_timestamp: 1709000001000,
      symbol: "ETH-USD",
      upnl: "-40",
      maintenance_margin: "24",
      bankruptcy_price: "0",
      liquidation_price: "0",
    },
  ],
  count: 2,
};

/** Variant from the strike-history skill (PascalCase with Side). */
export const positionsPascalFixture = {
  positions: [
    {
      symbol: "BTC-USD",
      PositionID: "7",
      Side: "short",
      Size: "0.25",
      EntryPrice: "81000.00",
      MarginMode: "isolated",
      Leverage: 3,
      IsolatedMargin: "6750",
      upnl: "120.00",
      maintenance_margin: "81",
      bankruptcy_price: "107000",
      liquidation_price: "106500",
    },
  ],
  count: 1,
};

export const openOrdersFixture = {
  orders: [
    {
      ID: 123456,
      ClientOrderID: "entry-001",
      AccountID: "01234567-89ab-cdef-0123-456789abcdef",
      Symbol: "BTC-USD",
      Strategy: { ID: "s-001", IsPrimary: true },
      CloseReason: "",
      Side: "buy",
      Status: "open",
      Type: "limit",
      OriginType: "",
      AutoCloseType: "",
      TimeInForce: "GTC",
      WorkingType: "none",
      Size: "0.01",
      Filled: "0",
      Price: "78000.00",
      StopPrice: "0",
      BoundPrice: "0",
      PostOnly: true,
      ReduceOnly: false,
      ClosePosition: false,
      PriceProtect: false,
      Trailing: null,
      Builder: null,
      STPGroup: "",
      CreateTimestamp: 1704067200000,
      EntryTimestamp: 1704067200050,
      EventTimestamp: 1704067200150,
    },
    {
      ID: 123457,
      ClientOrderID: "sl-001",
      AccountID: "01234567-89ab-cdef-0123-456789abcdef",
      Symbol: "BTC-USD",
      Strategy: { ID: "s-001", IsPrimary: false },
      Side: "sell",
      Status: "untriggered",
      Type: "stop",
      TimeInForce: "GTC",
      WorkingType: "mark_price",
      Size: "0.01",
      Filled: "0",
      Price: "0",
      StopPrice: "76500.00",
      ReduceOnly: true,
      ClosePosition: false,
      CreateTimestamp: 1704067200000,
      EntryTimestamp: 1704067200050,
      EventTimestamp: 1704067200150,
    },
  ],
  count: 2,
};

export const createOrderAckFixture = {
  client_order_id: "entry-001",
  account_id: "01234567-89ab-cdef-0123-456789abcdef",
  symbol: "BTC-USD",
  sequence_id: 789012,
  message_id: "msg_xyz",
};

export const createStrategyAckFixture = {
  strategy_id: "s-001",
  primary_client_order_id: "entry-001",
  tp_client_order_id: "tp-001",
  sl_client_order_id: "sl-001",
  account_id: "01234567-89ab-cdef-0123-456789abcdef",
  symbol: "BTC-USD",
  sequence_id: 789013,
  message_id: "msg_abc",
};

export const orderHistoryFixture = {
  orders: [
    {
      id: 123456,
      client_order_id: "my-order-001",
      account_id: "019d1935-5bba-726e-a38e-838a892245f3",
      symbol: "BTC-USD",
      strategy_id: null,
      is_primary: null,
      close_reason: null,
      side: "buy",
      status: "filled",
      type: "limit",
      origin_type: "",
      auto_close_type: null,
      time_in_force: "GTC",
      working_type: "none",
      size: "0.1",
      filled: "0.1",
      price: "50000",
      stop_price: "0",
      post_only: false,
      reduce_only: false,
      close_position: false,
      price_protect: false,
      create_timestamp: 1709000000000,
      entry_timestamp: 1709000000010,
      event_timestamp: 1709000000500,
    },
  ],
  count: 1,
};

export const fillHistoryFixture = {
  fills: [
    {
      id: 789,
      trade_id: 987654,
      order_id: 123456,
      account_id: "019d1935-5bba-726e-a38e-838a892245f3",
      symbol: "BTC-USD",
      side: "buy",
      role: "maker",
      price: "50000",
      size: "0.1",
      realized_pnl: "0",
      fee: "-0.25",
      fee_type: "commission",
      entry_price: "50000",
      close_price: "50000",
      margin: "1000",
      roi_pct: "0",
      leverage: 5,
      timestamp: 1709000001000,
      auto_close_type: null,
    },
  ],
  count: 1,
};

export const fundingHistoryFixture = {
  funding: [
    {
      id: 1,
      transaction_id: 55,
      account_id: "019d1935-5bba-726e-a38e-838a892245f3",
      position_id: 1,
      symbol: "BTC-USD",
      position_size: "0.5",
      position_side: "Long",
      funding_rate: "0.0001",
      amount: "-1.25",
      timestamp: 1709003600000,
    },
  ],
  count: 1,
};

export const closedPositionsFixture = {
  positions: [
    {
      ID: 1,
      AccountID: "019d1935-5bba-726e-a38e-838a892245f3",
      Symbol: "BTC-USD",
      MarginMode: "isolated",
      OpenTimestamp: 1709000000000,
      CloseTimestamp: 1709086400000,
    },
    {
      symbol: "BTC-USD",
      position_id: 2,
      side: "long",
      size: "0.5",
      entry_price: "50000.00",
      exit_price: "52000.00",
      realized_pnl: "1000.00",
      margin_mode: "cross",
      leverage: 10,
      opened_at: 1699900000000,
      closed_at: 1700000000000,
    },
  ],
  count: 2,
};
