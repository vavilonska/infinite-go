import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { GameRoom, RoomCreationLimiter, readJson } from '../cloud/worker.js';
import { createRoom, joinRoom, applyAction, snapshot, assertCapacity, consumeRate, LIMITS, ROOM_TTL_MS, CODE_RE } from '../cloud/room-state.js';
import { importGame } from '../engine.js';

class Storage {
  values = new Map();
  alarm = null;
  failRoomWrite = false;
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter(item => this.values.has(item)).map(item => [item, structuredClone(this.values.get(item))]));
    return structuredClone(this.values.get(key));
  }
  async put(key, value) { if (key === 'room' && this.failRoomWrite) throw new Error('SQLITE_FULL'); this.values.set(key, structuredClone(value)); }
  async deleteAll() { this.values.clear(); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}
class Context {
  storage = new Storage();
  sockets = [];
  blockConcurrencyWhile(callback) { return callback(); }
  acceptWebSocket(socket) { this.sockets.push(socket); }
  getWebSockets() { return this.sockets; }
}
class Socket {
  readyState = 1;
  messages = [];
  constructor(attachment = { seat: null, deadline: Date.now() + 15_000 }) { this.attachment = attachment; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(value) { this.messages.push(JSON.parse(value)); }
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
}
function fixture() {
  const rooms = new Map();
  const creationContext = new Context();
  const limiter = new RoomCreationLimiter(creationContext);
  const env = {
    ROOMS: { getByName(code) { if (!rooms.has(code)) { const ctx = new Context(); rooms.set(code, { ctx, instance: new GameRoom(ctx, {}) }); } return rooms.get(code).instance; } },
    ROOM_CREATION: { getByName() { return limiter; } },
  };
  const request = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await worker.fetch(new Request(`https://rooms.example${path}`, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, data: response.status === 204 ? null : await response.json(), headers: response.headers };
  };
  return { request, rooms, env, limiter, creationContext };
}
async function players(f, options = {}) {
  const created = await f.request('/api/rooms', { method: 'POST', body: options });
  assert.equal(created.status, 201);
  const a = created.data, path = `/api/rooms/${a.code}`;
  const joined = await f.request(`${path}/join`, { method: 'POST', body: {} });
  assert.equal(joined.status, 200);
  return { a, b: joined.data, path, ...f.rooms.get(a.code) };
}
const move = (revision, at, index = 0, id = 1) => ({ type: 'play', revision, id, index, at });
const action = (f, path, token, body) => f.request(`${path}/actions`, { method: 'POST', token, body });

test('cloud creates private rooms, preserves unlimited mode, and exposes no directory', async () => {
  const f = fixture();
  const { a, b, path, ctx } = await players(f, { branchLimitExponent: null, hostColor: 'W' });
  assert.match(a.code, CODE_RE);
  assert.equal(a.role, 'W');
  assert.equal(b.role, 'B');
  assert.equal(a.token.length, 43);
  assert.notEqual(a.token, b.token);
  assert.equal(a.game.branchLimitExponent, null);
  assert.equal(ctx.storage.values.get('room').expiresAt - ctx.storage.values.get('room').createdAt, ROOM_TTL_MS);
  assert.equal(ctx.storage.alarm, a.expiresAt);
  const reconnected = await f.request(path.toLowerCase(), { token: a.token });
  assert.equal(reconnected.status, 200);
  assert.equal(reconnected.data.seat, 'A');
  assert.equal(reconnected.data.revision, 1);
  for (const secret of [a.token, b.token, 'tokens']) assert.equal(JSON.stringify(reconnected.data).includes(secret), false);
  assert.equal((await f.request('/api/rooms')).status, 404);
  assert.equal((await f.request(path)).status, 401);
  assert.equal((await f.request(path, { token: 'a'.repeat(43) })).status, 401);
  assert.equal((await f.request(`${path}/join`, { method: 'POST', body: {} })).status, 409);
});

test('cloud rejects unapproved origins, URL credentials, invalid routes, and permissive preflights', async () => {
  const f = fixture();
  const permitted = await f.request('/api/health', { headers: { Origin: 'https://vavilonska.github.io' } });
  assert.equal(permitted.status, 200);
  assert.equal(permitted.headers.get('access-control-allow-origin'), 'https://vavilonska.github.io');
  assert.equal(permitted.headers.get('access-control-allow-credentials'), null);
  assert.equal((await f.request('/api/health', { headers: { Origin: 'https://rooms.example' } })).status, 200);
  for (const origin of ['null', 'https://evil.example', 'https://vavilonska.github.io.evil.example']) {
    const response = await f.request('/api/rooms', { method: 'POST', body: {}, headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const preflight = await f.request('/api/rooms', { method: 'OPTIONS', headers: { Origin: 'https://vavilonska.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
  assert.equal(preflight.status, 204);
  assert.equal((await f.request('/api/rooms', { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'X-Evil' } })).status, 403);
  assert.equal((await f.request('/api/health?token=secret')).status, 400);
  assert.equal((await f.request('/api/rooms/OOOOOOOOOOOO')).status, 404);
  assert.equal((await f.request('/create', { method: 'POST', body: {} })).status, 404);
});

test('cloud validates streaming body size and request fields before allocating storage', async () => {
  const f = fixture();
  for (const body of [[], null, { size: null }, { size: 5 }, { komi: null }, { colorSetup: 'invalid' }, { branchLimitExponent: 1 }, { extra: true }]) assert.equal((await f.request('/api/rooms', { method: 'POST', body })).status, 400);
  assert.equal(f.rooms.size, 0);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { extra: 'x'.repeat(5000) } })).status, 413);
  await assert.rejects(readJson(new Request('https://test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })), { status: 400 });
  await assert.rejects(readJson(new Request('https://test', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })), { status: 415 });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2048)); controller.enqueue(new Uint8Array(2049)); controller.close(); } });
  await assert.rejects(readJson(new Request('https://test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' })), { status: 413 });
  const missing = await f.request('/api/rooms/AAAAAAAAAAAA');
  assert.equal(missing.status, 404);
  assert.equal(f.rooms.get('AAAAAAAAAAAA').ctx.storage.values.size, 0);
});

