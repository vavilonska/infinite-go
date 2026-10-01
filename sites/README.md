# Native online edition / 原生在线版

Public online entrance: [https://infinite-go-online.vavilonska7.chatgpt.site](https://infinite-go-online.vavilonska7.chatgpt.site).

The repository's GitHub Pages build stays static with no default game API. This separate build uses a native Worker + D1 backend and its own same-origin API. It reuses `engine.js`, `nigiri.js` and the authoritative room/matchmaking code under `cloud/`; there is no second implementation of the game rules. The Cloudflare Durable Object adapter is retained as an optional backup.

## Build and test

Use Node.js 24 for native SQLite tests and these optional build tools. The ordinary offline/LAN project still has no npm runtime dependencies.

```sh
npm ci --prefix sites
npm test
npm --prefix sites test
npm --prefix sites run build
```

Output is `sites/dist/client` (shared frontend) and `sites/dist/server` (Worker). Only the online build sets `DEFAULT_REMOTE_ENDPOINT` to the page's own origin. The repository's `remote-config.js` remains empty for the static edition and contains an explicit online-edition navigation link.

A hosting deployment must supply the `ASSETS` static binding and `DB` D1 binding, apply the SQL migration from `drizzle/`, and publish both together. The generated database ID is a placeholder, not an account identifier or credential. Each owner supplies their own registration metadata and bindings through their host; private `.openai` registration files are excluded from version control. Building locally does not deploy or change a cloud account.

The server accepts its own origin and the exact GitHub Pages origin. It advertises `transport: "polling"` and matchmaking capability only through its real health endpoint. Clients authenticate snapshots/actions with a room credential, poll every four seconds, pause in the background and never replay a mutation automatically. Authentication credentials never belong in URLs or exported games.

## Persistence and concurrency

D1 rows use atomic revision compare-and-swap. Room state transitions commit together; competing writes retry from the authoritative state, preserving stale-game revision rejection. Match claims and quota receipts are durable/idempotent across retry boundaries; cancellations cannot silently assign a second opponent. Room tokens are generated server-side and distinct for the two seats.

All existing room and matchmaking request/size/rate limits still apply. Room access expires after 24 hours. Expired records are rejected on access; physical cleanup of cold rows is opportunistic after retention, rather than a promise of exact deletion at the expiry instant. Hosts should monitor storage and platform quotas. Offline or quota failure does not change the board rules: export the last received game and continue locally if needed.

## Verification

Local native SQLite tests cover concurrent joins, stale simultaneous moves, independent room reload, four-way pairing, cancellation races and eight-way request accounting. Live deployment verification is separate from those tests; see `docs/TESTING.md` and the deployment report for actual checks. This does not imply every phone/network has been tested.

## 中文

在线版使用原生 Worker + D1，前端与棋规完全复用仓库代码；GitHub Pages 保持不默认连接 API 的静态版，通过明确链接打开在线版。编译产物只给在线站点设置同源服务地址，不将后备地址公开为默认入口。

D1 通过原子版本比较提交房间状态，并保留匹配认领、取消与配额的幂等记录。过期对局不能继续访问；后台冷记录按保留期机会清理，不保证到期时刻立即物理删除。所有资源上限会明确返回错误，不更改“不限制”分叉的棋规。

部署需要托管方提供 ASSETS / DB 绑定并执行迁移，编译本身不会登录、部署或创建付费资源。不要提交注册文件、令牌或私钥。Node 24 的本地 SQLite 并发测试与实际公网双客户端验收是不同检查，不冒称真机已验证。

Build dependencies retain their original licenses: drizzle-orm Apache-2.0; drizzle-kit and esbuild MIT. Their packages include upstream license texts. Project source remains AGPL-3.0-only, copyright 2026 vavilonska.
