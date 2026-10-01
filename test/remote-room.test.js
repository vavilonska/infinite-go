import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../engine.js';
import { remoteEndpoint, remoteCode, saveRemoteSession, loadRemoteSession, lastRemoteSession,
  clearActiveRemoteSession, reconnectDelay, RemoteRoomClient } from '../remote-room.js';

const ENDPOINT = 'https://rooms.example';
const CODE = 'ABCDEFGH2345';
const TOKEN = 'a'.repeat(43);
const NOW = 100_000;
const snapshot = (revision = 0) => ({ code: CODE, seat: 'A', role: 'B', revision,
  game: createGame(), setup: null, players: { B: true, W: false }, expiresAt: NOW + 86_400_000 });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function harness(fetchOverride) {
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
    fetchImpl: async (url, init) => { requests.push({ url, init }); return fetchOverride ? fetchOverride(url, init) : response({ ...snapshot(), token: TOKEN }); },
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimer: id => timers.delete(id), now: () => NOW, random: () => .5,
    onStatus: status => statuses.push(status), onSnapshot: data => snapshots.push(data),
  });
  const run = id => { const timer = timers.get(id); assert.ok(timer); timers.delete(id); timer.fn(); };
  return { client, timers, sockets, requests, statuses, snapshots, run };
}

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
  assert.equal(h.requests[0].url, ENDPOINT + '/api/rooms');
  assert.equal(h.requests[0].init.headers.Authorization, undefined);
  assert.equal(h.requests[0].init.credentials, 'omit');
  assert.equal(h.requests[0].init.redirect, 'error');
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
  assert.equal(h.requests[1].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.ok(!h.requests[1].url.includes(TOKEN));
  assert.equal(h.requests[1].url, ENDPOINT + '/api/rooms/' + CODE + '/actions');
  h.client.close();
  assert.equal(h.timers.size, 0);
});

test('resume refuses credentials for another endpoint before any fetch', async () => {
  const h = harness();
  await assert.rejects(h.client.resume({ endpoint: 'https://other.example', code: CODE, token: TOKEN }), /其他服务/);
  assert.equal(h.requests.length, 0);
  assert.throws(() => { h.client.endpoint = 'https://other.example'; }, TypeError);
  await h.client.resume({ endpoint: ENDPOINT, code: CODE, token: TOKEN });
  assert.equal(h.requests[0].url, ENDPOINT + '/api/rooms/' + CODE);
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer ' + TOKEN);
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
