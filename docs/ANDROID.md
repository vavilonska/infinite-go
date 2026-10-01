# Android APK · 无限围棋

原生 Java WebView 外壳，包含同一份网页和规则引擎。**离线同屏无需网络、账户、订阅或房主电脑**；联机时直接打开可信房主提供的完整页面，不从离线 HTTPS 页面跨域调用 HTTP 后端。

## 安装和使用

本 App 使用 Java + 系统 WebView，APK 不包含按 CPU 架构分发的原生 `.so` 库，因此只需一个通用 `infinite-go.apk`，无需分别下载 ARM64 / ARMv7 / x86 版本。仍需满足下述 Android 与 WebView 版本要求。

- 需要 Android 8.0（API 26）或更新版本，并保持 Android System WebView / Chrome 更新。游戏使用现代 JavaScript（包括 BigInt、structuredClone）；旧 WebView 即使系统版本符合，也可能无法运行
- 下载已经签名的 `infinite-go.apk`，由你在系统提示中决定是否允许该下载来源安装。**`infinite-go-unsigned.apk` 不能直接安装**。不要关闭 Play Protect 或绕过安全警告
- 打开即为离线同屏：规则、分叉、自由选线、猜先、实验剪枝、计分均来自根目录共享代码，没有 Android 专用的第二套规则
- 页面「导出 JSON」会打开系统保存位置选择器；「导入 JSON」打开系统文件选择器。取消选择不会覆盖当前棋局。保存上限与网页一致为 10 MB
- **棋局不是自动持久化的**。退出、切换页面、卸载、升级或系统回收前请导出；重新打开后导入 JSON。普通旋转由 Activity 自行处理，不主动重载页面，但不能替代导出备份

## 连接房主

1. 房主在电脑运行 `npm start`，在电脑页面创建房间
2. 手机与电脑连接同一可信 Wi-Fi，或双方自行配置并授权的虚拟局域网
3. 点 Android 顶部「连接房主」，输入例如 `192.168.1.20:8000`、`10.147.20.3:8000`，或含 `?room=房间码` 的完整地址
4. 不写协议时使用 HTTP，不写端口时补为 8000；明确写 `http://` 或 `https://` 时遵循协议默认端口
5. 在加载的页面点「加入房间」。单个可加入房间可不填房间码；多个房间需指定房间码
6. 房主服务和虚拟网络须持续在线。点顶部「离线同屏」可返回应用内页面，切换前会提示导出

