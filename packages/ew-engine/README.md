# @surf/ew-engine

Deterministic, pure Elliott Wave engine: candles in, rule-valid wave counts with explicit invalidation and Fib targets out. No LLM, no I/O, no randomness. Output is validated against the `EwAnalysis` schema in `@surf/core` before it is returned.

## API

- `analyze(candles, opts?) → EwAnalysis` — one interval. `opts`: `ks` (ZigZag degrees as ATR multiples, default `[1.5, 3, 6]`), `atrPeriod`/`rsiPeriod` (14), `topK` (5), `maxPivots` (9 recent pivots per degree), `swingsK` (which degree populates `swings`; default the middle one). Throws only on empty input.
- `analyzeMulti({ h1, h4 }, opts?) → { h1, h4, h4Direction }` — 1h candidates that agree with the top 4h candidate's direction get `+boost` (default 0.1), conflicting ones `−boost`; the 1h list is re-sorted and truncated.
- Layers, each exported and independently tested: `rsi`, `atr`, `rsiDivergence` (`indicators.ts`); `zigzagDetailed` — causal ATR-scaled ZigZag returning confirmed pivots plus the provisional extreme of the current leg (`zigzag.ts`); hard rules `checkImpulse` / `checkCorrection` returning `{ rule, passed, evaluated, detail }` per rule (`rules.ts`); Fib helpers and guideline scoring `scoreImpulseGuidelines` / `scoreCorrectionGuidelines` (`fib.ts`); `enumerateCandidates` (`candidates.ts`); synthetic generators `syntheticImpulse`, `candlesFromPath`, `randomWalk`, `insideBar` for known-answer tests (`synthetic.ts`).
- `bench.ts`: `tsx packages/ew-engine/src/bench.ts candles.json [--interval 1h] [--topk 5] [--json]` prints candidate summaries for a JSON candle file (core `Candle[]`, loose objects, or kline arrays). No network.

## How a candidate is produced

1. ZigZag at each degree. A reversal is confirmed when price moves more than `k × ATR14` against the current leg's extreme; extension bars replace the provisional pivot. Confirmed pivots never change when candles are appended.
2. From the last 2..6 confirmed pivots (plus the provisional extreme as the in-progress wave) the engine tries `impulse`; if only the W4/W1 overlap rule fails it retries as a `diagonal` (contracting wedge first, then expanding). From the last 3..4 pivots it tries a correction, classified `zigzag` (B < 90% of A) or `flat` (90–138.2%). Anything failing a hard rule is dropped, so `hardRulesPassed` is always `true`.
3. Position follows from the pivot count: 2 → `in-wave-2`, 3 → `in-wave-3`, 4 → `in-wave-4`, 5 → `in-wave-5`, 6 → `complete`; corrections give `in-wave-c` or `complete`. Direction is the move the count implies next: continuation for in-progress impulses, reversal for completed ones, the pre-correction trend for corrections.
4. Invalidation: W1 origin (in-wave-2), W2 extreme (in-wave-3, diagonal in-wave-4), W1 extreme (in-wave-4), W4 extreme (in-wave-5), W5 extreme (complete), 1.618×A projection + 10% of A (in-wave-c), C extreme (complete correction). Entry zones: 50–61.8% of W1, 23.6–38.2% of W3, 1.0–1.618×A from B; `null` elsewhere. Targets: W3 = 1.0–1.618×W1, W5 = W1 or 0.618×(W1+W3), retrace zones after completion.
5. Ids are `${interval}-${pattern}-${firstPivotTime}-${lastPivotTime}`; the same structure seen at several degrees is merged.

## Scoring model

`score = clamp01((0.5·guideline + 0.25·prior + 0.15·momentum + 0.10·degreeAgreement) × multiplier)`

- `guideline` (0..1): weighted band scores for W2 retrace (ideal 50–61.8%), W3 extension (ideal 1.382–1.618×W1), W4 retrace (23.6–38.2% of W3), W5 length (≈W1, ≈0.618×(W1+W3) or ≈0.618×W1), alternation of W2/W4 depth and duration, and one extended wave (≥1.618× the next longest). Only guidelines evaluable on the known waves are scored. Corrections score B retrace and C length.
- `prior`: how much of the structure is confirmed and how tradable the position is (in-wave-2 0.45 … complete 0.8; corrections 0.5/0.6, +0.15 when they follow a rule-valid impulse).
- `momentum` (0.5 neutral): RSI extreme at W1/W3 ends, RSI divergence between W3 and W5 (penalises in-wave-5 longs, supports completion calls), divergence between A and C.
- `degreeAgreement`: 0 / 0.5 / 1 for the structure being detected at 1 / 2 / ≥3 ZigZag degrees.
- `multiplier`: 0.85 for completed-impulse reversal calls, 0.9 in-wave-5, 0.95 in-wave-3, ×0.7 when the first target is already reached.

## Known limitations

- Elliott Wave is under-determined: several rule-valid counts usually coexist (the same three pivots are both "in-wave-3" and "in-wave-c"). The engine reports them all with scores; it does not pick "the" count and cannot resolve the ambiguity from price alone.
- Relabeling: a count is only as stable as its confirmed pivots. Appending non-extreme candles never changes ids, but a reversal confirmation or a new extreme legitimately re-anchors the enumeration, and in-progress candidates (in-wave-2/4/c) disappear or change position as the structure evolves.
- Pivot placement is ZigZag-defined, not analyst-defined; the degrees `[1.5, 3, 6] × ATR` are heuristics, and the coarse degree sees a whole impulse as one leg.
- No sub-wave verification (a "wave 3" is not checked to itself subdivide into five), no triangles, no truncated fifths, no volume. Diagonals only check the wedge shape.
- Momentum uses RSI only; there is no volume or MACD confluence.
- Nothing here has demonstrated out-of-sample edge. Treat scores as a ranking of structural plausibility, not probabilities. `bench.ts` exists so the counts can be logged and later compared against how they were relabeled.
