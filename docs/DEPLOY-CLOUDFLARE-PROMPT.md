# Optional backup deployment / 可选后备部署任务

可将下面的任务交给自己电脑上的编码助手。授权范围是部署本项目免费熟人房间服务；任何账户授权均由账户所有者确认并完成，不应将凭据发送给助手或聊天。

---

请在本机检出 https://github.com/vavilonska/infinite-go 的最新 main，先阅读 docs/CLOUDFLARE.md 和 cloud/wrangler.jsonc。保留所有现有对局、存档和本地修改。

仅在我明确选择自行部署后备服务时，目标是使用我的 Cloudflare Workers Free 部署 HTTPS 双人熟人房间后端。项目公共 GitHub Pages 保持静态，不改默认API；主要在线站点由Sites提供。只用 SQLite Durable Objects 免费档，不买域名、不升级套餐、不添加信用卡、不修改 VPN / 防火墙，不托管 AI，不创建公共匹配大厅。

1. 先运行 npm test，并审查 cloud/ 配置。用官方 npx wrangler@4.145.0 工具；不要另建 API token 或读取、打印、上传登录缓存。若需要登录或持续部署权限授权，暂停让我在本机浏览器亲自完成；不要把密钥或认证文件放进源码、日志输出或聊天。
2. 确认账户当前是 Workers Free。按 docs/CLOUDFLARE.md 部署；若出现付费或超出现有权限的步骤，先停下告诉我。不要仅凭命令成功就声称网页联机可用。
3. 记录部署返回的真实 workers.dev HTTPS origin。检查 /api/health；执行 node cloud/smoke.mjs 真实服务地址。该命令会创建一个固定 24 小时到期的测试房间，不打印重连凭据。
4. 用两个独立浏览器会话打开 https://vavilonska.github.io/infinite-go/，输入同一真实服务地址，创建和加入房间，验证黑白交替落子、两端同步、一次分叉、刷新后恢复、导出 JSON；需要时继续验证猜先与选色。不得把一个浏览器截图冒称两个真实设备已经测试。
5. 全部通过后，返回实际 origin，供我在自定义服务中使用；不要把后备地址改为公共静态版默认值，也不要重写历史。
6. 最后返回真实在线页面和后台 health 链接、部署版本、源码提交、测试结果及任何没有验证的真实设备范围。不返回任何 token、密钥或私有账户资料。如果部署仍被登录、账户权限或免费额度阻止，保留代码和当前游戏，准确报告阻碍。
