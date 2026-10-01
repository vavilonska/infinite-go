import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { GameRoom, RoomCreationLimiter, MatchmakingQueue } from '../cloud/worker.js';
import { MATCH_LIMITS, normalizeMatchOptions, matchKey } from '../cloud/matchmaking.js';
import { newToken, ROOM_TTL_MS } from '../cloud/room-state.js';

class Storage {
  values = new Map(); alarm = null; writes = 0; fail = null;
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter(item => this.values.has(item)).map(item => [item, structuredClone(this.values.get(item))]));
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.writes++;
    if (this.fail?.(key, value)) throw new Error('SQLITE_FULL');
    this.values.set(key, structuredClone(value));
  }
  async deleteAll() { this.values.clear(); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}
class Context {
  storage = new Storage();
  blockConcurrencyWhile(callback) { return callback(); }
  getWebSockets() { return []; }
}
function fixture() {
  const rooms = new Map(), queueContext = new Context(), limiterContext = new Context();
  let queue, limiter = new RoomCreationLimiter(limiterContext), afterAdmit, afterCreate;
  const env = {
    ROOM_CREATION: { getByName() { return { async fetch(request) { const response = await limiter.fetch(request); if (afterAdmit) await afterAdmit(response); return response; } }; } },
    ROOMS: { getByName(code) {
      if (!rooms.has(code)) { const ctx = new Context(); rooms.set(code, { ctx, instance: new GameRoom(ctx, {}) }); }
      return { async fetch(request) { const response = await rooms.get(code).instance.fetch(request); if (new URL(request.url).pathname === '/create-match' && afterCreate) await afterCreate(response); return response; } };
    } },
    MATCHMAKING: { getByName() { return queue; } },
  };
  queue = new MatchmakingQueue(queueContext, env);
  const request = async (path, { method = 'GET', body, token, ip = 'test-connection', headers = {} } = {}) => {
    const response = await worker.fetch(new Request(`https://rooms.example${path}`, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'CF-Connecting-IP': ip, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const start = (token, options = {}, extra = {}) => request('/api/matchmaking/start', { method: 'POST', body: { options }, token, ...extra });
  const status = token => request('/api/matchmaking/status', { token });
  const cancel = token => request('/api/matchmaking/cancel', { method: 'POST', body: {}, token });
  return { request, start, status, cancel, rooms, env, queueContext, limiterContext,
    get queue() { return queue; }, get limiter() { return limiter; },
    restart() { queue = new MatchmakingQueue(queueContext, env); limiter = new RoomCreationLimiter(limiterContext); for (const entry of rooms.values()) entry.instance = new GameRoom(entry.ctx, {}); },
    setAfterAdmit(callback) { afterAdmit = callback; }, setAfterCreate(callback) { afterCreate = callback; },
  };
}
async function withClock(callback) {
  const original = Date.now; let now = 1_800_000_000_000;
  Date.now = () => now;
  try { return await callback(milliseconds => { now += milliseconds; }); } finally { Date.now = original; }
}

test('matchmaking normalizes all rule dimensions and rejects unsupported settings', () => {
  assert.deepEqual(normalizeMatchOptions({}), { rules: 'infinite-go-v2', size: 9, komi: 7.5, branchLimitExponent: 9, pruningMode: 'none', compensationC: '32',resultMode:'weighted-wins',resignationMargin:20 });
  assert.equal(matchKey({ compensationC: '0032.000' }), matchKey({ compensationC: 32 }));
  const basic = matchKey({});
  for (const changed of [{ size: 13 }, { komi: 6.5 }, { branchLimitExponent: null }, { pruningMode: 'resign' }, { compensationC: '32.01' }]) assert.notEqual(matchKey(changed), basic);
  for (const invalid of [{ rules: 'japanese' }, { hostColor: 'B' }, { colorSetup: 'manual' }, { pruningMode: null }, { compensationC: null }, { size: 5 }, { komi: null }, { branchLimitExponent: 1 }, { extra: true }]) assert.throws(() => normalizeMatchOptions(invalid), { status: 400 });
});

test('matching advertises capability only with binding, validates before allocation, and forbids URL secrets', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/health')).data.features.matchmaking, true);
  delete f.env.MATCHMAKING;
  assert.equal((await f.request('/api/health')).data.features.matchmaking, false);
  assert.equal((await f.start(newToken())).data.errorCode, 'MATCHMAKING_UNAVAILABLE');
  f.env.MATCHMAKING = { getByName() { return f.queue; } };
  const token = newToken();
  assert.equal((await f.request('/api/matchmaking/status')).status, 401);
  assert.equal((await f.request(`/api/matchmaking/status?token=${token}`)).status, 400);
  assert.equal((await f.request('/api/matchmaking/start', { method: 'POST', token, body: { options: { rules: 'other' } } })).status, 400);
  assert.equal((await f.request('/api/matchmaking/start', { token })).status, 405);
  assert.equal((await f.request('/api/matchmaking/status', { token, headers: { Upgrade: 'websocket' } })).status, 400);
  assert.equal((await f.request('/create-match', { method: 'POST', body: {} })).status, 404);
  assert.equal((await f.request('/api/matchmaking')).status, 404);
  assert.equal(f.rooms.size, 0);
  assert.equal(f.queueContext.storage.values.size, 0);
});

test('two equal tickets get distinct existing-room seats, fair nigiri, and private recoverable credentials', async () => {
  const f = fixture(), one = newToken(), two = newToken();
  const options = { size: 13, komi: 6.5, branchLimitExponent: null, pruningMode: 'komi', compensationC: '0032.00' };
  assert.equal((await f.start(one, options)).data.status, 'waiting');
  const b = (await f.start(two, { ...options, compensationC: '32' })).data;
  const a = (await f.status(one)).data;
  assert.equal(a.status, 'matched'); assert.equal(b.status, 'matched');
  assert.equal(a.room.code, b.room.code); assert.equal(a.room.seat, 'A'); assert.equal(b.room.seat, 'B');
  assert.notEqual(a.room.token, b.room.token);
  assert.notEqual(a.room.token, one); assert.notEqual(b.room.token, two);
  assert.deepEqual(a.room.setup, { phase: 'guess' }); assert.equal(a.room.role, null);
  assert.deepEqual(a.room.players, { B: true, W: true });
  assert.equal(a.room.game.branchLimitExponent, null); assert.equal(a.room.game.compensationC, '32');
  assert.equal((await f.request(`/api/rooms/${a.room.code}/join`, { method: 'POST', body: {} })).status, 409);
  assert.equal((await f.request(`/api/rooms/${a.room.code}`, { token: one })).status, 401);
  for (const secret of [two, b.room.token, 'matchAllocation', 'tickets']) assert.equal(JSON.stringify(a).includes(secret), false);
  const before = a.room.token;
  f.restart();
  assert.equal((await f.start(one, options)).data.room.token, before);
  assert.equal((await f.cancel(one)).data.room.token, before);
  assert.equal(f.rooms.size, 1); assert.equal(f.limiter.counts.day.count, 1);
  const guess = await f.request(`/api/rooms/${a.room.code}/setup`, { method: 'POST', token: b.room.token, body: { type: 'guess', revision: b.room.revision, guess: 'odd' } });
  assert.equal(guess.status, 200); assert.equal(guess.data.setup.phase, 'choose');
});

test('different rule dimensions never match and duplicate starts cannot join themselves', async () => {
  const f = fixture(), token = newToken();
  await Promise.all([f.start(token), f.start(token)]);
  assert.equal(Object.keys(f.queue.state.tickets).length, 1); assert.equal(f.rooms.size, 0);
  assert.equal((await f.start(token, { komi: 6.5 })).data.errorCode, 'MATCHMAKING_SETTINGS');
  for (const [index, options] of [{ size: 13 }, { komi: 6.5 }, { branchLimitExponent: null }, { pruningMode: 'resign' }, { compensationC: '16' }].entries()) {
    assert.equal((await f.start(newToken(), options, { ip: `separate-${index}` })).data.status, 'waiting');
  }
  assert.equal(f.rooms.size, 0);
});

test('concurrent matching claims exactly two tickets and leaves the third waiting', async () => {
  const f = fixture(), tokens = [newToken(), newToken(), newToken()];
  const results = await Promise.all(tokens.map(token => f.start(token)));
  assert.ok(results.every(result => result.status === 200));
  const states = await Promise.all(tokens.map(token => f.status(token)));
  assert.deepEqual(states.map(result => result.data.status).sort(), ['matched', 'matched', 'waiting']);
  const matched = states.filter(result => result.data.status === 'matched');
  assert.equal(new Set(matched.map(result => result.data.room.code)).size, 1);
  assert.equal(new Set(matched.map(result => result.data.room.token)).size, 2);
  assert.equal(f.limiter.counts.day.count, 1);
});

test('cancel-before-start, repeated cancel, and waiting cancellation cannot revive or match a ticket', async () => {
  const f = fixture(), early = newToken(), waiting = newToken(), newcomer = newToken();
  assert.equal((await f.cancel(early)).data.status, 'cancelled');
  assert.equal((await f.start(early)).data.status, 'cancelled');
  assert.equal((await f.cancel(early)).data.status, 'cancelled');
  await f.start(waiting);
  assert.equal((await f.cancel(waiting)).data.status, 'cancelled');
  assert.equal((await f.start(waiting)).data.status, 'cancelled');
  assert.equal((await f.start(newcomer)).data.status, 'waiting');
  assert.equal(f.rooms.size, 0);
});

test('cancellation racing a committed claim returns the same matched room', async () => {
  const f = fixture(), a = newToken(), b = newToken();
  await f.start(a);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const gateEntered = new Promise(resolve => { entered = resolve; });
  f.setAfterAdmit(async () => { entered(); await blocked; });
  const joining = f.start(b);
  await gateEntered;
  const cancelling = f.cancel(a);
  release();
  const [second, cancelled] = await Promise.all([joining, cancelling]);
  assert.equal(second.data.status, 'matched'); assert.equal(cancelled.data.status, 'matched');
  assert.equal(second.data.room.code, cancelled.data.room.code);
  assert.notEqual(second.data.room.token, cancelled.data.room.token);
});

for (const stage of ['quota response', 'room response', 'matched commit']) test(`durable claims recover ${stage} loss without double allocation or quota`, async () => {
  const f = fixture(), a = newToken(), b = newToken();
  await f.start(a);
  let failed = false;
  const once = () => { if (!failed) { failed = true; throw new Error('Connection lost after commit'); } };
  if (stage === 'quota response') f.setAfterAdmit(once);
  if (stage === 'room response') f.setAfterCreate(once);
  if (stage === 'matched commit') f.queueContext.storage.fail = (key, state) => { if (!failed && Object.values(state.tickets).some(ticket => ticket.status === 'matched')) { failed = true; return true; } return false; };
  assert.equal((await f.start(b)).status, 503);
  const pair = Object.values(f.queue.state.pairs)[0];
  assert.ok(pair); assert.equal(f.queue.state.tickets[a].status, 'matching');
  f.restart();
  const recovered = await f.status(a), second = await f.start(b);
  assert.equal(recovered.data.status, 'matched'); assert.equal(second.data.status, 'matched');
  assert.equal(recovered.data.room.code, pair.code);
  assert.equal(recovered.data.room.token, pair.tokens.A); assert.equal(second.data.room.token, pair.tokens.B);
  assert.equal(f.rooms.size, 1); assert.equal(f.limiter.counts.day.count, 1);
  assert.equal(Object.keys(f.limiter.counts.allocations).length, 1);
  assert.equal(Object.keys(f.queue.state.pairs).length, 0);
});

test('failed queue claim persistence leaves waiting state unchanged and creates no room', async () => {
  const f = fixture(), a = newToken(), b = newToken(); await f.start(a);
  f.queueContext.storage.fail = () => true;
  assert.equal((await f.start(b)).status, 503);
  assert.equal(f.queue.state.tickets[a].status, 'waiting'); assert.equal(f.queue.state.tickets[b], undefined);
  assert.equal(f.rooms.size, 0); assert.equal(f.limiter.counts.day, undefined);
  f.queueContext.storage.fail = null;
  assert.equal((await f.start(b)).data.status, 'matched');
});

test('presence expires absent players, polling never extends maximum wait, and alarms reclaim secrets', async () => withClock(async advance => {
  const f = fixture(), absent = newToken(), active = newToken();
  const original = (await f.start(absent)).data.expiresAt;
  advance(MATCH_LIMITS.presenceMs + 1);
  assert.equal((await f.start(active)).data.status, 'waiting');
  assert.equal((await f.status(absent)).data.status, 'expired'); assert.equal(f.rooms.size, 0);
  for (let index = 0; index < 10; index++) { advance(29_000); await f.status(active); }
  advance(10_000);
  assert.equal((await f.status(active)).data.status, 'expired');
  assert.equal((await f.status(active)).data.expiresAt, original + MATCH_LIMITS.presenceMs + 1);
  advance(ROOM_TTL_MS);
  await f.queue.alarm();
  assert.equal(f.queueContext.storage.values.size, 0); assert.equal(f.queueContext.storage.alarm, null);
}));

test('rate limits, capacity, failed quota, and claim timeout remain bounded', async () => withClock(async advance => {
  const f = fixture(), a = newToken(), b = newToken();
  await f.start(a);
  f.setAfterAdmit(async response => { if (response.ok) throw new Error('Temporary service outage'); });
  assert.equal((await f.start(b)).status, 503);
  advance(MATCH_LIMITS.allocationMs + 1);
  await f.queue.alarm();
  assert.equal((await f.status(a)).data.status, 'expired'); assert.equal((await f.status(b)).data.status, 'expired');
  assert.equal(Object.keys(f.queue.state.pairs).length, 0); assert.equal(f.rooms.size, 0);
  f.setAfterAdmit(null);
  const token = newToken(); await f.start(token, { size: 19 });
  for (let index = 1; index < MATCH_LIMITS.requestsPerTicketMinute; index++) assert.equal((await f.status(token)).status, 200);
  const limited = await f.status(token);
  assert.equal(limited.status, 429); assert.ok(limited.data.retryAfterMs > 0); assert.ok(limited.headers.get('retry-after'));
  const next = structuredClone(f.queue.state);
  while (Object.keys(next.tickets).length < MATCH_LIMITS.tickets) next.tickets[newToken()] = { status: 'cancelled', options: null, key: null, bucket: 200, expiresAt: Date.now() + 60_000, deleteAt: Date.now() + 60_000, rate: {} };
  await f.queue.save(next);
  assert.equal((await f.start(newToken(), {}, { ip: 'other-connection' })).data.errorCode, 'MATCHMAKING_FULL');
  assert.ok(JSON.stringify(f.queueContext.storage.values.get('queue')).length <= MATCH_LIMITS.stateBytes);
}));

test('matched room allocation shares friend-room quota and retains receipts across midnight', async () => withClock(async advance => {
  const f = fixture();
  for (let index = 0; index < 5; index++) assert.equal((await f.request('/api/rooms', { method: 'POST', body: {} })).status, 201);
  await f.start(newToken());
  const blocked = await f.start(newToken());
  assert.equal(blocked.status, 429); assert.equal(blocked.data.errorCode, 'MATCHMAKING_QUOTA'); assert.equal(f.rooms.size, 5);
  const direct = new RoomCreationLimiter(new Context()), allocationId = newToken();
  const admit = () => direct.fetch(new Request('https://internal/admit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket: 0, allocationId }) }));
  advance(ROOM_TTL_MS - Date.now() % ROOM_TTL_MS - 1000);
  assert.equal((await admit()).status, 200);
  advance(2000); await direct.alarm();
  assert.equal((await admit()).status, 200);
  assert.equal(direct.counts.day.count, 1);
}));

test('match fingerprint separates result modes and configured resignation margins',()=>{
 const a=normalizeMatchOptions({size:9,resultMode:'weighted-margin',resignationMargin:20});
 assert.notEqual(JSON.stringify(a),JSON.stringify(normalizeMatchOptions({size:9,resultMode:'weighted-wins',resignationMargin:20})));
 assert.notEqual(JSON.stringify(a),JSON.stringify(normalizeMatchOptions({size:9,resultMode:'weighted-margin',resignationMargin:20.5})));
 for(const value of [0,-1,.1,null])assert.throws(()=>normalizeMatchOptions({size:9,resultMode:'weighted-margin',resignationMargin:value}));
});