HTTP 仅接受规范 IPv4 私网地址：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`，另支持常见覆盖网络使用的 `100.64.0.0/10`。HTTP 域名、回环地址、公网地址以及 HTTP IPv6 当前不支持；域名或公网自部署必须用有效证书的 HTTPS。`localhost` 指的是手机本身，不是房主电脑。地址栏禁止用户名、密码、片段和特殊协议。

本应用不启动 Android 房主服务器，不内置 VPN、KataGo、AI 模型或收费服务，也不替你安装其他软件或更改防火墙。完整虚拟局域网教程见 [REMOTE-PLAY.md](REMOTE-PLAY.md)。APK 外壳将网络请求限定到当前页面 origin；跨 origin AI provider 不属于此版本支持范围。

## 构建无签名 APK

在 Linux / GitHub Actions Ubuntu runner 上使用：

- Node.js 22+
- 完整 JDK 17 或更新版本（需要 `javac` 和 `jar`）
- 官方 Android SDK Platform 36、Build Tools 36.0.0
- Bash、`zip`、`sha256sum`
- `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`）指向 SDK

使用已经安装并接受所需 SDK 许可的开发环境：

```sh
sdkmanager 'platforms;android-36' 'build-tools;36.0.0'
npm test
bash android/build.sh
```

如果安装工具要求首次接受许可，请自行阅读并决定是否接受 [Android SDK 许可](https://developer.android.com/studio/terms)。脚本不会自动接受许可、下载不明工具或创建签名身份。

输出：

```text
android/build/infinite-go-unsigned.apk
android/build/infinite-go-unsigned.apk.sha256
```

`android/build/` 为可重新生成、被 Git 忽略的目录。构建脚本调用根目录 `scripts/build-static.mjs`，当次复制前端产物及同一图标到 APK assets/resources；不维护永久重复的前端源码。APK 不包含生成的 `sw.js`；本地包已离线，避免额外 service-worker 缓存影响升级和请求路由。网页注册失败由共享前端正常忽略。AAPT2 编译资源，`javac` 编译 Java，D8 生成 DEX，`zipalign` 对齐 APK。无需 Gradle、Maven、AndroidX 或第三方运行库。

默认 `minSdk=26`、`targetSdk=36`、版本号以 `android/AndroidManifest.xml` 为准。将来更新发行版时应提升版本号与 `versionCode`；更新前不要改变应用 ID `org.infinitego.app` 或签名身份。`ANDROID_PLATFORM`、`ANDROID_BUILD_TOOLS` 环境变量可选择已安装的编译工具，但不会隐式修改 manifest 的兼容性声明。

官方文档：[命令行构建](https://developer.android.com/build/building-cmdline)、[AAPT2](https://developer.android.com/tools/aapt2)、[D8](https://developer.android.com/tools/d8)。

## 持久签名与可安装版本

所有可安装 APK 都必须签名。仓库和构建脚本**不生成任何默认、临时或调试密钥**。发布者需自行创建、妥善离线备份持久签名 keystore，并保管密码。后续覆盖安装须继续使用同一签名身份；丢失私钥通常意味着无法升级已有安装，只能换应用或卸载后重新装，卸载可能丢失数据。

不要将 keystore、密码、Base64 内容发到聊天、issue、构建日志或提交到 Git。Base64 只是编码，不是加密。若使用 GitHub Actions，发布者亲自在仓库的 Actions Secrets 中配置：

- `ANDROID_KEYSTORE_BASE64`：既有 keystore 的 Base64 内容
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码
- `ANDROID_KEY_ALIAS`：该签名密钥的 alias
- `ANDROID_KEY_PASSWORD`：该 alias 的私钥密码

这会授予获得这些 Secrets 的可信发行工作流签名能力；保护仓库写入权限、发行 workflow 和依赖 action，不向不受信任的 PR 暴露 Secrets。**无上述 Secrets 时只提供明确标注的无签名构建**。如果之前已发布无签名版本，配置 Secrets 后需提高版本号并发起新的发行，不要假定重跑旧版会替换已经发布的资产。

已由用户配置秘密的可信 CI 任务中：

```sh
bash android/build.sh
bash android/sign.sh
```

签名脚本从环境变量读取这四项，只把 keystore 临时解码到 runner 临时目录，在退出时删除；不把密钥放到产物目录、不打印密码，也不新建密钥。它生成并验证：

```text
android/build/infinite-go.apk
android/build/infinite-go.apk.sha256
```

签名脚本不要使用 `bash -x`，不要缓存临时目录，不要上传整个 runner 或 workspace。常规文件删除不保证在持久磁盘上的安全擦除；推荐短生命周期的托管 runner，持久 keystore 由发布者在其他地方安全备份。

私钥创建、保管、首次配置 Secrets 和安装均由发布者/设备所有者操作，仓库不会代办。官方说明：[Android 应用签名](https://developer.android.com/studio/publish/app-signing)、[apksigner](https://developer.android.com/tools/apksigner)、[GitHub Actions 加密 Secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)。

### Windows：自己创建并备份签名身份

以下命令供你在自己的 Windows PowerShell 中执行；开发助手和仓库脚本不会替你运行。只需安装 JDK，不需要为了签名身份安装 Android Studio。

1. 从 [Microsoft Build of OpenJDK 官方下载页](https://learn.microsoft.com/en-us/java/openjdk/download)安装 Windows 对应架构的 JDK 21 LTS。安装时启用命令行 PATH，重新打开 PowerShell。先运行 `keytool -help` 确认工具可用
2. 选择一个仓库外、非公共共享的目录。以下示例放在你的用户目录；**如果已有正式 keystore，就继续使用旧文件，不要重新生成**

```powershell
$KeyDir = Join-Path $env:USERPROFILE 'InfiniteGoSigning'
New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
$KeyFile = Join-Path $KeyDir 'infinite-go-release.jks'
if (Test-Path $KeyFile) { throw '文件已存在；请先确认它是否就是需要保留的正式签名身份，不要覆盖' }
keytool -genkeypair -v -storetype JKS -keystore "$KeyFile" -alias infinite-go -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Infinite Go'
```

3. `keytool` 会交互式要求输入及确认 keystore 密码，输入时不显示字符。使用独立强密码并存入你的密码管理器。询问 alias 私钥密码时可按 Enter 使用同一密码；此时两个 GitHub password Secrets 都填同一个密码。命令本身不含密码，不会把密码写进 PowerShell 历史。证书使用项目名，不必写家庭地址等私人身份信息
4. **先备份** `.jks` 文件到你自己控制的安全位置；如你选择 Google Drive，由你亲自上传到仅自己可访问的位置，不分享公开链接。建议再留一个离线备份。密码另存于密码管理器，不与 keystore 放在同一共享文件夹。保存 alias `infinite-go`，以后发行继续使用这份文件
5. 打开 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret。由你亲自新增上面列出的四项 Secrets。`ANDROID_KEY_ALIAS` 填 `infinite-go`；两个密码项按第 3 步设置。只在准备粘贴 `ANDROID_KEYSTORE_BASE64` 时运行：

```powershell
$KeyFile = Join-Path $env:USERPROFILE 'InfiniteGoSigning\infinite-go-release.jks'
[Convert]::ToBase64String([IO.File]::ReadAllBytes($KeyFile)) | Set-Clipboard
```

6. 此命令只把 Base64 放进剪贴板，不把私钥内容显示到终端。立即粘贴到 `ANDROID_KEYSTORE_BASE64` 的 Secret 字段并保存。**不要粘贴到聊天、issue 或普通 repository variable**。完成后清空当前剪贴板：

```powershell
Set-Clipboard -Value ''
```

如果 Windows 开启了剪贴板历史或跨设备同步，当前剪贴板清空并不等于清除了历史副本；在复制前自行决定是否临时关闭，完成后通过系统剪贴板设置检查并删除该敏感历史项。不要让录屏、剪贴板管理器或共享桌面记录该内容。

7. Secrets 保存后，打开 GitHub Actions → Build portable desktop and Android release → Run workflow，**先保持 `publish` 不勾选**。这次仅验证、构建和签名，不创建或替换 Release；成功后在该次运行的 Artifacts 下载 `android`，解压取得 `infinite-go.apk`。确认可用后，如需公开正式发布签名包，先提高版本号并发起勾选 `publish` 的**新版本发行**。无签名旧版的既有发布资产不会自动变成可安装版。第一次安装前与后续升级前都保留棋谱 JSON 备份

GitHub 保存后不会回显 Secret 值；这不是 keystore 备份方式。丢失本地文件和离线备份时，不能指望从 GitHub 页面下载恢复私钥。Windows 命令依据 [JDK keytool 官方文档](https://docs.oracle.com/en/java/javase/21/docs/specs/man/keytool.html)；Secret 设置依据 [GitHub 官方说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

## 安全边界

- 唯一 manifest 权限是 `INTERNET`。没有存储全盘权限、摄像头、麦克风、位置、联系人或 VPN 权限；不自动备份应用数据
- 本地 assets 映射到固定 HTTPS origin，缺失文件直接返回 404，不回退到外网。禁用 `file://` / `content://` 页面访问、文件 URL 跨域能力、第三方 cookies、WebView 调试及混合内容
- 不使用 `addJavascriptInterface`。导出只短暂读取当前页面生成的同 origin blob，经大小和 JSON 检查后交给系统保存位置选择器；导入仅将用户选择的文件交给现有游戏校验
- native 地址入口验证 scheme、host、port 和 origin。外部 HTTPS 链接须用户确认后交给系统浏览器；证书错误一律取消，设备权限请求一律拒绝
- 为支持用户自选私有 IP，manifest 允许 HTTP cleartext。WebView 另行限制导航与资源的当前 origin，并始终使用 `MIXED_CONTENT_NEVER_ALLOW`；这不是关闭混合内容保护。HTTP 本身没有加密和服务器身份保证，请只连接可信设备及网络，不公开转发游戏端口
- 房主提供的网页代码属于你信任的房主；不要将壳当作任意恶意网站的完全网络沙箱。房主服务、WebView 实现及操作系统仍是信任边界
- 官方当前说明中，target SDK 36 的本地网络访问通过 `INTERNET` 获得；升级 target 到 37 需重新实现本地网络运行时权限流程。不会为连接失败擅自扩大权限或绕过系统限制