test('concurrent joins and actions commit once and stale responses include the authoritative snapshot', async () => {
  const f = fixture();
  const a = (await f.request('/api/rooms', { method: 'POST', body: {} })).data;
  const path = `/api/rooms/${a.code}`;
  const joins = await Promise.all([0, 1].map(() => f.request(`${path}/join`, { method: 'POST', body: {} })));
  assert.deepEqual(joins.map(result => result.status).sort(), [200, 409]);
  const b = joins.find(result => result.status === 200).data;
  assert.equal((await action(f, path, b.token, move(b.revision, 0))).status, 403);
  const moves = await Promise.all([0, 1].map(at => action(f, path, a.token, move(b.revision, at))));
  assert.deepEqual(moves.map(result => result.status).sort(), [200, 409]);
  const winner = moves.find(result => result.status === 200).data;
  const stale = moves.find(result => result.status === 409).data;
  assert.deepEqual(stale.game, winner.game);
  assert.equal(stale.revision, winner.revision);
  assert.equal(stale.seat, 'A');
  const occupied = winner.game.lines[0].history[0].at;
  const illegal = await action(f, path, b.token, move(winner.revision, occupied, 1));
  assert.equal(illegal.status, 422);
  assert.deepEqual((await f.request(path, { token: a.token })).data.game, winner.game);
});

