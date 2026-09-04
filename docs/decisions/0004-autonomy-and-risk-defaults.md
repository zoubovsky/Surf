# ADR 0004: Autonomy model and initial risk envelope

Status: accepted (2026-09-04), per operator decisions

## Decisions

- **Full autonomy with notification only.** No approval gates and no veto windows. Automatic halts re-arm themselves after a cooldown (default 24h) unless the operator has paused; strategy parameter changes from the calibration loop self-apply after passing the backtest gate. Everything is reported to Telegram.
- **Risk envelope (config, not reachable by any model):** 1% of equity risk per trade (hard cap 2%), leverage cap 5x, isolated margin, one BTC position at a time, max daily loss 3%, max drawdown from high-water mark 10%, max 4 entries per day, minimum 2 hours between entries, max notional 10% of visible depth within 0.5% of mid.
- **Live trading from the start**, with a `TRADING_MODE` flag (`shadow` | `live`). The first deployment runs `shadow` only long enough to verify connectivity, reconciliation and the order path, then flips to `live`.
- **Strategy gating:** the system trades on its own deterministic count; a fresh MCO video is used to correct or confirm the count. If the video's direction, invalidation, entry zone or targets materially disagree with ours, no trade. Trades require reviewer-approved confidence at or above the `high` threshold.
- **Operator pause:** `/pause` stops new entries (optionally flattens); `/resume` re-enables. These are the only manual controls.
