import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../engine.js';
import { remoteEndpoint, remoteCode, saveRemoteSession, loadRemoteSession, lastRemoteSession,
  clearActiveRemoteSession, reconnectDelay, RemoteRoomClient } from '../remote-room.js';

const ENDPOINT = 'https://rooms.example';
const CODE = 'ABCDEFGH2345';
const TOKEN = 'a'.repeat(43);
const NOW = 100_000;
const HEALTH = { ok: true, mode: 'cloud', protocol: 1 };
const POLLING_HEALTH = { ...HEALTH, transport: 'polling', features: { matchmaking: true } };
const snapshot = (revision = 0) => ({ code: CODE, seat: 'A', role: 'B', revision,
  game: createGame(), setup: null, players: { B: true, W: false }, expiresAt: NOW + 86_400_000 });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function harness(fetchOverride, health = HEALTH) {
  const timers = new Map(), sockets = [], requests = [], statuses = [], snapshots = [];
  let nextTimer = 0;
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; }
    open() { this.onopen?.(); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    disconnect(code = 1006) { this.onclose?.({ code }); }
  }
  const client = new RemoteRoomClient({ endpoint: ENDPOINT, WebSocketImpl: Socket,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/api/health')) return typeof health === 'function' ? health(url, init) : response(health);
      return fetchOverride ? fetchOverride(url, init) : response({ ...snapshot(), token: TOKEN });
    },
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimer: id => timers.delete(id), now: () => NOW, random: () => .5,
    onStatus: status => statuses.push(status), onSnapshot: data => snapshots.push(data),
  });
  const run = id => { const timer = timers.get(id); assert.ok(timer); timers.delete(id); timer.fn(); };
  return { client, timers, sockets, requests, statuses, snapshots, run };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test('remote endpoints require an explicit HTTPS origin, without credentials or hidden path/query', () => {
  assert.equal(remoteEndpoint(' https://ROOMS.example:443/ '), ENDPOINT);
  assert.equal(remoteEndpoint('https://rooms.example:8443'), 'https://rooms.example:8443');
  for (const value of ['', 'rooms.example', 'http://rooms.example', 'https://user:pass@rooms.example',
    'https://rooms.example/api', 'https://rooms.example/?token=secret', 'https://rooms.example/#x',
    'https://rooms.example/a/..', 'https://rooms.example/\\evil.example', 'https://rooms.example\n.evil',
    'javascript:alert(1)', 'https://rooms.example?']) assert.throws(() => remoteEndpoint(value), value);
  assert.equal(remoteCode(CODE.toLowerCase()), CODE);
  for (const value of ['', 'ABC234', 'ABCDEFGHIJKL', '../actions', CODE + '?token=x']) assert.throws(() => remoteCode(value));
});

test('tab credentials are scoped to exact endpoint and code and never reused for another origin', () => {
  const store = storage(), saved = { endpoint: ENDPOINT, code: CODE, token: TOKEN, expiresAt: NOW + 1000 };
  assert.equal(saveRemoteSession(store, saved), true);
  assert.deepEqual(loadRemoteSession(store, ENDPOINT + '/', CODE, NOW), saved);
  assert.equal(loadRemoteSession(store, 'https://other.example', CODE, NOW), null);
  assert.equal(loadRemoteSession(store, ENDPOINT, 'ABCDEFGH2346', NOW), null);
  assert.equal(loadRemoteSession(store, ENDPOINT, CODE, NOW + 1000), null);
  assert.deepEqual(lastRemoteSession(store, NOW), saved);
  clearActiveRemoteSession(store);
  assert.equal(lastRemoteSession(store, NOW), null);
  assert.deepEqual(loadRemoteSession(store, ENDPOINT, CODE, NOW), saved);
  assert.equal(saveRemoteSession(null, saved), false);
  assert.equal(saveRemoteSession({ setItem() { throw new Error('Storage blocked'); } }, saved), false);
});