test('nigiri remains hidden until the guest guesses and only its winner can choose colors', async () => {
  const f = fixture();
  const { a, b, path } = await players(f, { colorSetup: 'nigiri' });
  assert.equal(a.role, null);
  assert.deepEqual(a.setup, { phase: 'guess' });
  assert.deepEqual(b.setup, { phase: 'guess' });
  assert.equal((await action(f, path, a.token, move(b.revision, 0))).status, 409);
  const setup = (token, body) => f.request(`${path}/setup`, { method: 'POST', token, body });
  assert.equal((await setup(a.token, { type: 'guess', revision: b.revision, guess: 'odd' })).status, 403);
  const reveal = await setup(b.token, { type: 'guess', revision: b.revision, guess: 'odd' });
  assert.equal(reveal.status, 200);
  const winner = reveal.data.setup.winner === 'A' ? a : b;
  const loser = winner === a ? b : a;
  assert.equal((await setup(loser.token, { type: 'choose', revision: reveal.data.revision, color: 'W' })).status, 422);
  const choice = await setup(winner.token, { type: 'choose', revision: reveal.data.revision, color: 'W' });
  assert.equal(choice.status, 200);
  assert.equal(choice.data.role, 'W');
  const first = await action(f, path, loser.token, move(choice.data.revision, 0));
  assert.equal(first.status, 200);
  assert.equal((await setup(winner.token, { type: 'choose', revision: first.data.revision, color: 'B' })).status, 409);
});

test('cloud uses shared branching, pruning, score approval, and dispute rules', () => {
  let room = joinRoom(createRoom('AAAAAAAAAAAA', { pruningMode: 'komi', compensationC: '8', branchLimitExponent: null }));
  const run = (seat, body) => { room = applyAction(room, seat, { revision: room.revision, id: 1, ...body }); return room; };
  run('A', { type: 'play', index: 0, at: 0 });
  run('B', { type: 'play', index: 1, at: 1 });
  run('A', { type: 'play', index: 0, at: 2 });
  assert.equal(room.game.lines.length, 2);
  assert.throws(() => run('B', { type: 'prune', index: 1 }), { status: 422 });
  run('A', { type: 'prune', index: 1 });
  assert.deepEqual(room.game.komiCompensation, { n: '4', d: '1' });
  assert.equal(room.game.archives.length, 1);
  run('B', { type: 'play', id: 2, index: 1, at: null });
  run('A', { type: 'play', id: 2, index: 2, at: null });
  assert.throws(() => run('A', { type: 'approveScore', id: 2, color: 'W' }), { status: 403 });
  run('A', { type: 'approveScore', id: 2 });
  run('B', { type: 'resume', id: 2 });
  assert.deepEqual(room.game.lines[0].approvals, []);
  run('B', { type: 'play', id: 2, index: 4, at: null });
  run('A', { type: 'play', id: 2, index: 5, at: null });
  run('A', { type: 'approveScore', id: 2 });
  run('B', { type: 'approveScore', id: 2 });
  assert.equal(room.game.lines[0].status, 'settled');
  assert.deepEqual(importGame(JSON.stringify(room.game)), room.game);
});

test('resource ceilings reject the candidate while keeping exportable original state and unlimited rules', async () => {
  const f = fixture();
  const { a, path, instance } = await players(f, { branchLimitExponent: null });
  const before = structuredClone(instance.room);
  const next = structuredClone(before);
  next.game.lines[0].history = Array.from({ length: LIMITS.movesPerHistory + 1 }, () => ({ type: 'pass', color: 'B' }));
  await assert.rejects(instance.save(next, 'A'), error => {
    assert.equal(error.status, 507);
    assert.equal(error.details.errorCode, 'ROOM_RESOURCE_LIMIT');
    assert.equal(error.details.code, a.code);
    assert.equal(error.details.recoverable, true);
    assert.deepEqual(error.details.game, before.game);
    return true;
  });
  assert.deepEqual(instance.room, before);
  assert.equal((await f.request(path, { token: a.token })).data.game.branchLimitExponent, null);
  assert.deepEqual(importGame(JSON.stringify(before.game)), before.game);
  const oversized = structuredClone(before); oversized.game.padding = 'x'.repeat(LIMITS.stateBytes);
  assert.throws(() => assertCapacity(oversized), { status: 507 });
  const manyLines = structuredClone(before); manyLines.game.archives = [{ lines: Array.from({ length: LIMITS.timelineRecords }, () => ({ history: [] })) }];
  assert.throws(() => assertCapacity(manyLines), { status: 507 });
  const manyMoves = structuredClone(before); manyMoves.game.lines = Array.from({ length: 5 }, () => ({ history: Array.from({ length: 500 }, () => ({ type: 'pass', color: 'B' })) }));
  assert.throws(() => assertCapacity(manyMoves), { status: 507 });
});

