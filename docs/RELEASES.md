# 下载、免安装运行与手机

发行页：https://github.com/vavilonska/infinite-go/releases

## 电脑 portable 包

选择对应 Windows x64、macOS Intel (x64)、macOS Apple Silicon (arm64) 或 Linux x64 压缩包。**这是免安装 portable 包，不是已签名 / 公证的安装器**。包中带官方 Node.js 运行时与第三方许可，不需要单独安装 Node 或 npm。KataGo 和模型不随基础包捆绑。

1. 完整解压，保留目录结构
2. Windows 运行 `Start-Infinite-Go.cmd`；macOS 打开 `Start-Infinite-Go.command`（若系统允许）；Linux 在解压目录运行 `./Start-Infinite-Go.sh`
3. 默认浏览器打开游戏。终端显示本机与局域网地址，保留窗口；关闭窗口 / Ctrl+C 停服。若浏览器没有自动打开，手动打开终端的地址
4. 房主创建房间。朋友可以用任意兼容浏览器打开房主地址，也可在公开静态页填房主 IP 和端口后跳转；**访客不用安装 App**。虚拟局域网同理
5. 停服前导出对局；房间仅存在内存中

默认监听 `0.0.0.0:8000`。可通过环境变量 `HOST` / `PORT` 改为本机或指定接口，`IG_NO_BROWSER=1` 关闭自动开浏览器。不会改防火墙、VPN或路由；不要开放公网端口。不保证老系统兼容，请遵守官方 Node 对平台的要求。

所有包在对应 GitHub 托管系统用**包内**运行时启动服务器并检查网页 / API / 图标。此自动测试不等于真实桌面安装、OS 安全信任或真机局域网测试。下载后若系统提示风险，请核对来源并遵循系统保护，不要禁用安全检查；本项目没有付费签名或 Apple 公证。

`SHA256SUMS.txt` 用于核对发行包完整性。Node 下载自官方 HTTPS，构建时核对官方 `SHASUMS256.txt`，其许可证保留在 `runtime/NODE-LICENSE`。项目源码是同一 Release 标签自动提供的 Source code 压缩包。

## 可选本机 AI

Windows / Linux x64 的 portable 启动器会在自动打开的本机浏览器提供所有者设置面板。先查看下载大小、官方来源与许可，确认后下载并核对 SHA256，再点启动并连接。Mac / ARM 暂不提供自动安装。管理端与 AI bridge 仅 loopback，LAN/手机访客不能触发下载、启动或共享房主 AI。手动 provider 入口保留。详见 [LOCAL-AI.md](LOCAL-AI.md)。

## Android

Android App 内置同一网页引擎，可离线同屏，也可打开房主地址联机；不在手机运行 Node/KataGo。详见 [Android 构建、签名和文件说明](ANDROID.md)。

Android 必须签名后才可安装。若发行附件名称含 `unsigned`，它是供用户私下签名的构建产物，**不能直接安装**。不会用临时测试密钥冒充正式发行身份。长期私钥由项目所有者自己生成、保管并安全备份，不能公开进仓库。签名配置完成前不声称安装版已交付。

## iPhone / iPad

用 Safari 打开 https://vavilonska.github.io/infinite-go/ ，分享 → 添加到主屏幕。首次联网完成资源缓存后，可离线同屏玩。这是网页 App，不是原生 IPA，不需要本项目注册 Apple 开发者账户。

静态页面仍可输入房主地址并打开其提供的完整网页。HTTP 局域网页面不一定具备 PWA 安装或离线缓存能力；联网房间、AI 需要自己的后端。PWA 离线缓存不保存棋局，仍需主动导出 JSON。更新资源不会自动重载正在进行的游戏；导出后关闭该站所有页面，再重新打开以接收新版本。

## English quick start

Download the appropriate **portable** desktop archive from Releases, extract it completely and run the included Start script. The official Node runtime is bundled; no separate installation is needed. These are not signed/notarized installers. Keep the terminal open while hosting and export games before stopping. Browser guests do not need an app: open the host's LAN/VPN URL directly, or enter its address on the public Pages entrance.

The Android wrapper bundles offline same-screen play and host joining. An `unsigned` APK is **not installable** until privately signed by the owner; see ANDROID.md. iPhone/iPad use Safari → Share → Add to Home Screen, with offline play after the initial successful cache. No native iOS package or paid enrollment is included.

CI smoke-tests each desktop package with its bundled runtime on its target OS. This does not prove end-user installation, physical-device networking or OS trust. Check SHA256SUMS and respect security warnings. Engines/models remain optional separate downloads.
