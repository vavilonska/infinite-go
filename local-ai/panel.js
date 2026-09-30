// Browser-only owner panel. Do not expose a capability in markup, logs, storage or LAN URLs.
const size = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
export function setupLocalAI({ onConnect = () => {}, onDisconnect = () => {} } = {}) {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('localAI') && !params.has('ownerToken')) return null;
  const controller = params.get('localAI'), ownerToken = params.get('ownerToken');
  // Remove capability before network requests, links, or any user interaction.
  history.replaceState(history.state, '', location.pathname + location.search);
  let endpoint;
  try { endpoint = new URL(controller); } catch { return null; }
  if (location.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/.test(ownerToken || '')) return null;
  const make = (tag, content, parent) => { const element = document.createElement(tag); if (content) element.textContent = content; parent?.append(element); return element; };
  const wrapper = make('section', '', document.body); wrapper.setAttribute('aria-label', '本机 KataGo 设置');
  wrapper.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10000;max-width:min(420px,calc(100vw - 32px));font:14px/1.5 system-ui;color:#192721';
  const toggle = make('button', '本机 AI 设置', wrapper);
  const pane = make('div', '', wrapper); pane.style.cssText = 'margin-top:8px;padding:18px;background:#fffdf5;border:1px solid #8a9b8b;border-radius:14px;box-shadow:0 8px 32px #0003;max-height:75vh;overflow:auto';
  const heading = make('strong', '可选本机 KataGo · CPU', pane); heading.style.fontSize = '17px';
  make('p', '仅此电脑的启动者可安装或启动。安装一次后可离线使用；关闭桌面启动器会停止本机 AI。', pane);
  const detail = make('p', '正在读取本机下载方案…', pane), links = make('p', '', pane);
  const statusText = make('p', '', pane); statusText.setAttribute('role', 'status'); statusText.setAttribute('aria-live', 'polite');
  const consentRow = make('label', '', pane); consentRow.style.display = 'block';
  const consent = make('input', '', consentRow); consent.type = 'checkbox';
  consentRow.append(document.createTextNode(' 我已查看大小、来源和许可，同意下载并在此电脑解包安装'));
  const controls = make('div', '', pane); controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px';
  const install = make('button', '下载并安装', controls), start = make('button', '启动并连接 AI', controls), stop = make('button', '停止 AI', controls), cancel = make('button', '取消下载', controls), close = make('button', '收起', controls);
  [toggle, install, start, stop, cancel, close].forEach(button => { button.type = 'button'; button.style.cssText = 'border:1px solid #567763;border-radius:8px;padding:8px 12px;background:#f2f5ee;color:#1a3b28;cursor:pointer'; });
  let plan = null, current = null, pending = false, timer = null, disposed = false, connectedURL = '';
  async function request(path, body) {
    const response = await fetch(endpoint.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${ownerToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', redirect: 'error' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
  }
  function render() {
    const busy = pending || ['installing', 'starting', 'stopping'].includes(current?.state);
    install.hidden = !!current?.installed || !plan?.supported; consentRow.hidden = install.hidden;
    install.disabled = busy || !consent.checked; start.hidden = !current?.installed || current?.state === 'running'; start.disabled = busy;
    stop.hidden = current?.state !== 'running'; stop.disabled = busy; cancel.hidden = current?.state !== 'installing'; cancel.disabled = pending;
    const names = { idle: current?.installed ? '已安装，可离线启动' : '尚未安装', installing: '正在下载 / 安装', starting: '正在启动', stopping: '正在停止', running: '本机 AI 已启动' };
    statusText.textContent = current?.error || (names[current?.state] || '');
    if (current?.state === 'installing' && current.progress) statusText.textContent += `：${size(current.progress.downloadedBytes)} / ${size(current.progress.totalBytes)} (${current.progress.phase})`;
  }
  function schedule() { clearTimeout(timer); if (!disposed && !pane.hidden) timer = setTimeout(refresh, current?.state === 'installing' ? 750 : 3000); }
  async function refresh() {
    try { current = await request('/status'); render(); } catch (error) { statusText.textContent = `${error.message}。如启动器已关闭，请重新打开。`; }
    schedule();
  }
  async function action(path, body = {}) {
    if (pending) return; pending = true; let actionError = ''; render();
    try {
      current = await request(path, body);
      if (path === '/start' && current.providerUrl && connectedURL !== current.providerUrl) { await onConnect(current.providerUrl); connectedURL = current.providerUrl; }
      if (path === '/stop') { connectedURL = ''; await onDisconnect(); }
      render();
    } catch (error) { actionError = error.message; }
    finally { pending = false; render(); if (actionError) statusText.textContent = actionError; schedule(); }
  }
  consent.addEventListener('change', render);
  install.addEventListener('click', () => { if (plan?.supported && consent.checked) action('/install', { manifestId: plan.manifestId, consent: true }); });
  start.addEventListener('click', () => action('/start')); stop.addEventListener('click', () => action('/stop')); cancel.addEventListener('click', () => action('/cancel'));
  function hide() { pane.hidden = true; clearTimeout(timer); toggle.focus(); }
  close.addEventListener('click', hide); toggle.addEventListener('click', () => { pane.hidden = !pane.hidden; if (pane.hidden) clearTimeout(timer); else refresh(); });
  pane.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  render();
  (async () => {
    try {
      plan = await request('/plan');
      if (!plan.supported) { detail.textContent = plan.reason; const help = make('a', '官方安装说明', links); help.href = plan.helpUrl; help.target = '_blank'; help.rel = 'noreferrer noopener'; }
      else {
        detail.textContent = `${plan.label} · KataGo ${plan.version}。引擎 ${size(plan.engine.bytes)} + 小模型 ${size(plan.model.bytes)}，总下载 ${size(plan.downloadBytes)}，请预留 ${size(plan.recommendedFreeBytes)}。普通 CPU，无需 GPU 驱动。Linux 会运行已验证的官方程序来解包。小型旧模型偏重体积与速度；强度、评估精度有限。`;
        for (const [label, href] of [['官方引擎下载', plan.engine.url], ['官方模型下载', plan.model.url], ['引擎许可', plan.engineLicenseUrl], ['模型许可', plan.modelLicenseUrl]]) { const link = make('a', label, links); link.href = href; link.target = '_blank'; link.rel = 'noreferrer noopener'; links.append(document.createTextNode(' · ')); }
        make('p', '两项下载均核对固定 SHA256。引擎哈希由上游发布；模型哈希由 Infinite Go 对官方 HTTPS 下载固定记录，并非上游独立签名。无系统安装、后台服务或自动更新。', pane);
      }
      await refresh();
    } catch (error) { detail.textContent = error.message; current = { state: 'idle' }; render(); }
  })();
  return { dispose() { disposed = true; clearTimeout(timer); wrapper.remove(); } };
}