test('storage failures retain acknowledged state and provide an exportable recovery snapshot', async () => {
  const f = fixture();
  const { a, b, path, ctx, instance } = await players(f);
  const before = structuredClone(instance.room);
  ctx.storage.failRoomWrite = true;
  const failure = await action(f, path, a.token, move(b.revision, 0));
  assert.equal(failure.status, 503);
  assert.equal(failure.data.errorCode, 'CLOUD_UNAVAILABLE');
  assert.equal(failure.data.code, a.code);
  assert.deepEqual(failure.data.game, before.game);
  assert.deepEqual(instance.room, before);
  ctx.storage.failRoomWrite = false;
  assert.equal((await action(f, path, a.token, move(b.revision, 0))).status, 200);
});

test('WebSockets authenticate before snapshots and broadcast only each client’s own seat', async () => {
  const f = fixture();
  const { a, b, path, ctx, instance } = await players(f);
  const one = new Socket(), two = new Socket(), anonymous = new Socket();
  ctx.sockets.push(one, two, anonymous);
  instance.broadcast();
  assert.equal(one.messages.length, 0);
  await instance.webSocketMessage(one, JSON.stringify({ type: 'auth', token: a.token }));
  await instance.webSocketMessage(two, JSON.stringify({ type: 'auth', token: b.token }));
  assert.deepEqual(one.attachment, { seat: 'A' });
  assert.deepEqual(two.attachment, { seat: 'B' });
  assert.equal(one.messages.at(-1).snapshot.seat, 'A');
  assert.equal(two.messages.at(-1).snapshot.seat, 'B');
  await action(f, path, a.token, move(b.revision, 0));
  assert.equal(one.messages.at(-1).snapshot.revision, 2);
  assert.equal(two.messages.at(-1).snapshot.revision, 2);
  assert.equal(two.messages.at(-1).snapshot.role, 'W');
  assert.equal(anonymous.messages.length, 0);
  for (const socket of [one, two]) for (const token of [a.token, b.token]) assert.equal(JSON.stringify(socket.messages).includes(token), false);
  // Hibernation discards the JavaScript instance, but retains storage and attachments.
  const restored = new GameRoom(ctx, {});
  await restored.ready;
  restored.broadcast();
  assert.equal(two.messages.at(-1).snapshot.seat, 'B');
  assert.equal(two.messages.at(-1).snapshot.revision, 2);
  const reconnect = new Socket(); ctx.sockets.push(reconnect);
  await restored.webSocketMessage(reconnect, JSON.stringify({ type: 'auth', token: a.token }));
  assert.equal(reconnect.messages.at(-1).snapshot.revision, 2);
});

