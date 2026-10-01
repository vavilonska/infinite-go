# Online frontend and room Worker

This optional online edition runs on Cloudflare Workers Free with **SQLite-backed Durable Objects** and Workers Static Assets. It imports the same `engine.js` and `nigiri.js` as local/LAN play and serves the existing full frontend. It supports private friend rooms and anonymous rule-matched games, with no accounts, public room directory, chat, ranking, or hosted AI service. The local game and its unlimited-branch rules do not depend on this backend.

## Configure and run

From the repository root, use Node.js 24 and the verified official Wrangler version:

```sh
node cloud/build.mjs
npx wrangler@4.145.0 dev --config cloud/wrangler.jsonc
npx wrangler@4.145.0 deploy --dry-run --config cloud/wrangler.jsonc
npx wrangler@4.145.0 deploy --config cloud/wrangler.jsonc
```

Deployment requires the owner's Cloudflare account and authorization. There are no credentials in this directory. Keep the account on Workers Free to retain its fail-on-quota behavior; this configuration is not a spending cap for a Paid account. Free quotas can be shared with other Workers in the same account.

The config preserves two SQLite Durable Object classes in the `v1` migration and adds the queue in `v2`:

- `ROOMS` → `GameRoom`, one object per random room code
- `ROOM_CREATION` → `RoomCreationLimiter`, one bounded creation quota object
- `MATCHMAKING` → `MatchmakingQueue`, the bounded anonymous rule-matching queue (`v2`)

Do not rename these migrations, recreate existing classes or delete stored rooms to deploy an update.

`ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS origins. The repository's Pages origin, `https://vavilonska.github.io`, and the request's own origin are allowed. Wildcards, paths, `null` origins, and credentialed wildcard CORS are not supported. Native clients may omit `Origin`. Browser credentials/cookies are not needed.

