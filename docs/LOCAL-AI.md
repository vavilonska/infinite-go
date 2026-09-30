# Optional local KataGo / 可选本机 AI

The portable desktop launcher can download a small, fixed KataGo CPU setup after the local owner reviews its sources, sizes and licenses. The base release contains **no engine binary or neural-network weights**. Ordinary browser guests and the Android companion do not install or run native AI.

## Current supported downloads

Pinned KataGo **1.18.1**, ordinary **Eigen CPU** backend, without an AVX2 requirement. No GPU drivers, package manager, administrator rights, registry entries or persistent background service are installed.

| Desktop target | Official engine ZIP | Small model | Total download |
|---|---:|---:|---:|
| Windows x64 | 5,903,072 bytes | 4,967,720 bytes | 10,870,792 bytes (10.37 MiB) |
| Linux x64 | 41,780,528 bytes | 4,967,720 bytes | 46,748,248 bytes (44.58 MiB) |

Allow at least 300 MiB free disk space for download buffers, extraction and the installed files. The Windows upstream ZIP includes its runtime DLLs. Linux uses the upstream AppImage, built on Ubuntu 22.04, and needs a compatible glibc environment, bash and readlink. The installer runs the **hash-verified AppImage only to extract its own payload**, then launches its bundled `AppRun` so its bundled libraries are available. FUSE is not required.