test('create has no existing token; REST auth stays in headers and websocket auth in the first message', async () => {
  const h = harness();
  await h.client.create({ size: 9 });
  assert.equal(h.requests[0].url, ENDPOINT + '/api/health');
  assert.equal(h.requests[0].init.headers.Authorization, undefined);
  assert.equal(h.requests[0].init.credentials, 'omit');
  assert.equal(h.requests[0].init.redirect, 'error');
  assert.equal(h.requests[1].url, ENDPOINT + '/api/rooms');
  assert.equal(h.requests[1].init.headers.Authorization, undefined);
  h.client.start();
  const socket = h.sockets[0];
  assert.equal(socket.url, 'wss://rooms.example/api/rooms/' + CODE + '/events');
  assert.ok(!socket.url.includes(TOKEN));
  assert.deepEqual(socket.sent, []);
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'auth', token: TOKEN }]);
  socket.message({ type: 'snapshot', snapshot: snapshot() });
  assert.equal(h.client.status, 'connected');
  await h.client.mutate('actions', { type: 'play', revision: 0 });
  assert.equal(h.requests[2].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.ok(!h.requests[2].url.includes(TOKEN));
  assert.equal(h.requests[2].url, ENDPOINT + '/api/rooms/' + CODE + '/actions');
  h.client.close();
  assert.equal(h.timers.size, 0);
});

