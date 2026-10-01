# 近 5 分钟活跃对局数

`GET /api/stats` 仅返回计数、时间窗口和统计时间，不返回房间码、席位或恢复凭据。每个站点独立统计；不能用网页1的数字判断网页2是否空闲。

活跃由服务端成功提交的落子（含停一手、分支）、剪枝、争议续弈、死子调整等实际棋局变化产生。创建、加入、恢复同意、计分确认、读取、刷新、观战、AI 分析和失败操作不计入。读取统计不延长棋局或活跃时间。旧版部署前的操作不会被回填。

Cloudflare 复用已有 RoomCreationLimiter 的私有短期字典，最多200个房间键，5分钟淘汰；Sites 复用现有 D1 适配器，不新增数据库表或 Durable Object 迁移。每次符合条件的动作在棋局提交成功后单独报告；生产通过 `waitUntil` 执行，不阻塞或回滚已保存动作。统计故障/配额限制可能造成延迟或少计，因此界面标明“统计可能延迟”。这不是精确在线人数或安全停机保证。

局域网服务器在已有内存房间上检查最近游戏动作时间。首页前台最多每分钟刷新一次；游戏进行中不刷新首页计数。静态 GitHub Pages 不默认向外部房间服务请求统计，提示进入各在线版查看。接口不可用、旧服务或异常响应显示“未知”，不显示推测的零。

This is a bounded, best-effort recent-game-activity count, not presence or an enumerable room directory. Cloudflare/Sites reporting is post-commit and may lag or undercount when unavailable. Never treat a zero count as proof that restarting a service cannot disrupt anyone.
