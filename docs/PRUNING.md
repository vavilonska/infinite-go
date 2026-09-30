# Experimental subtree pruning

Configure one mode at game creation: **none** (default), **resign**, or **komi compensation**. Changing the next-game controls does not change a game already in progress. The LAN server validates the same rules as the local engine. AI currently never chooses pruning automatically.

## Target and turn

On the current round's active leaf, select a historical node and prune its full-history prefix subtree. All current leaves beginning with that exact prefix are included, regardless of their parent ID or board similarity.

- Only the player whose turn it is on the current source leaf can prune
- Root pruning, pruning every unsettled board, and a subtree containing any settled descendant are forbidden
- Pruning consumes the source's current round action. All pruned IDs leave that round's queue
- The source and every affected leaf are archived with their original histories and weights; the archived history route cannot be recreated through a later branch or ordinary move
- A preview identifies the affected leaves, total original weight and consequence before confirmation

## Resign mode

All target leaves are settled as actual wins for the pruning player's opponent. Their total weight **W** counts in the formal match result. Other weights do not change. These are actual resignation outcomes, not AI evaluations. Settled archived leaves remain visible and frozen.

## Komi-compensation mode

Choose **C = 8, 32, 256, or custom**. C is a finite decimal rational, at least 1 and at most 1,000,000,000,000, with at most 12 fractional decimal digits. Exponential notation, fractions typed with `/`, zero, negatives, NaN and Infinity are not accepted. Arithmetic rules use exact integers/rationals, not floating comparisons.

The theoretical minimum new-leaf weight is `0.5 / C`. The actual minimum is the **smallest dyadic bucket greater than or equal to that value**:

`w_min = 2^(-floor(log2(2*C)))`

The implementation finds the bucket using exact rational comparisons. It does not evaluate a floating-point logarithm. A split is legal only when **parentWeight / 2 >= w_min**. This replaces the independent manual branch threshold in komi mode; other modes retain the manual threshold.

Examples:

| C | Actual minimum newborn weight | Raw minimum compensation | Rounded half-point compensation |
|---|---|---|---|
| 8 | 1/16 (6.25%) | 0.5 | 0.5 |
| 32 | 1/64 (1.5625%) | 0.5 | 0.5 |
| 256 | 1/512 (0.1953125%) | 0.5 | 0.5 |
| 20 | 1/32 (3.125%) | 0.625 | 1 |

For pruning a subtree with original exact weight W:

1. Require the **raw** product `C*W >= 0.5`. Rounding cannot make an undersized subtree eligible
2. Compensation is `delta = ceil(2*C*W) / 2` points
3. If Black prunes, add delta to White's komi. If White prunes, subtract delta from White's komi
4. Apply this change to **every remaining unsettled leaf**, not just the current source's siblings
5. If the unsettled total before pruning is A, each surviving unsettled leaf with weight x receives `x*A/(A-W)`
6. Settled leaves keep their original weights, results and frozen komi

A signed exact **match-level cumulative komi ledger** records every compensation. Rewinding a historical node cannot remove that ledger, and a new branch inherits the current total. If a still-unsettled leaf was awaiting scoring, a compensation change clears its previous score approvals. Removed komi-pruned leaves do not receive a formal winner; they are archived separately, and their weight is redistributed exactly.

Remaining weights may cease to be powers of two after redistribution. The minimum bucket is dyadic; the actual weight comparisons and redistribution remain exact rational arithmetic. Export/import preserves modes, C, archived routes, settlement snapshots and the cumulative ledger. Older save files without pruning fields load with pruning disabled.

## Important limitations

This is experimental pricing, not a theorem equating komi and win probability. Repeated split/prune cycles are not guaranteed to terminate. Formal win weights remain separate from AI forecasts. KataGo only evaluates individual current histories using their effective komi, not the whole multiverse strategy. If cumulative komi exceeds an engine's supported range, that provider can refuse analysis while human play remains possible.
