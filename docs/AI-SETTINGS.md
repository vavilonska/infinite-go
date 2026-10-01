# AI 分析设置与性能边界

本批次源码尚需分别部署，不能仅凭设置页推断某在线站点已有浏览器引擎。

“AI 分析设置”是独立菜单页，打开/关闭不会退出房间或改变执色。现有 HTTP provider 仍是实际可用接入路径。人人对局只显示当前线胜率和全局加权胜负趋势，分析 worker 丢弃建议手、候选和 PV；联机时自动代走被禁用。人机/机机的落子是用户单独启用的能力。

- 模型、后端、线程、下载大小来自 capabilities。未声明的值显示未知；未提供修改协议的模型/线程控件只读，不能假装已切换服务端配置。当前本机桥接明确单分析、单搜索线程。
- 分支并发最多2，并受 provider 声明进一步限制，未声明时为1。手机/低功耗设备优先单分支，操作后等待3–5秒。访问预算当前由服务端设定，不靠前端假控制。
- 普通支持模块 Web Worker 的浏览器将历史摘要、SHA-256 节点哈希与 HTTP 分析传输放到 worker。若 worker 不可用，界面明确显示 HTTP 异步回退；HTTP 路径本身不是本地围棋推理；选择浏览器 provider 才会启用另一个实际计算 Worker。
- 每次状态变更使旧任务失效并取消；落子、同步后的局面优先，分析延后至操作安静期。后台标签页暂停，恢复前台后重新核对状态。并发和取消减少竞争，但不承诺任何硬件零卡顿或零内存影响。
- 服务没有实时 visits/目标推送时，分析条为不定进度，不编造百分比；完成后可显示返回的 visits 和已完成分支数。模型下载使用实际收到字节与响应总量，有总量才显示比例。
- HTTP provider 需要明确黑方胜率视角、完整历史、requestId/nodeId 回显；结果只应用于完全匹配的局面。胜率不是正式比分，也不是新目差终局模式的目差预测。

## Browser engine status

An optional browser provider now uses the reviewed MIT Web KatRain TypeScript search at fixed revision 8dd813aeb565cbdad5215dc75204fc40fd519c50 with TensorFlow.js. It is not original C++ KataGo. Real tiny/b10/b18 single-thread WASM inference was checked on 9/13/19 in a cloud Node environment; the actual provider and UI controller were exercised through a Node Worker transport shim. Physical browser/mobile/WebGPU testing is still outstanding. See [browser engine details and measurements](BROWSER-AI.md).