设计参考：[WebView 加载本地内容](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)、[URI 验证](https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading)、[原生桥风险](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)、[本地网络权限](https://developer.android.com/privacy-and-security/local-network-permission)。

## 验证清单

`android/build.sh` 在构建前运行纯 Java host-address 回归测试，覆盖默认端口、合法私网/VPN 网段、HTTPS、房间查询参数及危险 scheme、账号密码、伪私网域名、错误地址与端口。

发行前还需真实设备或模拟器检查；通过编译不能替代以下验证：

1. 飞行模式首次打开，落子、分叉、切线、计分、旋转不丢局
2. 导出 JSON → 在系统选择保存位置 → 退出重开 → 导入 → 历史、权重与剪枝账本一致
3. 取消导入/导出；连续点导出；返回键取消退出；切换页面取消；文件选择期间切换/恢复
4. 连接 LAN / 覆盖网络私网地址；单房间直接加入、多房间指定；网络中断提示与恢复
5. HTTP 公网、特殊协议、带账号密码 URL、跨 origin 页面、无效 HTTPS 证书被阻止
6. 由同一正式签名 key 的旧版覆盖安装，并先导出备份；验证 `apksigner verify --verbose` 与 SHA-256

本地源码检查和 host-address 测试不代表已完成真机触摸、系统选择器、VPN 或安装升级测试。请以发行记录列出的实际验证结果为准。
