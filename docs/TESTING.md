# Verification status

## Executed

- Node built-in unit tests: captures, suicide, inherited positional superko, pass exemption, source-preserving branches, threshold boundaries (greater / equal / unlimited), legacy save compatibility, duplicate outgoing edges, fixed-round snapshots, exact fractions beyond floating-point range, dead-group scoring approvals, dispute continuation, save validation, distinct histories sharing a board
- Local HTTP two-client integration tests: room creation, join, role enforcement, private reconnect token, stale and concurrent actions, scoring approvals, invalid input, cross-site requests, static-file boundaries
- JavaScript syntax checks for project modules

`npm test` is the source of truth for the current suite; no package installation is required.

## Not yet verified on actual devices

- Desktop Chromium rendering, viewport overflow, mouse drag and visual polish
- iOS / Android portrait and landscape, touch targets, pinch zoom, mobile browser compatibility
- Real two-device Wi-Fi operation, access-point isolation and local firewall behavior

A browser smoke test was attempted during initial development. The available runtime could not launch Chromium due to system socket restrictions; its managed browser also did not permit the local test URL. These are test-environment blockers, not evidence that rendering passes. No screenshot or real-device success is claimed.

## Manual acceptance checklist

1. Start `npm start`; load on desktop and phone over a trusted LAN
2. In 9 / 13 / 19 boards, preview / cancel / confirm edge and center moves; rotate the phone; check no horizontal page overflow
3. Play two moves; return to move 0; branch with a different Black move. Verify old history remains and weights are 1/2 each
4. Attempt the same branch again; verify rejection without weight changes
5. Test tree node selection, dragging, wheel / pinch zoom and fold / unfold after multiple nested branches
6. Pass twice, mark a dead group, confirm one color, change the group and verify both approvals clear; resume and play again
7. Settle both colors, verify completed count and settled weight; export and import a save
8. Create a room in one browser, join from another, verify out-of-turn denial and reconnect by reloading the same tab
9. Connect an actual provider; verify Black perspective, human / AI role restrictions, pause / resume, missing / stale chart data and manual endgame settlement

AI adapter-specific tests and real-engine verification are documented alongside the provider protocol.

## Initial real-engine check

The optional bridge was checked with an independently started KataGo v1.18.1 process and a small b6c96 model obtained separately. A 64-visit analysis returned an explicit Black-perspective winrate and a legal move. An HTTP move-generation request after pass / pass / resume also returned a legal move, matching request and node IDs, at 16 visits. These are protocol / legality smoke tests, not a playing-strength evaluation or browser end-to-end test. No executable, model, credential, or raw run log is included.
