# 只读观战 / Read-only spectating

此功能需要更新后的前端和对应房间服务，源码准备完成不代表任何在线站点已部署。

在局域网或远程朋友页面输入房间码，点“观战”。不会占黑白席位，可选择时间线、查看历史和导出当前副本；无法落子、分叉、剪枝、标死子、确认计分、续弈或修改开局规则。离开观战只断开自己的观看，不影响玩家。刷新后重新输入房间码即可；不会覆盖本标签页已有玩家凭据。

- 观战端只调用 `GET /api/rooms/:code/watch`，不创建或读取玩家恢复凭据。棋局更新约每 5 秒拉取，后台暂停、恢复前台刷新；离线和暂时失败会等待重连，不重放动作。
- 服务端仅此路径允许凭房间码读取公开棋局。所有修改路径继续要求真实玩家凭据；POST 观战路径会拒绝。响应不含玩家 token、隐藏猜先数量或运营者资料。
- 房间码是观看权限边界，知道码的人可以观战；不要公开不愿被旁观的房间码。此版本没有私人观战邀请名单。空席位仍可被知道码的人通过独立的“加入”流程认领，与原有朋友房间规则相同。
- 局域网码为 6 位、远程码为 12 位。没有全站房间列表；朋友需使用同一个网页 / 服务。
- 每个房间所有观战请求合计最多每分钟 30 次（不是每位观众 30 次），多人同时看可能限流并延迟刷新。Cloudflare / Sites 还沿用每房总请求、状态大小及过期限制；不会自动扩容或收费。观战不延长房间寿命。
- 旧服务可能返回“不存在或尚不支持观战”，不会退回“加入”而误占席位。

## 发布范围

Node 需更新并在适当时机重新启动；Cloudflare 需本地重新打包前端并部署 Worker；Sites 需重新构建并部署对应前后端。应在当前对局结束后安排，不在玩家对局中强制刷新或重启。GitHub Pages 本身不能提供房间数据。

## English

Enter a room code and choose Spectate. The viewer polls a dedicated read-only snapshot endpoint without acquiring a seat or receiving player credentials. All mutation endpoints still require a player credential. Viewers can inspect timelines/history and export a local copy; leaving only closes their own view. Knowing the room code permits viewing, and the existing empty-seat joining rule remains unchanged.

Polling runs about every five seconds, pauses in the background and backs off on failures. A shared room limit of 30 spectator reads per minute may delay multiple viewers. Existing room expiration and cloud resource limits still apply. Spectating does not extend the room lifetime or fall back to joining on unsupported servers. Both frontend and the selected backend must be updated; deployment should be scheduled after ongoing games end.
