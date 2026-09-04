---
name: strike-calculations
description: Strike Finance trading calculations — liquidation prices, PnL, margin requirements, margin tiers. Use when building position displays or risk calculations.
---

# Strike Finance Trading Calculations

## Margin Tiers

Each market has margin tiers sorted by `max_notional` ascending. Each tier defines:

| Field | Description |
|-------|-------------|
| `max_notional` | Upper bound of notional for this tier |
| `max_leverage` | Maximum leverage allowed |
| `maintenance_margin_rate` (MMR) | Rate used for maintenance margin calculation |
| `maintenance_amount` (MA) | Flat offset subtracted from maintenance margin |

Larger positions land in more restrictive tiers (lower leverage, higher MMR).

```typescript
interface MarginTier {
  max_notional: number;
  max_leverage: number;
  maintenance_margin_rate: number;
  maintenance_amount: number;
}

function getMarginTier(tiers: MarginTier[], notional: number): MarginTier {
  return tiers.find((t) => notional <= t.max_notional) || tiers[tiers.length - 1];
}
```

## Notional Value

```
Notional = MarkPrice * |Size|
```

```typescript
function calcNotional(markPrice: number, size: number): number {
  return markPrice * Math.abs(size);
}
```

## Unrealized PnL

```
LONG:  uPnL = (MarkPrice - EntryPrice) * Size
SHORT: uPnL = (EntryPrice - MarkPrice) * Size
```

```typescript
function calcUnrealizedPnl(
  side: "LONG" | "SHORT",
  entryPrice: number,
  markPrice: number,
  size: number
): number {
  if (side === "LONG") {
    return (markPrice - entryPrice) * size;
  }
  return (entryPrice - markPrice) * size;
}
```

## PnL Percentage

```
pnlPercentage = (uPnL / currentMargin) * 100
```

```typescript
function calcPnlPercentage(unrealizedPnl: number, currentMargin: number): number {
  if (currentMargin === 0) return 0;
  return (unrealizedPnl / currentMargin) * 100;
}
```

## Margin

```
Isolated: currentMargin = isoBalance
Cross:    currentMargin = Notional / Leverage
```

```typescript
function calcCurrentMargin(
  marginType: "cross" | "isolated",
  isoBalance: number,
  notional: number,
  leverage: number
): number {
  if (marginType === "isolated") {
    return isoBalance;
  }
  return leverage > 0 ? notional / leverage : 0;
}
```

## Maintenance Margin

```
MM = Notional * MMR - MaintenanceAmount
```

```typescript
function calcMaintenanceMargin(
  notional: number,
  tier: MarginTier
): number {
  return notional * tier.maintenance_margin_rate - tier.maintenance_amount;
}
```

## Liquidation Price -- Isolated

Fixed value. Does not change with mark price.

```
LP = (EP - (IsoBalance + MA) / Size) / (1 - Direction * MMR)

Direction = 1 for LONG, -1 for SHORT
```

Returns 0 if immediately liquidatable. Validate: LONG LP < EP, SHORT LP > EP.

```typescript
function calcLiquidationPriceIsolated(
  side: "LONG" | "SHORT",
  entryPrice: number,
  isoBalance: number,
  size: number,
  tier: MarginTier
): number {
  const direction = side === "LONG" ? 1 : -1;
  const mmr = tier.maintenance_margin_rate;
  const ma = tier.maintenance_amount;

  const denominator = 1 - direction * mmr;
  if (denominator === 0) return 0;

  const numerator = entryPrice - (isoBalance + ma) / size;
  const liqPrice = numerator / denominator;

  if (liqPrice <= 0) return 0;

  // Validate direction
  if (side === "LONG" && liqPrice >= entryPrice) return 0;
  if (side === "SHORT" && liqPrice <= entryPrice) return 0;

  return liqPrice;
}
```

## Liquidation Price -- Cross

Variable. Changes with mark price of other positions and wallet balance.

```
LP = (EP - (W + TU - TM + MA) / Size) / (1 - Direction * MMR)

W  = WalletBalance - Sum(isolated positions) IsoBalance
TU = Sum(other cross positions) UnrealizedPnL
TM = Sum(other cross positions) MaintenanceMargin
```

```typescript
interface CrossPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  markPrice: number;
  notional: number;
  tier: MarginTier;
}

interface IsolatedPosition {
  isoBalance: number;
}

function calcLiquidationPriceCross(
  position: CrossPosition,
  walletBalance: number,
  otherCrossPositions: CrossPosition[],
  isolatedPositions: IsolatedPosition[],
  tier: MarginTier
): number {
  const direction = position.side === "LONG" ? 1 : -1;
  const mmr = tier.maintenance_margin_rate;
  const ma = tier.maintenance_amount;

  // Available wallet balance (exclude isolated margins)
  const totalIsoBalance = isolatedPositions.reduce(
    (sum, p) => sum + p.isoBalance,
    0
  );
  const W = walletBalance - totalIsoBalance;

  // Sum of other cross positions' unrealized PnL
  const TU = otherCrossPositions.reduce((sum, p) => {
    return sum + calcUnrealizedPnl(p.side, p.entryPrice, p.markPrice, p.size);
  }, 0);

  // Sum of other cross positions' maintenance margin
  const TM = otherCrossPositions.reduce((sum, p) => {
    return sum + calcMaintenanceMargin(p.notional, p.tier);
  }, 0);

  const denominator = 1 - direction * mmr;
  if (denominator === 0) return 0;

  const numerator = position.entryPrice - (W + TU - TM + ma) / position.size;
  const liqPrice = numerator / denominator;

  if (liqPrice <= 0) return 0;

  // Validate direction
  if (position.side === "LONG" && liqPrice >= position.entryPrice) return 0;
  if (position.side === "SHORT" && liqPrice <= position.entryPrice) return 0;

  return liqPrice;
}
```

