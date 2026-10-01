# 远程匹配 / Remote matchmaking

远程匹配是匿名休闲对局，不是排位系统。没有账号、聊天、排名或付费服务。双方必须主动选择同一个可信服务，并选择相同棋盘、贴目、分叉门槛、剪枝模式与补偿设置；不同规则不混配，也不会为了缩短等待自动修改规则。

## 使用

首页先选玩法：同屏、AI、局域网、远程朋友或远程匹配，再进入对应设置和棋盘。局域网仍可输入房主地址跳转，也可使用已启动的 Node 服务。朋友房间保留房间码邀请。

匹配页先检查后端能力。**已有朋友房间后端不自动拥有匹配功能**：未升级时会明确提示，不能开始排队。部署者需要先部署新增 Durable Object migration，再验证真实两客户端匹配。

点击开始后进入最多 5 分钟的等待队列。匹配仅发生在相同设置的两位在线参与者之间。对局使用现有猜先流程：加入席位猜单双，猜中者获得选色权，猜错则另一方获得；双方完成选色后开始。

可以取消排队。取消和另一人加入同时发生时，以服务端顺序为准：若已配成对局，返回已有对局而不是重复安排或丢失席位。刷新恢复使用本标签页、同服务的短期队列凭据；凭据不出现在网址或导出的棋局中。网络中断后请恢复原队列状态，不重复创建身份来占多个位置。

匹配成功的对局继承朋友房间的真实服务端校验、24 小时到期、存档导出与容量上限。对手可能断线或离开；本版没有自动判负、惩罚、封禁账户或排名申诉。无需分享私人信息，房间码和重连凭据仍不应公开。

## 站点与部署

GitHub Pages 是静态版本，不默认连接远程 API。主要在线版本（公开地址更新中）使用 Sites 的原生 Worker + D1。前端通过能力检查选择实时 WebSocket 或 HTTP 状态同步，围棋规则使用同一引擎。部署状态未确认前，不将等待页当作可用匹配服务。

### 可选 Cloudflare 后备更新

在已登录的原部署电脑检出最新源码，保留自己的账户设置与本地修改，确认仍是 Workers Free：

```sh
npm test
npx wrangler@4.145.0 deploy --config cloud/wrangler.jsonc
```

这次部署新增匹配队列的 SQLite Durable Object migration。不要删除或改写已有 `v1` migration，否则可能破坏现有房间；不要改为旧 KV 后端，不升级套餐。登录或新增账户授权由账户所有者亲自完成，不把凭据发聊天或提交仓库。

部署后 `/api/health` 必须明确报告 `features.matchmaking: true`。仅有 HTTP 200 或旧 `protocol: 1` 不能证明匹配已部署。随后用两份独立浏览器会话测试相同规则配对、不同规则等待、取消、刷新恢复、猜先选色、交替落子和 JSON 导出；检查没有重复配对。记录实际部署版本和源码 SHA 后再宣称线上匹配可用。

匹配只使用免费档容量，并设额外排队与请求限制；额度耗尽可能暂时停止匹配。原棋规“不限制”不代表免费后端无限容量。可以导出已收到的对局转本地继续。服务运营者可访问棋局、网络地址与凭据，仍需选择可信部署。

## English

Choose a mode first, then use its focused setup and board. Casual anonymous matchmaking pairs only identical board/rule/komi/branch/pruning settings. It does not adjust rules while waiting and adds no accounts, chat, ranking or paid service. Matches use the existing nigiri flow: the guess winner chooses a color.

Queue entries expire after five minutes. Cancellation and matching are serialized; a cancellation that loses the race returns the already assigned room rather than creating a second match or losing the seat. Temporary queue credentials are scoped to the selected service and browser tab, never placed in URLs or game exports. Use the original credentials to recover after a lost response.

GitHub Pages is the static edition with no default remote API. The primary online edition uses native Sites Worker + D1. The shared frontend negotiates the supported room transport. Optional Cloudflare backup deployments need the new SQLite Durable Object migration. Run the commands above on the owner's already authenticated computer, keeping Workers Free and preserving existing migrations. The health endpoint must advertise `features.matchmaking: true`; an old health response is insufficient. Verify two independent clients, matching/mismatched rules, cancel, reconnect, nigiri, moves and export before calling it live.

Assigned games retain authoritative legality, 24-hour expiry and explicit capacity limits. There is no automatic forfeit, account moderation or ranking guarantee if an opponent leaves. Export games before expiry or an outage. The service operator can access game and connection data; use a trusted service.