test('default browser timers retain the global receiver across requests and connection cleanup', async t => {
  const timers = new Map();
  let nextTimer = 0;
  t.mock.method(globalThis, 'setTimeout', function (fn, delay) {
    assert.ok(this === globalThis, 'Browser setTimeout requires the global receiver');
    const id = ++nextTimer;
    timers.set(id, { fn, delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', function (id) {
    assert.ok(this === globalThis, 'Browser clearTimeout requires the global receiver');
    timers.delete(id);
  });
  const client = new RemoteRoomClient({ endpoint: ENDPOINT, now: () => NOW,
    fetchImpl: async url => response(url.endsWith('/api/health') ? HEALTH : { ...snapshot(), token: TOKEN }),
    WebSocketImpl: class { close() {} },
  });
  await client.create({});
  assert.equal(timers.size, 0, 'Completed HTTP requests release their timeout');
  client.start();
  assert.equal(timers.size, 2, 'Expiry and socket authentication deadlines are scheduled');
  client.close();
  assert.equal(timers.size, 0, 'Leaving the room clears all browser timers');
});

test('resume refuses credentials for another endpoint before any fetch', async () => {
  const h = harness();
  await assert.rejects(h.client.resume({ endpoint: 'https://other.example', code: CODE, token: TOKEN }), /其他服务/);
  assert.equal(h.requests.length, 0);
  assert.throws(() => { h.client.endpoint = 'https://other.example'; }, TypeError);
  await h.client.resume({ endpoint: ENDPOINT, code: CODE, token: TOKEN });
  assert.equal(h.requests[0].url, ENDPOINT + '/api/health');
  assert.equal(h.requests[0].init.headers.Authorization, undefined);
  assert.equal(h.requests[1].url, ENDPOINT + '/api/rooms/' + CODE);
  assert.equal(h.requests[1].init.headers.Authorization, 'Bearer ' + TOKEN);
  h.client.close();
});

test('reconnect backoff is bounded, authenticates every socket, and ignores stale socket callbacks', async () => {
  const h = harness(); await h.client.create({}); h.client.start();
  const old = h.sockets[0], staleOpen = old.onopen, staleMessage = old.onmessage, staleClose = old.onclose;
  old.disconnect();
  assert.equal(h.statuses.at(-1).delay, 1000);
  h.run(h.client.retryTimer);
  staleOpen(); staleMessage({ data: JSON.stringify({ type: 'snapshot', snapshot: snapshot(99) }) }); staleClose({ code: 1008 });
  assert.equal(old.sent.length, 0);
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.client.status, 'reconnecting');
  const fresh = h.sockets.at(-1); fresh.open(); fresh.message({ type: 'snapshot', snapshot: snapshot(1) });
  assert.equal(h.snapshots[0].revision, 1);
  fresh.disconnect(); assert.equal(h.statuses.at(-1).delay, 2000);
  for (let i = 0; i < 8; i++) { h.run(h.client.retryTimer); h.sockets.at(-1).disconnect(); assert.ok(h.statuses.at(-1).delay <= 30_000); }
  assert.equal(reconnectDelay(100, () => 1), 30_000);
  h.run(h.client.retryTimer); h.sockets.at(-1).open(); h.sockets.at(-1).message({ type: 'snapshot', snapshot: snapshot(2) });
  h.run(h.client.stableTimer); h.sockets.at(-1).disconnect();
  assert.equal(h.statuses.at(-1).delay, 1000);
  h.client.close();
});

test('unanswered websocket authentication times out; offline and close cancel pending work', async () => {
  const h = harness(); await h.client.create({}); h.client.start();
  h.run(h.client.authTimer); assert.equal(h.client.status, 'reconnecting');
  h.client.setOnline(false); assert.equal(h.client.status, 'offline'); assert.equal(h.client.retryTimer, null);
  const count = h.sockets.length;
  h.client.reconnect(); assert.equal(h.sockets.length, count);
  h.client.setOnline(true); assert.equal(h.sockets.length, count + 1);
  h.client.close(); h.client.setOnline(false); h.client.setOnline(true); h.client.reconnect();
  assert.equal(h.sockets.length, count + 1); assert.equal(h.timers.size, 0);
});

test('expiry and rejected websocket credentials stop reconnection without discarding the snapshot', async () => {
  const h = harness(); await h.client.create({}); h.client.start();
  h.sockets[0].message({ type: 'snapshot', snapshot: snapshot() });
  h.run(h.client.expiryTimer);
  assert.equal(h.client.status, 'ended'); assert.equal(h.snapshots.length, 1); assert.equal(h.timers.size, 0);
  const rejected = harness(); await rejected.client.create({}); rejected.client.start();
  rejected.sockets[0].message({ type: 'error', status: 401 });
  assert.equal(rejected.client.status, 'ended'); assert.equal(rejected.timers.size, 0);
  const expired = harness(); await expired.client.create({}); expired.client.start();
  expired.sockets[0].disconnect(4004);
  assert.equal(expired.client.status, 'ended'); assert.equal(expired.timers.size, 0);
});

test('HTTP completion after leaving a room cannot create a session or open a socket', async () => {
  let complete;
  const h = harness(() => new Promise(resolve => { complete = resolve; }));
  const creating = h.client.create({});
  await flush();
  h.client.close(); complete(response({ ...snapshot(), token: TOKEN }));
  await assert.rejects(creating, /关闭/);
  assert.equal(h.client.room, null); assert.equal(h.sockets.length, 0); assert.equal(h.timers.size, 0);
});

test('resource limits and stale revisions preserve authoritative error snapshots without retrying moves', async () => {
  for (const status of [409, 507]) {
    let calls = 0;
    const h = harness(() => ++calls === 1 ? response({ ...snapshot(), token: TOKEN }) : response({ ...snapshot(3), error: 'limit or stale', recoverable: true }, status));
    await h.client.create({}); h.client.start(); h.sockets[0].message({ type: 'snapshot', snapshot: snapshot() });
    await assert.rejects(h.client.mutate('actions', { revision: 0 }), error => error.status === status && error.snapshot.revision === 3 && error.recoverable);
    assert.equal(calls, 2); assert.equal(h.client.status, 'connected'); h.client.close();
  }
});

test('lost action responses reconnect for a fresh snapshot and never automatically resubmit', async () => {
  let calls = 0;
  const h = harness(() => { if (++calls > 1) throw new TypeError('Lost response'); return response({ ...snapshot(), token: TOKEN }); });
  await h.client.create({}); h.client.start(); h.sockets[0].message({ type: 'snapshot', snapshot: snapshot() });
  await assert.rejects(h.client.mutate('actions', { type: 'play', revision: 0 }), /无法连接/);
  assert.equal(calls, 2); assert.equal(h.sockets.length, 2); assert.notEqual(h.client.status, 'connected');
  h.client.close();
});

test('transport discovery is explicit, rejects incompatible health, and retains legacy WebSocket support', async () => {
  const h = harness(undefined, POLLING_HEALTH);
  assert.equal(h.requests.length, 0);
  h.client.start(); h.client.reconnect();
  assert.equal(h.requests.length, 0, 'A client without a selected room never makes background requests');
  await assert.rejects(h.client.join('invalid'), /房间码/);
  assert.equal(h.requests.length, 0);
  await h.client.join(CODE);
  assert.equal(h.client.transport, 'polling');
  assert.deepEqual(h.requests.map(item => item.url), [ENDPOINT + '/api/health', ENDPOINT + '/api/rooms/' + CODE + '/join']);
  h.client.close();

  for (const health of [{ ...HEALTH, protocol: 2 }, { ...HEALTH, transport: 'unknown' }, { ...HEALTH, ok: false }]) {
    const rejected = harness(undefined, health);
    await assert.rejects(rejected.client.create({}), /协议不兼容/);
    assert.equal(rejected.requests.length, 1, 'An incompatible service receives no room mutation');
    assert.equal(rejected.client.room, null);
    rejected.client.close();
  }
  const unavailable = harness(undefined, () => response({ error: 'unavailable' }, 503));
  await assert.rejects(unavailable.client.create({}), /unavailable/);
  assert.equal(unavailable.sockets.length, 0, 'Failed discovery does not fall back to a guessed transport');
  unavailable.client.close();
});

test('polling requires its first authenticated snapshot and schedules one refresh at a time', async () => {
  let complete;
  const h = harness((url, init) => init.method === 'POST' ? response({ ...snapshot(), token: TOKEN }) :
    new Promise(resolve => { complete = resolve; }), POLLING_HEALTH);
  await h.client.create({});
  h.client.start();
  assert.equal(h.client.status, 'connecting');
  assert.equal(h.sockets.length, 0);
  const poll = h.requests.at(-1);
  assert.equal(poll.url, ENDPOINT + '/api/rooms/' + CODE);
  assert.equal(poll.init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(poll.init.credentials, 'omit');
  assert.equal(poll.init.redirect, 'error');
  assert.equal(poll.init.cache, 'no-store');
  assert.ok(!poll.url.includes(TOKEN));
  await assert.rejects(h.client.mutate('actions', {}), /恢复远程连接/);
  assert.equal(h.requests.filter(item => item.init.method === 'POST').length, 1);
  complete(response(snapshot())); await flush();
  assert.equal(h.client.status, 'connected');
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.timers.get(h.client.pollTimer).delay, 4_000);
  assert.equal(h.timers.size, 2, 'Only expiry and the next poll are scheduled');
  h.run(h.client.pollTimer);
  assert.equal(h.client.pollTimer, null, 'A slow response cannot overlap another scheduled poll');
  complete(response(snapshot(1))); await flush();
  assert.equal(h.snapshots.at(-1).revision, 1);
  assert.equal(h.timers.size, 2);
  h.client.close();
  assert.equal(h.timers.size, 0);
});

test('polling preserves a newer action revision when an older in-flight snapshot completes', async () => {
  let reads = 0, complete;
  const h = harness((url, init) => {
    if (url.endsWith('/actions')) return response(snapshot(2));
    if (init.method === 'POST') return response({ ...snapshot(), token: TOKEN });
    if (++reads === 1) return response(snapshot());
    return new Promise(resolve => { complete = resolve; });
  }, POLLING_HEALTH);
  await h.client.create({}); h.client.start(); await flush();
  h.run(h.client.pollTimer);
  const action = await h.client.mutate('actions', { revision: 0, type: 'play' });
  assert.equal(action.revision, 2);
  complete(response(snapshot(1))); await flush();
  assert.deepEqual(h.snapshots.map(data => data.revision), [0], 'The delayed poll cannot publish a stale game');
  h.run(h.client.pollTimer); complete(response(snapshot(3))); await flush();
  assert.deepEqual(h.snapshots.map(data => data.revision), [0, 3]);
  h.client.close();
});

test('poll failures use bounded backoff, honor rate limits, and recover with a fresh snapshot', async () => {
  let failure = true;
  const h = harness((url, init) => init.method === 'POST' ? response({ ...snapshot(), token: TOKEN }) :
    failure ? response({ error: 'busy' }, 503) : response(snapshot(1)), POLLING_HEALTH);
  await h.client.create({}); h.client.start(); await flush();
  assert.equal(h.statuses.at(-1).delay, 1_000);
  for (let attempt = 1; attempt < 9; attempt++) {
    h.run(h.client.retryTimer); await flush();
    assert.equal(h.statuses.at(-1).delay, Math.min(30_000, 1_000 * 2 ** attempt));
    assert.equal(h.client.pollTimer, null);
    assert.equal(h.timers.size, 2);
  }
  failure = false; h.run(h.client.retryTimer); await flush();
  assert.equal(h.client.status, 'connected');
  assert.equal(h.client.attempt, 0);
  h.client.close();

  for (const [retryAfterMs, delay] of [[12_000, 12_000], [60_000, 30_000]]) {
    const limited = harness((url, init) => init.method === 'POST' ? response({ ...snapshot(), token: TOKEN }) :
      response({ error: 'rate limited', retryAfterMs }, 429), POLLING_HEALTH);
    await limited.client.create({}); limited.client.start(); await flush();
    assert.equal(limited.statuses.at(-1).delay, delay);
    limited.client.close();
  }
});

test('offline, pause, repeated reconnect, and close invalidate in-flight polls and cannot spawn duplicate loops', async () => {
  const pending = [];
  const h = harness((url, init) => init.method === 'POST' ? response({ ...snapshot(), token: TOKEN }) :
    new Promise(resolve => pending.push({ resolve, signal: init.signal })), POLLING_HEALTH);
  await h.client.create({}); h.client.start();
  h.client.setOnline(false);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(response(snapshot(50))); await flush();
  assert.equal(h.client.status, 'offline');
  assert.equal(h.snapshots.length, 0); assert.equal(h.client.pollTimer, null);
  h.client.reconnect(); assert.equal(pending.length, 1);
  h.client.setOnline(true); assert.equal(pending.length, 2);
  h.client.setPaused(true);
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(response(snapshot(51))); await flush();
  assert.equal(h.client.status, 'paused');
  h.client.setOnline(false); h.client.setOnline(true); h.client.reconnect();
  assert.equal(pending.length, 2, 'Coming online while paused does not restart requests');
  h.client.setPaused(false); assert.equal(pending.length, 3);
  h.client.reconnect(); assert.equal(pending.length, 4);
  assert.equal(pending[2].signal.aborted, true);
  pending[3].resolve(response(snapshot(2))); await flush();
  pending[2].resolve(response(snapshot(99))); await flush();
  assert.equal(h.client.status, 'connected');
  assert.deepEqual(h.snapshots.map(data => data.revision), [2]);
  assert.equal(h.timers.size, 2);
  h.run(h.client.pollTimer); assert.equal(pending.length, 5);
  h.client.close();
  assert.equal(pending[4].signal.aborted, true);
  pending[4].resolve(response(snapshot(100))); await flush();
  h.client.setOnline(true); h.client.setPaused(false); h.client.reconnect();
  assert.equal(pending.length, 5); assert.equal(h.snapshots.length, 1); assert.equal(h.timers.size, 0);
});

test('polling resume and matchmaking adoption negotiate the same endpoint without sending a health token', async () => {
  const resumed = harness(undefined, POLLING_HEALTH);
  await resumed.client.resume({ endpoint: ENDPOINT, code: CODE, token: TOKEN });
  assert.equal(resumed.client.transport, 'polling');
  assert.equal(resumed.requests[0].init.headers.Authorization, undefined);
  assert.equal(resumed.requests[1].init.headers.Authorization, 'Bearer ' + TOKEN);
  resumed.client.start(); await flush();
  assert.equal(resumed.client.status, 'connected'); assert.equal(resumed.sockets.length, 0);
  resumed.client.close();

  const matched = harness(undefined, POLLING_HEALTH);
  matched.client.adopt({ ...snapshot(), token: TOKEN });
  assert.equal(matched.requests.length, 0);
  matched.client.start(); matched.client.start();
  await flush();
  assert.equal(matched.requests.filter(item => item.url.endsWith('/api/health')).length, 1);
  assert.equal(matched.requests.filter(item => item.url.endsWith('/api/rooms/' + CODE)).length, 1);
  assert.equal(matched.client.status, 'connected'); assert.equal(matched.sockets.length, 0);
  matched.client.close();
});

test('invalid poll credentials, missing rooms, and expiry stop polling permanently', async () => {
  for (const status of [401, 403, 404, 410]) {
    const h = harness((url, init) => init.method === 'POST' ? response({ ...snapshot(), token: TOKEN }) :
      response({ error: 'room unavailable' }, status), POLLING_HEALTH);
    await h.client.create({}); h.client.start(); await flush();
    assert.equal(h.client.status, 'ended'); assert.equal(h.timers.size, 0);
    h.client.reconnect(); assert.equal(h.requests.length, 3);
  }
  const expired = harness(undefined, POLLING_HEALTH);
  await expired.client.create({}); expired.client.start(); await flush();
  expired.run(expired.client.expiryTimer);
  assert.equal(expired.client.status, 'ended'); assert.equal(expired.timers.size, 0);
  assert.equal(expired.snapshots.length, 1, 'Expiry keeps the last authoritative game available');
});

test('a lost polling action response refreshes once and never automatically replays the mutation', async () => {
  let mutations = 0, reads = 0;
  const h = harness((url, init) => {
    if (url.endsWith('/actions')) { mutations++; throw new TypeError('Lost response'); }
    if (init.method === 'POST') return response({ ...snapshot(), token: TOKEN });
    return response(snapshot(reads++));
  }, POLLING_HEALTH);
  await h.client.create({}); h.client.start(); await flush();
  await assert.rejects(h.client.mutate('actions', { type: 'play', revision: 0 }), /无法连接/);
  await flush();
  assert.equal(mutations, 1); assert.equal(reads, 2);
  assert.equal(h.client.status, 'connected');
  assert.equal(h.snapshots.at(-1).revision, 1);
  assert.equal(h.timers.size, 2);
  h.client.close();
});
