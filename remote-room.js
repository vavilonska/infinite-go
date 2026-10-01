// Remote rooms use an explicitly selected HTTPS origin. Credentials never occur
// in URLs, and a client cannot change origin after receiving a room token.
const CODE = /^[A-HJ-NP-Z2-9]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ACTIVE_KEY = 'infinite-go-remote-active';
const PREFIX = 'infinite-go-remote:';

export function remoteEndpoint(value) {
  const text = String(value ?? '').trim();
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(text)) throw new Error('请输入完整 HTTPS 服务地址，只能包含域名和可选端口，不含路径、参数或账号');
  let url;
  try { url = new URL(text); } catch { throw new Error('远程服务地址无效'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('远程服务必须是 HTTPS 源地址，不含账号、路径或参数');
  return url.origin;
}

export function remoteCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!CODE.test(code)) throw new Error('远程房间需要 12 位房间码（不含 I、O、0、1）');
  return code;
}

function credentials(value) {
  if (!value || !TOKEN.test(value.token)) throw new Error('没有有效的本标签页重连凭据');
  return { endpoint: remoteEndpoint(value.endpoint), code: remoteCode(value.code), token: value.token,
    ...(Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}) };
}
function storageKey(endpoint, code) { return PREFIX + encodeURIComponent(endpoint) + ':' + code; }

export function saveRemoteSession(storage, value) {
  try {
    if (!storage) return false;
    const saved = credentials(value);
    storage?.setItem(storageKey(saved.endpoint, saved.code), JSON.stringify(saved));
    storage?.setItem(ACTIVE_KEY, JSON.stringify({ endpoint: saved.endpoint, code: saved.code }));
    return true;
  } catch { return false; }
}

export function loadRemoteSession(storage, endpoint, code, now = Date.now()) {
  try {
    endpoint = remoteEndpoint(endpoint); code = remoteCode(code);
    const saved = credentials(JSON.parse(storage?.getItem(storageKey(endpoint, code))));
    if (saved.endpoint !== endpoint || saved.code !== code || saved.expiresAt <= now) return null;
    return saved;
  } catch { return null; }
}

export function lastRemoteSession(storage, now = Date.now()) {
  try {
    const active = JSON.parse(storage?.getItem(ACTIVE_KEY));
    return loadRemoteSession(storage, active.endpoint, active.code, now);
  } catch { return null; }
}

export function clearActiveRemoteSession(storage) {
  try { storage?.removeItem(ACTIVE_KEY); } catch { /* Private browsing can deny storage. */ }
}

export class RemoteRoomError extends Error {
  constructor(message, { status = 0, retryAfterMs, snapshot, recoverable = false } = {}) {
    super(message); this.name = 'RemoteRoomError'; this.status = status;
    this.retryAfterMs = retryAfterMs; this.snapshot = snapshot; this.recoverable = recoverable;
  }
}

export function reconnectDelay(attempt, random = Math.random) {
  return Math.min(30_000, Math.round(Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, attempt))) * (.8 + .4 * random())));
}

function validSnapshot(data, code) {
  return data && data.code === code && Number.isSafeInteger(data.revision) && data.revision >= 0 &&
    ['A', 'B'].includes(data.seat) && [null, 'B', 'W'].includes(data.role) &&
    Array.isArray(data.game?.lines) && data.game.lines.length > 0;
}

