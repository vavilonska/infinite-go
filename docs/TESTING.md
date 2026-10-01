# Verification status

## Executed

- Node built-in unit tests: captures, suicide, inherited positional superko, pass exemption, source-preserving branches, threshold boundaries (greater / equal / unlimited), legacy save compatibility, duplicate outgoing edges, independent per-player snapshots, immediate replies, repeat-turn locking, opposite-branch deadlock prevention, exact fractions beyond floating-point range, dead-group scoring approvals, dispute continuation, save validation, distinct histories sharing a board
- Local HTTP two-client integration tests: room creation, join, role enforcement, private reconnect token, stale and concurrent actions, scoring approvals, invalid input, cross-site requests, static-file boundaries
- JavaScript syntax checks for project modules

`npm test` is the source of truth for the current suite; no package installation is required.

## Not yet verified on actual devices

- Detailed viewport overflow, mouse / touch drag and full visual polish
- iOS / Android portrait and landscape, touch targets, pinch zoom, mobile browser compatibility
- Real two-device Wi-Fi operation, access-point isolation and local firewall behavior

A browser smoke test was attempted during initial development. The available runtime could not launch Chromium due to system socket restrictions; its managed browser also did not permit the local test URL. After GitHub Pages deployment, the managed cloud browser successfully loaded the actual public page and verified preview / confirm moves, history navigation and a source-preserving 1/2 + 1/2 branch. This is a desktop browser smoke test, not a real-mobile or full gesture/layout pass.

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

The deployed pruning update was additionally checked in the cloud desktop browser: the C20 field showed actual 1/32 (3.125%), raw 0.625 points and rounded 1 point; a test prune changed the surviving weight from 1/2 to 1 and effective komi from 7.5 to 17.5, with a +10 ledger entry.

## Optional Cloudflare friend rooms

The source includes a Workers Free / SQLite Durable Object adapter. The full Node suite passes 107 tests, including server-authoritative room actions, simultaneous seat claims and same-version writes, concealed nigiri, storage failure rollback, expiry, resource/rate limits, hibernation state and origin-locked remote client reconnect behavior.

A local official Cloudflare workerd runtime was exercised with two independent Node HTTP/WebSocket clients: create/join, alternating moves, server rejection of wrong-color and stale actions, exactly one successful concurrent same-version write, pushed snapshots and credential-based reconnect passed. This is a local runtime integration test, not proof of public Cloudflare deployment or two physical phones. The cloud browser blocks localhost access, so local pixel QA was unavailable. The GitHub static edition keeps its default remote endpoint empty. The Cloudflare adapter is now optional backup; the separate Sites edition uses its own API.

## Mode menu, matchmaking and native Sites edition

The final shared source suite passes 144 tests, including the original rules, Cloudflare adapter, exact-rule matchmaking, scoped/cancellable client tickets, capability-selected HTTP polling and four native SQLite concurrency tests. The native online-edition build and static artifact build both complete. The app DOM harness exercises all five modes, local move/back/resume, settings retention and an old backend's disabled matchmaking state.

The pre-existing public friend service was separately exercised from two cloud-browser tabs: create/join, Black D4 and White F6 synchronized both ways. A standalone Node WebSocket smoke timed out in this cloud environment, so it is not used as evidence against that successful browser check.

The Sites backend has separate deployment and live API verification. GitHub Pages carries no default public API; its online link opens the Sites edition. Physical phones, independent real networks and installed Android updates are not implied by these checks.
