# Free choice within independent player rounds

Black and White each have an independent **epoch** (round number) and a frozen set of pending playing leaves. A snapshot includes every currently playing leaf, even if its board is currently waiting for the other color. This prevents someone from skipping a temporarily unavailable board and repeatedly playing only their favorite line.

A move is legal only when both are true:

1. This leaf is still pending in the acting player's current epoch
2. The board itself is to move in that player's color

Within those constraints, choose any timeline in any order. There is no fixed lowest-ID requirement. Completing an action removes that source leaf from the actor's pending set. The opponent can reply immediately if the board and their own pending set allow it.

Example with A and B both starting Black-to-move:

- Black plays A; White can answer A immediately
- Black cannot play A again yet, because Black still owes B
- Black plays B and completes Black's snapshot, starting Black's next epoch
- Black may now play A again, even if White is still finishing White's previous epoch
- White's opportunities remain governed by White's own snapshot, not Black's epoch number

## Finishing a round

When a player's pending set empties, that player advances one epoch and snapshots all current playing leaves. Pending sets do not refill merely because a board becomes available. If no playing leaves remain, empty sets stay empty without advancing in a loop.

Scoring or settled leaves are removed from both pending sets. A disputed board resumed from scoring joins each player's next snapshot. Pruning removes the entire affected subtree from both pending sets, potentially allowing either side to advance.

## Branches and the explicit deadlock exception

A new branch joins **each player's next epoch snapshot**, never a snapshot already in progress. If the branching action empties a player's current set, their newly started next epoch may include the newborn immediately.

Branching consumes the source player's opportunity but leaves the source board on that same player's color. Therefore it would be impossible for the opponent to use a still-pending opportunity on that old source until the actor reaches a later epoch. To prevent two opposite-color branches from freezing one another:

**Only for a branch, defer the opponent's unused current source opportunity to their next epoch as well.**

This exception does not make a move for the opponent, change the old board, skip ordinary replies, or immediately add newborns to an existing set. A regular move never removes the opponent's pending opportunity. An already-used opponent opportunity is unaffected.

## UI and AI

The list and leaf nodes show **● Black can play** or **○ White can play**, plus text. A locked line is red and explains which player must finish their remaining boards. Scoring and settled states use separate labels. The header shows both epoch numbers and remaining pending counts.

Same-screen, LAN and optional AI all use the same engine checks. Human-vs-AI chooses an eligible board for the AI's color, even when another board is available to the human. The prototype AI chooses among its eligible IDs deterministically and does not automatically branch or prune.

## Save compatibility

New exports use format version 2 and preserve both independent snapshots. Import validates IDs, epochs, duplicate pending entries and the derived eligible list.

Version 1 saves preserve boards, histories, weights, scoring results, archives and compensation, but their old fixed-order queue does not encode separate color progress. Import therefore starts fresh per-player snapshots over all playing leaves, using the previous round number as the initial epoch. This is an explicit rules migration, not a claim to reconstruct missing past opportunities.

Before upgrading or refreshing a tab with an unfinished same-screen game, export JSON first. Existing in-memory browser tabs keep their already-loaded rules until reopened; importing their export into the new page performs the migration above. For a self-hosted LAN server, export before restarting because rooms are in memory.