export class RemoteRoomClient {
  constructor({ endpoint, fetchImpl = globalThis.fetch?.bind(globalThis), WebSocketImpl = globalThis.WebSocket,
    setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis), now = Date.now, random = Math.random,
    onSnapshot = () => {}, onStatus = () => {} }) {
    Object.defineProperty(this, 'endpoint', { value: remoteEndpoint(endpoint), enumerable: true });
    this.fetchImpl = fetchImpl; this.WebSocketImpl = WebSocketImpl;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now; this.random = random;
    this.onSnapshot = onSnapshot; this.onStatus = onStatus;
    this.room = null; this.closed = false; this.online = true; this.socket = null;
    this.generation = 0; this.attempt = 0; this.retryTimer = null; this.authTimer = null;
    this.stableTimer = null; this.expiryTimer = null; this.controllers = new Set();
    this.status = 'idle';
  }

  emit(state, detail = {}) { this.status = state; this.onStatus({ state, ...detail }); }

  async request(path, body, token) {
    if (this.closed) throw new Error('远程连接已关闭');
    if (!this.online) throw new Error('当前离线，请联网后重试');
    const generation = this.generation, controller = new AbortController();
    this.controllers.add(controller);
    const timeout = this.setTimer(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(this.endpoint + path, {
        method: body === undefined ? 'GET' : 'POST', mode: 'cors', credentials: 'omit',
        redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let data;
      try { data = await response.json(); } catch { throw new RemoteRoomError('远程服务没有返回有效数据，请确认服务地址或稍后重试', { status: response.status }); }
      if (this.closed || generation !== this.generation) throw new Error('远程连接已关闭');
      if (!response.ok) throw new RemoteRoomError(data.error || '远程服务请求失败', {
        status: response.status, retryAfterMs: Number(data.retryAfterMs) || undefined,
        snapshot: validSnapshot(data, this.room?.code) ? data : undefined, recoverable: data.recoverable === true,
      });
      return data;
    } catch (error) {
      if (this.closed || generation !== this.generation) throw new Error('远程连接已关闭');
      if (error instanceof RemoteRoomError) throw error;
      throw new RemoteRoomError(error.name === 'AbortError' ? '远程请求超时；已提交的操作可能仍然生效，重连后请检查棋局' : '无法连接远程服务，请检查网络、HTTPS 地址或服务额度');
    } finally {
      this.clearTimer(timeout); this.controllers.delete(controller);
    }
  }

  adopt(data) {
    const code = remoteCode(data?.code);
    if (!TOKEN.test(data.token) || !validSnapshot(data, code)) throw new Error('远程服务返回的房间信息无效');
    this.room = { endpoint: this.endpoint, code, token: data.token, expiresAt: data.expiresAt };
    return data;
  }

  async create(options) {
    if (this.room) throw new Error('请先离开当前房间');
    return this.adopt(await this.request('/api/rooms', options));
  }

  async join(code) {
    if (this.room) throw new Error('请先离开当前房间');
    return this.adopt(await this.request('/api/rooms/' + remoteCode(code) + '/join', {}));
  }

  async resume(saved) {
    if (this.room) throw new Error('请先离开当前房间');
    const value = credentials(saved);
    if (value.endpoint !== this.endpoint) throw new Error('重连凭据属于其他服务，请切回原服务地址');
    if (value.expiresAt <= this.now()) throw new Error('远程房间已到期，请导出当前棋局并在同屏模式继续');
    this.room = value;
    try {
      const data = await this.request('/api/rooms/' + value.code, undefined, value.token);
      if (!validSnapshot(data, value.code)) throw new Error('远程服务返回的棋局无效');
      this.room.expiresAt = data.expiresAt;
      return data;
    } catch (error) { this.room = null; throw error; }
  }

  async mutate(kind, body) {
    if (!['actions', 'setup'].includes(kind) || !this.room) throw new Error('远程房间尚未连接');
    if (this.status !== 'connected') throw new Error('正在恢复远程连接，请稍候再操作');
    try {
      const data = await this.request('/api/rooms/' + this.room.code + '/' + kind, body, this.room.token);
      if (!validSnapshot(data, this.room.code)) throw new RemoteRoomError('远程服务返回的棋局无效');
      return data;
    } catch (error) {
      // Never retry a mutation: its response can be lost after the move committed.
      if (error.status === 401 || error.status === 404 || error.status === 410) this.end('房间已失效或无权访问，请导出当前副本');
      else if (!error.status || error.status >= 500 && error.status !== 507) this.reconnect();
      throw error;
    }
  }

  clearSocket() {
    for (const name of ['retryTimer', 'authTimer', 'stableTimer']) { this.clearTimer(this[name]); this[name] = null; }
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* Already closed. */ } }
  }

  start() {
    if (!this.room || this.closed) return;
    if (Number.isFinite(this.room.expiresAt)) {
      this.clearTimer(this.expiryTimer);
      const remaining = this.room.expiresAt - this.now();
      if (remaining <= 0) { this.end('远程房间已到期，请导出当前副本并在同屏模式继续'); return; }
      this.expiryTimer = this.setTimer(() => this.end('远程房间已到期，请导出当前副本并在同屏模式继续'), Math.min(remaining, 2_147_483_647));
    }
    this.openSocket();
  }

  openSocket() {
    if (this.closed || !this.room || !this.online) return;
    this.clearSocket();
    this.emit(this.attempt ? 'reconnecting' : 'connecting');
    let socket;
    try { socket = new this.WebSocketImpl(this.endpoint.replace(/^https:/, 'wss:') + '/api/rooms/' + this.room.code + '/events'); }
    catch { this.retry(); return; }
    this.socket = socket;
    const live = () => !this.closed && this.online && this.socket === socket;
    this.authTimer = this.setTimer(() => { if (live()) this.retry(); }, 12_000);
    socket.onopen = () => { if (live()) { try { socket.send(JSON.stringify({ type: 'auth', token: this.room.token })); } catch { this.retry(); } } };
    socket.onmessage = event => {
      if (!live()) return;
      let data;
      try { data = JSON.parse(event.data); } catch { this.retry(); return; }
      if (data.type === 'error') {
        if ([401, 403, 404, 410].includes(data.status)) this.end('房间已失效或无权访问，请导出当前副本');
        else this.retry(Number(data.retryAfterMs) || 0);
        return;
      }
      if (data.type !== 'snapshot' || !validSnapshot(data.snapshot, this.room.code)) { this.retry(); return; }
      this.clearTimer(this.authTimer); this.authTimer = null;
      if (this.status !== 'connected') {
        this.emit('connected');
        this.stableTimer = this.setTimer(() => { if (live()) this.attempt = 0; }, 10_000);
      }
      this.onSnapshot(data.snapshot);
    };
    socket.onerror = () => { if (live()) this.retry(); };
    socket.onclose = event => {
      if (!live()) return;
      if ([1008, 4004, 4401, 4403, 4404, 4410].includes(event.code)) this.end('房间已失效或无权访问，请导出当前副本');
      else this.retry();
    };
  }

  retry(minimumDelay = 0) {
    if (this.closed || !this.online) return;
    this.clearSocket();
    const delay = Math.max(Math.min(30_000, minimumDelay), reconnectDelay(this.attempt++, this.random));
    this.emit('reconnecting', { delay });
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.openSocket(); }, delay);
  }

  reconnect() {
    if (this.closed || !this.room || !this.online) return;
    this.openSocket();
  }

  setOnline(online) {
    if (this.closed || this.online === online) return;
    this.online = online;
    if (online) this.openSocket();
    else { this.clearSocket(); this.emit('offline'); }
  }

  end(reason) { this.close(); this.emit('ended', { reason }); }

  close() {
    this.closed = true; this.generation++;
    this.clearSocket(); this.clearTimer(this.expiryTimer); this.expiryTimer = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
