# 浏览器 AI：构建、模型与验证边界

本地源码已集成可选浏览器 provider，尚不代表任一公开网页已部署。仍可使用现有 HTTP provider；不需要为浏览器分析建立云 AI 服务。

## 构建与运行

在仓库根目录（Node.js 24）：

```sh
npm ci --prefix browser-ai --ignore-scripts
npm --prefix browser-ai run build
npm test
npm start
```

然后在 HTTPS 或 localhost 页面打开“AI 分析设置”，选择浏览器本机分析。GitHub Pages/发行构建工作流会先构建运行时，但本批尚未推送，未触发任何在线部署。运行时约2.7 MiB；模型不随仓库、静态网页或安装包捆绑。可继续只玩普通围棋而不加载模型。普通 HTTP 局域网 IP 页面可能缺少安全上下文 SHA-256，此时不要关闭浏览器安全保护，改用 HTTPS/localhost 或 HTTP provider。

## 来源、规则和模型

搜索实现取自 [Web KatRain 固定版本](https://github.com/Sir-Teo/web-katrain/tree/8dd813aeb565cbdad5215dc75204fc40fd519c50)，MIT 许可，保留在 `browser-ai/UPSTREAM-LICENSE`。这是 TensorFlow.js + TypeScript 重写的 MCTS，**不是原版 C++ KataGo**。适配器将其中国规则预设改为位置超级劫、禁止自杀、无让子补偿，继承全部历史局面；争议续弈清除连续停手计数但保留超级劫历史。正式落子仍由 Infinite Go 棋规再次验证。

- 测试小模型：3,827,339字节（约3.65 MiB），弱模型，适合先验证兼容性；可从固定 GitHub 源直接下载
- b10：11,138,361字节（约10.62 MiB），较轻量旧模型
- b18：97,898,094字节（约93.36 MiB），较大，建议桌面先试；手机可能内存不足

b10/b18官方源未声明浏览器跨域读取权限，首次使用请通过界面的官方链接下载，再选择文件；文件在本机读取，不上传。三个模型都按固定大小和 SHA-256 校验，拒绝其他或被修改的文件。权重尽力缓存，存储额度不足时下次可能需要重新读取。权重许可见官方源；TensorFlow.js/其他运行时许可随构建输出保留。

## 参数和响应性

- 访问数：16至256，16的倍数；默认32
- 每条线搜索时间预算：100至20,000毫秒；默认3,000。单次神经网络计算不能中途切断，所以不是严格墙钟上限
- 推理批量：1至4，默认1；搜索最大子节点：8至64，默认32
- WASM线程：1/2/4；只有跨源隔离且支持共享内存时才能选多线程。普通 Pages 单线程，不修改安全设置
- 后端：WASM、设备支持时的WebGPU或较慢的JS CPU。当前实测是单线程WASM，未测物理手机/WebGPU
- 浏览器引擎同一时刻只分析一条分支；HTTP并发只有服务明确支持时才最多2条
- 棋盘、规则、贴目由游戏传入，不能通过AI高级参数改写。参数变更需重新启用模型；这会取消旧分析和重载模型，不重置对局

分析在Worker运行，前台落子/网络同步优先；后台暂停，操作后等安静期再算。返回结果绑定状态版本和历史哈希，过时结果不落子。内存压力仍可能影响浏览器，不能保证任意设备零卡顿或零系统回收风险。

人人模式只显示胜率和趋势，不提供建议点/PV/候选/代走。AI对弈入口可选择人机或机机，按各条线合法待行方调度、允许暂停；远程人类席位不会被转换成AI。胜率不是目差终局的正式结果。

## 2026-10-01 本地验证

固定源构建和类型检查通过。下表是在共享云端 Node 24 + 单线程 WASM、同一组6手开局、目标16 visits上的测量；13/19路坐标按棋盘大小相应摆放。原版KataGo用相同模型/棋规/局面作数值参照，也为16 visits。不同搜索实现和低访问数会产生差异，**不是棋力等价证明**。

| 模型 | 棋盘 | 实际 visits | WASM 耗时 | WASM 黑胜率 | 原版黑胜率 | 观测 RSS |
|---|---:|---:|---:|---:|---:|---:|
| tiny | 9 | 16 | 0.43s | 39.76% | 45.58% | 136 MiB |
| tiny | 13 | 16 | 0.44s | 49.83% | 50.27% | 151 MiB |
| tiny | 19 | 16 | 1.13s | 49.60% | 49.51% | 156 MiB |
| b10 | 9 | 16 | 0.64s | 34.60% | 33.34% | 174 MiB |
| b10 | 13 | 16 | 0.94s | 46.70% | 46.01% | 193 MiB |
| b10 | 19 | 16 | 2.38s | 49.78% | 49.22% | 203 MiB |
| b18 | 9 | 16 | 6.57s | 9.50% | 9.85% | 670 MiB |
| b18 | 13 | 16 | 10.76s | 38.53% | 36.21% | 732 MiB |
| b18 | 19 | 14 | 22.62s | 45.48% | 45.78% | 856 MiB |

RSS是分析结束后的进程采样，包括测试运行时；不是精确峰值，也不是手机内存需求。b18的19路达到时间预算，只完成14 visits。所有采样结果有限、前5候选均通过本项目合法性校验。

实际小模型还通过了浏览器provider/界面控制器的人机与机机流程：AI只走自己的颜色、两条时间线按当轮资格行动、切换查看不造成错线、连续4手机机交替、暂停/取消、旧请求不回放、人人模式禁止代走。这是在**Node Worker传输适配环境**运行真实WASM模型，并非真实手机或桌面浏览器端到端测试；本批没有发布页面以进行生产测试。

## English

The optional browser provider uses a pinned MIT TypeScript search rewrite with TensorFlow.js, not native C++ KataGo. Models are separate, hash-verified downloads/imports. The actual tiny/b10/b18 models were exercised on 9/13/19 with single-thread WASM in Node and compared to native KataGo at low visits. The provider/controller real-model tests used a Node Worker transport shim. Physical-browser, mobile and WebGPU validation remain outstanding; do not interpret these measurements as mobile performance or native-search equivalence.