`cloud/build.mjs` rebuilds only `cloud/dist` from the shared static whitelist. Generated remote configuration uses `location.origin`; root `remote-config.js` remains unchanged. `online-entry.js` forwards `/api` and `/api/*` (including room WebSockets) to the existing authority and other requests to `ASSETS.fetch`. API routes run before assets and never fall back to HTML. The generated service worker leaves API requests, including navigations, on the network. Missing static files return 404. Sites and public Pages behavior are preserved. See [Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

Cloudflare's default HTML handling redirects `/index.html` to `/`. The online service worker precaches and matches the directly served root `./` for navigation, avoiding cached redirected responses. This policy is part of the online cache version hash, so normal service worker updates replace the old cache. Export first, then close all tabs for this site and reopen to activate an update; clearing user site data is unnecessary. See [HTML canonicalization](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/).

An official esbuild installation can also produce one ES module for deployment tooling:

```sh
esbuild cloud/online-entry.js --bundle --format=esm --platform=browser --outfile=.build/cloud-worker.js
```

Bundling alone does not provision the Durable Object bindings or SQLite migration; deployment still needs the configuration above. No Node compatibility flag or npm runtime dependency is required.

## Protocol

`GET /api/health` returns `{ "ok": true, "mode": "cloud", "protocol": 1, "features": { "matchmaking": true } }` when the matchmaking binding is enabled.

REST follows the LAN API shapes:

- `POST /api/rooms`: the existing game/color settings; returns seat A and its reconnect token
- `POST /api/rooms/:code/join`: `{}`; claims seat B and returns its reconnect token
- `GET /api/rooms/:code`: latest authenticated snapshot
- `POST /api/rooms/:code/actions`: existing `play`, `toggleDead`, `approveScore`, `resume`, or `prune` action and revision
- `POST /api/rooms/:code/setup`: existing nigiri `guess`/`choose` action and revision

Room codes are 12 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (60 random bits), case insensitive. They are invitations: anyone who knows an unoccupied room code can claim its second seat. Reconnect tokens contain 256 random bits and authenticate using the `Authorization: Bearer ...` header. Store them only on the participant's device; never share them as invitations. The service rejects URL query parameters and never returns another player's token.

Snapshots retain `code`, `seat`, `role`, `revision`, `game`, `setup`, and `players`, with added `expiresAt` (Unix milliseconds) and `limits`. Nigiri stone counts stay hidden until revealed. `409` revision conflicts include the latest snapshot scoped to the authenticated seat. All state transitions, including concurrent joins, are serialized and committed before a success reply.

WebSocket upgrade: `GET /api/rooms/:code/events`. The first text message, within 15 seconds, must be:

```json
{ "type": "auth", "token": "the participant's reconnect token" }
```

After successful authentication and after each committed change, the socket receives:

```json
{ "type": "snapshot", "snapshot": { "code": "...", "seat": "A", "revision": 1 } }
```

The abbreviated example omits the snapshot's other fields. HTTP remains the mutation channel. No snapshot is sent to unauthenticated sockets. Hibernation attachments contain only the authenticated seat, or the pending authentication deadline. Reconnecting with the same token returns the latest snapshot. There are no application heartbeat timers or polling loops in the Worker.

## Free-service limits and recovery

Rooms expire **24 hours after creation**, even while active. Reads and reconnects do not renew them. Durable Object alarms close sockets and delete all room state and rate counters; requests also enforce expiry if an alarm is delayed. Cloudflare quota exhaustion or platform downtime may delay physical cleanup. Export before expiry; the service does not retain an archive or account recovery.

Current transport capacity from `room-state.js`:

| Limit | Value |
| --- | --- |
| Persisted room JSON | 96 KiB UTF-8, including both private tokens |
| Combined current and archived timeline records | 128 |
| Combined moves across all stored timeline histories | 2,048 |
| Moves in any one stored history | 512 |
| Request / WebSocket message | 4 KiB |
| HTTP requests per room | 120 per fixed minute |
| Action/setup attempts per seat | 30 per fixed minute |
| Open sockets per room | 8 |
| Pending unauthenticated sockets | 4 |
| Authenticated sockets per seat | 2 |
| Authentication deadline | 15 seconds |
| Room creations across deployment | 100 per UTC day |
| Room creations per address hash bucket | 5 per fixed hour |

Current and archived histories count separately, including repeated prefixes; resignation archives may therefore count a record twice. These are hosting limits, not additional game rules. In particular, `branchLimitExponent: null` stays `null`.

A rejected mutation never replaces the last committed game. Capacity failures return HTTP `507`, `errorCode: "ROOM_RESOURCE_LIMIT"`, `recoverable: true`, and the last authenticated snapshot. Storage failures return a recoverable `503` with the last snapshot when available. The snapshot's `code` always remains its room code. A client can export `game` using the existing Infinite Go JSON format and continue locally. Keep the latest client snapshot, because account-level/platform failures may happen before application code can return a recovery response.

Rate failures return `429`, `retryAfterMs`, and the `Retry-After` header. Rate counters persist through hibernation. The creation limiter stores at most 256 short hourly bucket counters plus a daily counter; it hashes the edge-supplied IP address with a daily rotation and never persists the raw address. Hash collisions share a quota. These bounds reduce accidental usage and simple abuse; a public endpoint still consumes Cloudflare requests when rejecting traffic and cannot guarantee availability under attack or exhausted account quotas.

## Verify

```sh
node --test test/cloud-worker.test.js test/cloud-online.test.js test/cloud-matchmaking.test.js
node cloud/smoke.mjs http://127.0.0.1:8787
node cloud/matchmaking-smoke.mjs http://127.0.0.1:8787
```

Unit/integration tests mock storage and socket plumbing while using the real shared game engine. The smoke script requires a running Worker runtime and exercises actual HTTP/WebSocket clients. Local success does not verify a public deployment or its account permissions.

Check the deployed `/` page and its JS/CSS/icons, same-origin default service, health capability and two independent browser clients for friends, matching, refresh/reconnect and export before publishing a second-site link. The smoke scripts consume creation quota; one successful complete pass is enough. Sites remains the primary online edition, and its rooms/queue are separate from Cloudflare: friends must choose the same site. Never publish a placeholder backup link or treat an API-only endpoint as a playable page.

Official references: [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Free-plan quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/).
