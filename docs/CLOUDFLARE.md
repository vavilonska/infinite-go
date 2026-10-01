# Cloudflare 免费熟人房间 / Free friend rooms

这是独立于 LAN Node 服务的可选 HTTPS 后端。前端仍在 GitHub Pages，双方用浏览器打开同一网页，选择远程模式和默认朋友房间服务；房主创建房间并私下分享房间码，朋友输入后加入。默认入口不显示后端网址；选择“自定义服务”后才显示 HTTPS 地址输入框，双方需填写同一个已部署的服务地址。无需安装 App、VPN 或玩家账号。没有公共大厅、随机匹配、聊天或托管 AI。

**默认朋友房间服务已于 2026-10-01 部署并验证，使用 Workers Free 与 SQLite Durable Objects。** [在线游戏](https://vavilonska.github.io/infinite-go/) · [后端健康检查](https://infinite-go-rooms.infinite-go.workers.dev/api/health)。已通过真实 HTTP/WebSocket smoke，以及同一电脑 Chrome 和内置浏览器的双会话落子、同步、分叉、刷新恢复与棋局导出验证；尚不代表手机或跨网络真机均已验证。已发布 v0.2.2 Android APK 不包含这次入口；手机先用系统浏览器打开 Pages。旧 APK 的离线和房主地址加入功能不受影响。

旧页面若仍显示“默认服务尚未部署”或连接时停住，请先导出已有对局，再强制刷新（桌面浏览器通常为 Ctrl+Shift+R）。不要为更新页面清除游戏数据。

## 数据与边界

- 服务端复用同一个围棋引擎，验证颜色、轮次、分叉、剪枝、计分与版本；客户端不能上传任意局面覆盖服务器
- 每房间两个席位，以随机重连凭据识别，猜先由服务端生成并在猜测前隐藏。房间码只发给朋友；先拿到码的第二人可以认领空席
- 棋局、角色与隐藏猜先数据保存在部署者的 Cloudflare Durable Object 中。必须信任服务运营者；没有端到端加密或反作弊保证
- 重连凭据仅保存在当前浏览器标签页的 sessionStorage，按服务地址和房间隔离。不要分享开发者工具内容或凭据；导出的棋局 JSON 不含凭据。关闭标签页或清除数据可能失去原席位
- 房间创建后固定 24 小时到期，不因落子延长；到期删除房间数据。请提前导出。平台故障或免费配额耗尽时仍可导出已收到的副本，双方约定转同屏 / LAN 继续
- WebSocket 只传当前房间更新并支持休眠，不使用不断轮询来保持连接。HTTP 动作有版本检查；断线不会自动重发落子
- 为保护免费服务，服务器设独立的请求速率、状态大小和复杂度上限。超限操作明确拒绝且不修改原局面，可导出继续。**这是托管容量限制，不改变“不限制”分叉的棋规或权重**

当前默认托管上限：每房间保存状态 96 KiB、128 条棋线记录（含归档）、所有记录合计 2048 步、单条历史 512 步；每服务每日最多创建 100 房、每个散列地址桶每小时 5 房。地址只映射到固定 256 个桶，碰撞可能共享配额。服务不提供无限容量承诺。

## 部署者准备

使用 [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)；[SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) 可用于免费档。免费配额超出后请求会失败，每日额度按 UTC 零点重置；不要为了继续游戏升级付费或绑定付款方式。免费不等于无限容量或 SLA，也不能防止公开服务遭滥用而提前用尽配额。

官方工具：[Wrangler 安装与更新](https://developers.cloudflare.com/workers/wrangler/install-and-update/)、[Wrangler 登录](https://developers.cloudflare.com/workers/wrangler/commands/#login)、[WebSocket 休眠](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。Wrangler 的登录会授权持续部署访问：由账户所有者在自己的电脑完成登录和同意；不要把登录凭据、API token 或本地认证文件上传到仓库、聊天或公共 CI 日志。

在本仓库根目录，安装 Node.js 22+，执行：

```sh
npm test
npx wrangler@4.145.0 login
npx wrangler@4.145.0 deploy --config cloud/wrangler.jsonc
```

登录与账户选择由本人操作。部署前在 Cloudflare Dashboard 确认 Workers Free，没有购买、付款或套餐升级步骤。若要求付费，停止而不是继续。

配置使用 `new_sqlite_classes` migration，不能改成旧 KV Durable Object。默认允许的网页 origin 是 `https://vavilonska.github.io`；若托管另一个前端，按配置添加它的准确 origin，不用 `*`。房间 API 不接收 Cookie，重连凭据通过 Authorization 或 WebSocket 的首条认证消息传递，不放 URL。

部署命令返回真实 `https://…workers.dev` 地址后，先验证 `/api/health` 返回 `mode: "cloud"` 和 `protocol: 1`。在两份相互独立的浏览器会话中填写这个地址，创建 / 加入房间、交替落子、刷新后点击恢复连接、确认双方看到相同版本。确认非法颜色和旧版本动作被拒绝，并保留 JSON 导出测试。只有完成这些步骤后，才可把实际 origin 写入 `remote-config.js` 的 `DEFAULT_REMOTE_ENDPOINT` 并发布 Pages。

仓库不包含 Cloudflare 账户 ID、token、认证缓存或付费配置。没有 GitHub → Cloudflare 自动部署绑定；开源使用者可以在自己的账户重复上述步骤。

## English

This optional HTTPS Worker backend reuses the authoritative game engine. Two friends use the Pages frontend, select the default friend-room service, then create/join using a private room code. The default interface hides the backend URL; selecting the custom service option reveals the HTTPS address field. No app, VPN, player accounts, matchmaking, chat or hosted AI is required. The default Workers Free service was deployed and verified on 2026-10-01 with a live HTTP/WebSocket smoke test and two browser sessions on one computer, including moves, synchronization, branching, refresh recovery and game export. Mobile devices and separate networks have not been verified. The existing v0.2.2 APK does not include this new entrance; use a mobile browser for now. If an older offline cache still shows an undeployed service or a stuck connection, export your game before a hard refresh; do not clear game data.

Rooms expire 24 hours after creation. Export before expiry or an outage. Credentials are scoped to the endpoint and room in the current tab's sessionStorage, never put into share URLs or game exports. The operator can access game/setup data, so use a trusted service. Whoever first claims the second seat owns it; share codes privately.

Use Workers Free with SQLite Durable Objects and WebSocket hibernation. Free quotas can fail closed; do not upgrade or add payment information to continue play. Public-service abuse can exhaust quotas. Explicit technical state/rate/complexity limits reject operations atomically and preserve the current game for export; they are not a silent change to unlimited branching.

The account owner runs the commands above and personally approves Wrangler login on their computer. Never share tokens or auth caches. Confirm the Free plan before deploying. Use the actual returned workers.dev origin, check `/api/health`, and verify two independent browser clients, legal/illegal moves, reconnect and export before setting `DEFAULT_REMOTE_ENDPOINT`. Keep CORS origins exact. No automatic GitHub account binding or paid resources are configured.