macOS and ARM are deliberately **manual setup only**: upstream does not publish a portable macOS binary, and these official CPU ZIPs are x64. The automatic installer does not install Homebrew, compilers, Rosetta or emulators. See [upstream macOS guidance](https://github.com/lightvector/KataGo#macos) and connect a separately installed engine via the [bridge instructions](providers.md).

The small `kata1-b6c96-s175395328-d26788732.txt.gz` model is older and intentionally favors download size and CPU speed. It is not the latest or strongest model; it is not a claim of beginner-level play or reliable life-and-death adjudication. The portable launcher's CPU baseline uses 32 visits, one search thread and two Eigen threads. Analysis can still be slow on older devices. Formal game results still require the game's scoring confirmation.

## Using the owner panel

1. Launch the desktop portable bundle. Its initial local browser page has a **本机 AI 设置** button. This control is only present in the launcher-opened owner's page; LAN invitation links contain no installer capability.
2. Review the engine/model download sizes, official source links, license links and integrity explanation. Tick consent and click **下载并安装**. Downloads start only now. The Linux extraction step runs verified upstream code as part of this explicitly approved installation.
3. Wait for installation to finish, then click **启动并连接 AI**. Starting is an explicit, separate action; simply opening the app never starts an engine. The app connects to its new loopback bridge.
4. Use **停止 AI** to close the bridge and engine. Closing the desktop launcher also closes them. The installer does not control an already running external engine.
5. On a later launch, click **启动并连接 AI** again. Installed files are verified and reused with **no network request**, so offline play works.

Cancellation or failed downloads remove only the installer's incomplete staging folder. Retry through the same panel. A digest/size mismatch is an error, never a fallback to unchecked installation. If already-installed files are damaged, stop the app and move that specific local AI installation folder aside before reinstalling. The installer does not erase or silently replace an existing installation. Removing the portable bundle's local AI data folder while the launcher is closed uninstalls these optional files; no system uninstall action is needed.

The owner capability lasts only for that launcher process, is kept in page memory, and is removed from the address bar immediately. Reloading the page loses the owner controls; reopen the desktop launcher to obtain a fresh owner page. Don't share the initial owner-only URL. A LAN guest cannot install, cancel, start or stop engines through the room API.

Respect operating-system security prompts and warnings. This feature does not disable Gatekeeper, antivirus, firewall protections, TLS validation or other security settings. Download failure does not trigger third-party mirrors or automatic system dependency installs.

## Integrity and provenance

Sources checked 2026-09-30:

- [Official v1.18.1 release](https://github.com/lightvector/KataGo/releases/tag/v1.18.1) and its [asset hashes](https://github.com/lightvector/KataGo/releases/expanded_assets/v1.18.1)
- [Official network listing](https://katagotraining.org/networks/) and [model download](https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b6c96-s175395328-d26788732.txt.gz)
- [Engine license](https://github.com/lightvector/KataGo/blob/v1.18.1/LICENSE) and [model license](https://katagotraining.org/network_license/)

SHA256 values are fixed in `local-ai/manifest.js`:

- Windows CPU ZIP: `074485cf150c38aa3bb14ac9f54f2952ffefbceb44673709bbb8a83650bf95d6`
- Linux CPU ZIP: `993b642601e806037003d11e43775e7b4fc65281aed9b9469b7122f18fc16811`
- Small model: `48d6754de3c4754f95bf6a5ca40957a49e5e915aaaeede133a17b9ccf8fa5fcb`

The two engine digests are published by the official GitHub release asset metadata. **The model digest is an Infinite Go pin computed from the official HTTPS download; no separately published upstream model checksum was found.** This detects changed/corrupt downloads against the reviewed bytes, but is not an independently signed model attestation. Updating any artifact requires reviewing its new source, version, size and hash in source code. There is no automatic update channel or caller-supplied download URL.

Both compressed downloads are bounded and verified before extraction. ZIP parsing rejects path traversal, drive paths, symlinks, duplicate names, encrypted archives, unsupported formats and expansion beyond its bound. Engine and model are staged into a new private directory, and only an entirely successful install is atomically made available. A local receipt records every installed file's digest and internal symbolic-link target; all files are checked before starting. This detects accidental damage, not malicious modification by someone who already has write access to the same user's files.

## Desktop integration contract

The installer is **not** part of `npm start`, the static Pages build or the LAN server's routing. Only `packaging/launcher.mjs` imports it.

- Import `createLocalAIManager` from `app/local-ai/manager.js`
- Construct it with `{dataDir, appOrigin, onStart, onStop}`; `dataDir` is an absolute folder outside the static web root
- Bind `manager.server` to **127.0.0.1**, an ephemeral port (`0`)
- Open the owner's local app with fragment `#localAI=<encoded http://127.0.0.1:PORT>&ownerToken=<manager.ownerToken>`; print/share the plain app URL for LAN invitations
- The browser calls `setupLocalAI({onConnect(providerUrl), onDisconnect?})` from `local-ai/panel.js`
- `onStart({bin, model, config})` creates a **new** engine and loopback bridge and returns `{providerUrl, isAlive?}`; `isAlive` can report process health
- `onStop()` closes that bridge and that engine only
- Await `manager.close()` at launcher shutdown; it cancels any installation, waits for in-flight startup, then stops the engine and server

The manager validates loopback socket address, the precise bound Host, exact local app Origin, and a 256-bit random temporary bearer capability. CORS preflight is limited to that owner origin and the JSON/authorization headers. No capability is written to disk or returned by any API. The capability is not an account credential or signing identity. Requests accept no URL, path, executable, configuration, target architecture or custom model inputs.

Authenticated API, all JSON:

- `GET /plan`: fixed local platform plan, byte sizes, sources and integrity/license information; never contacts the network
- `GET /status`: `{state, installed, supported, error, progress, providerUrl?}`
- `POST /install`: exactly `{manifestId, consent: true}`; returns 202 and progresses in the background
- `POST /cancel`: `{}`; cancels the current installation
- `POST /start`: `{}`; verifies files, calls the desktop engine callback, returns its provider URL
- `POST /stop`: `{}`; awaits engine/bridge shutdown

`state` is `idle`, `installing`, `starting`, `running` or `stopping`. `progress` contains `phase`, `downloadedBytes`, `totalBytes`. A second conflicting operation receives 409. Startup and shutdown are coordinated so closing during startup cannot leave an orphan engine.

## Validation

Run `node --test local-ai/*.test.js` (also included by `npm test`). Tests use fake non-executable ZIP/model data and fake HTTPS streams; no downloads or real engine starts occur during the unit suite. Coverage includes target gating, consent, exact-size/SHA failures, approved redirects, ZIP traversal/ambiguity/link/bomb rejection, staging cleanup, offline reuse, changed-file detection, owner capability, CSRF/origin/Host rejection, forbidden URL/path fields, repeated operations, cancellation, and shutdown during startup.

Actual verified upstream Windows and Linux ZIPs were also parsed with this extractor. Windows binary execution and native device UI remain platform-specific acceptance checks; parsing a Windows ZIP on Linux is not a Windows runtime test.

Linux native smoke validation passed in an independent temporary data folder: verified official AppImage extraction, `AppRun version` reporting KataGo 1.18.1 Eigen CPU, installed-file verification, and one offline 9×9 bridge analysis at 32 visits returning a legal move. The download function was disabled for the offline startup check. Its fresh engine and bridge were stopped afterward; the existing trial project was untouched.

A fresh Linux installation was additionally verified end-to-end: official archive/model hash checks, AppImage extraction, installed-file verification, and one legal 9×9 analysis at 32 visits via the bridge. A downloader that deliberately throws confirmed reuse requires no download. The independent test engine and bridge were closed afterward. This does not claim Windows runtime or macOS automatic installation support.