test('WebSocket bad auth, oversized messages, connection caps, and auth expiry close safely', async () => {
  const f = fixture();
  const { a, ctx, instance } = await players(f);
  const bad = new Socket(); ctx.sockets.push(bad);
  await instance.webSocketMessage(bad, JSON.stringify({ type: 'auth', token: 'x'.repeat(43) }));
  assert.equal(bad.closeCode, 1008);
  assert.equal(bad.messages[0].snapshot, undefined);
  const huge = new Socket(); ctx.sockets.push(huge);
  await instance.webSocketMessage(huge, 'x'.repeat(LIMITS.requestBytes + 1));
  assert.equal(huge.closeCode, 1009);
  for (let i = 0; i < 2; i++) { const ws = new Socket(); ctx.sockets.push(ws); await instance.webSocketMessage(ws, JSON.stringify({ type: 'auth', token: a.token })); }
  const third = new Socket(); ctx.sockets.push(third);
  await instance.webSocketMessage(third, JSON.stringify({ type: 'auth', token: a.token }));
  assert.equal(third.closeCode, 1008);
  assert.equal(third.messages[0].status, 429);
  const expired = new Socket({ seat: null, deadline: Date.now() - 1 }); ctx.sockets.push(expired);
  await instance.alarm();
  assert.equal(expired.closeCode, 1008);
  assert.equal(ctx.storage.alarm, instance.room.expiresAt);
  ctx.sockets = Array.from({ length: LIMITS.pendingSockets }, () => new Socket());
  await assert.rejects(instance.connect(new Request('https://test/events', { headers: { Upgrade: 'websocket' } })), { status: 429 });
});

test('fixed expiry survives reads and reconnects, closes sockets, and deletes all storage', async () => {
  const f = fixture();
  const { a, path, ctx, instance } = await players(f);
  const firstExpiry = instance.room.expiresAt;
  await f.request(path, { token: a.token });
  assert.equal(instance.room.expiresAt, firstExpiry);
  const ws = new Socket({ seat: 'A' }); ctx.sockets.push(ws);
  instance.room.expiresAt = Date.now() - 1;
  const expired = await f.request(path, { token: a.token });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.errorCode, 'ROOM_EXPIRED');
  assert.equal(ws.closeCode, 4004);
  assert.equal(ctx.storage.values.size, 0);
  assert.equal(ctx.storage.alarm, null);
  assert.equal((await f.request(path, { token: a.token })).status, 404);
});

test('room rates persist across restarts and rejected writes leave state unchanged', async () => {
  const f = fixture();
  const { a, b, path, ctx, instance } = await players(f);
  instance.traffic.A = { window: Math.floor(Date.now() / 60_000), count: LIMITS.actionsPerSeatPerMinute };
  const limited = await action(f, path, a.token, move(b.revision, 0));
  assert.equal(limited.status, 429);
  assert.ok(limited.data.retryAfterMs > 0);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(instance.room.revision, b.revision);
  const restored = new GameRoom(ctx, {}); await restored.ready;
  assert.equal(restored.traffic.A.count, LIMITS.actionsPerSeatPerMinute);
  const state = {}; consumeRate(state, 'a', 1, 0);
  assert.throws(() => consumeRate(state, 'a', 1, 1), { status: 429 });
  assert.doesNotThrow(() => consumeRate(state, 'a', 1, 60_000));
});

test('creation quota is bounded, persists, serializes races, and caps daily room count', async () => {
  const ctx = new Context();
  let limiter = new RoomCreationLimiter(ctx);
  const admit = bucket => limiter.fetch(new Request('https://limiter/admit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket }) }));
  const raced = await Promise.all(Array.from({ length: 6 }, () => admit(1)));
  assert.deepEqual(raced.map(response => response.status).sort(), [200, 200, 200, 200, 200, 429]);
  limiter = new RoomCreationLimiter(ctx); await limiter.ready;
  assert.equal((await admit(1)).status, 429);
  for (let bucket = 2; bucket <= 20; bucket++) for (let count = 0; count < 5; count++) assert.equal((await admit(bucket)).status, 200);
  assert.equal((await admit(21)).status, 429);
  assert.equal(limiter.counts.day.count, 100);
  assert.ok(Object.keys(limiter.counts).length <= 258);
  assert.equal(JSON.stringify(ctx.storage.values.get('counts')).includes('local-development'), false);
  // A delayed previous-day alarm must not erase a quota already used today.
  await limiter.alarm();
  assert.equal(limiter.counts.day.count, 100);
});