## Available Balance

Server-computed value returned from the account endpoint:

```
GET /v2/account -> response.available_balance
```

## Withdrawable Balance

```
WithdrawableBalance = max(0, BaseBalance - max(CrossIM - CrossUPnL, CrossMM))

BaseBalance = WalletBalance - Sum(isolated)IsoBalance - Sum(TotalOrderCost)
CrossIM     = Total initial margin for cross positions
CrossUPnL   = Total unrealized PnL for cross positions
CrossMM     = Total maintenance margin for cross positions
```

```typescript
function calcWithdrawableBalance(
  walletBalance: number,
  totalIsoBalance: number,
  totalOrderCost: number,
  crossInitialMargin: number,
  crossUnrealizedPnl: number,
  crossMaintenanceMargin: number
): number {
  const baseBalance = walletBalance - totalIsoBalance - totalOrderCost;
  const marginRequirement = Math.max(
    crossInitialMargin - crossUnrealizedPnl,
    crossMaintenanceMargin
  );
  return Math.max(0, baseBalance - marginRequirement);
}
```

## TP/SL Price Conversions

### ROI Percentage to TP/SL Price

```
LONG:  tpPrice = entryPrice + (percentage / 100) * margin / size
SHORT: tpPrice = entryPrice - (percentage / 100) * margin / size
```

```typescript
function calcTpSlPriceFromPercentage(
  side: "LONG" | "SHORT",
  entryPrice: number,
  percentage: number,
  margin: number,
  size: number
): number {
  const offset = (percentage / 100) * margin / size;
  if (side === "LONG") {
    return entryPrice + offset;
  }
  return entryPrice - offset;
}
```

### USD Gain to TP/SL Price

```
LONG:  tpPrice = entryPrice + usdGain / size
SHORT: tpPrice = entryPrice - usdGain / size
```

```typescript
function calcTpSlPriceFromUsd(
  side: "LONG" | "SHORT",
  entryPrice: number,
  usdGain: number,
  size: number
): number {
  const offset = usdGain / size;
  if (side === "LONG") {
    return entryPrice + offset;
  }
  return entryPrice - offset;
}
```

## Complete Position Summary Example

```typescript
interface PositionSummary {
  unrealizedPnl: number;
  pnlPercentage: number;
  notional: number;
  currentMargin: number;
  maintenanceMargin: number;
  liquidationPrice: number;
}

function calcPositionSummary(
  side: "LONG" | "SHORT",
  marginType: "cross" | "isolated",
  entryPrice: number,
  markPrice: number,
  size: number,
  leverage: number,
  isoBalance: number,
  tiers: MarginTier[],
  // Cross-specific params
  walletBalance?: number,
  otherCrossPositions?: CrossPosition[],
  isolatedPositions?: IsolatedPosition[]
): PositionSummary {
  const notional = calcNotional(markPrice, size);
  const tier = getMarginTier(tiers, notional);
  const unrealizedPnl = calcUnrealizedPnl(side, entryPrice, markPrice, size);
  const currentMargin = calcCurrentMargin(marginType, isoBalance, notional, leverage);
  const pnlPercentage = calcPnlPercentage(unrealizedPnl, currentMargin);
  const maintenanceMargin = calcMaintenanceMargin(notional, tier);

  let liquidationPrice: number;
  if (marginType === "isolated") {
    liquidationPrice = calcLiquidationPriceIsolated(
      side,
      entryPrice,
      isoBalance,
      size,
      tier
    );
  } else {
    liquidationPrice = calcLiquidationPriceCross(
      { symbol: "", side, size, entryPrice, markPrice, notional, tier },
      walletBalance ?? 0,
      otherCrossPositions ?? [],
      isolatedPositions ?? [],
      tier
    );
  }

  return {
    unrealizedPnl,
    pnlPercentage,
    notional,
    currentMargin,
    maintenanceMargin,
    liquidationPrice,
  };
}

// Usage example
const tiers: MarginTier[] = [
  { max_notional: 50000, max_leverage: 100, maintenance_margin_rate: 0.004, maintenance_amount: 0 },
  { max_notional: 250000, max_leverage: 50, maintenance_margin_rate: 0.005, maintenance_amount: 50 },
  { max_notional: 1000000, max_leverage: 20, maintenance_margin_rate: 0.01, maintenance_amount: 1300 },
  { max_notional: 5000000, max_leverage: 10, maintenance_margin_rate: 0.025, maintenance_amount: 16300 },
  { max_notional: 20000000, max_leverage: 5, maintenance_margin_rate: 0.05, maintenance_amount: 141300 },
];

const summary = calcPositionSummary(
  "LONG",
  "isolated",
  42000,    // entry price
  43500,    // mark price
  0.5,      // size
  20,       // leverage
  1050,     // isolated balance
  tiers
);

console.log(`Notional:     $${summary.notional.toFixed(2)}`);
console.log(`Margin:       $${summary.currentMargin.toFixed(2)}`);
console.log(`uPnL:         $${summary.unrealizedPnl.toFixed(2)}`);
console.log(`PnL %:        ${summary.pnlPercentage.toFixed(2)}%`);
console.log(`Maint Margin: $${summary.maintenanceMargin.toFixed(2)}`);
console.log(`Liq Price:    $${summary.liquidationPrice.toFixed(2)}`);
```
