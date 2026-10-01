import {confirmRestoration} from '../room-restore.js';
import {
  CODE_RE, LIMITS, ROOM_TTL_MS, HttpError, reject, fields, newCode,
  createRoom, snapshot, authenticate, authenticateToken, assertCapacity,
  joinRoom, applySetup, applyAction, consumeRate, byteLength,
} from './room-state.js';

import { json, errorResponse, readJson } from './http.js';
import { normalizeMatchOptions, tokenFromRequest } from './matchmaking.js';
export { json, readJson } from './http.js';
export { MatchmakingQueue } from './matchmaking.js';

export function corsHeaders(request, env = {}) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = new Set([new URL(request.url).origin, 'https://vavilonska.github.io']);
  for (const configured of (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)) {
    try { const url = new URL(configured.trim()); if (url.protocol === 'https:' && url.origin === configured.trim()) allowed.add(url.origin); } catch { /* Invalid configuration never widens CORS. */ }
  }
  if (!allowed.has(origin)) reject(403, 'This website is not allowed to access this service');
  return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Expose-Headers': 'Retry-After' };
}
function withCors(response, headers) {
  // Constructing with the original response preserves Cloudflare's WebSocket upgrade.
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
  return result;
}
async function creationBucket(request) {
  // A fixed set of buckets bounds limiter storage. Collisions may share a quota.
  // No raw address is persisted; the hash rotates daily.
  const address = request.headers.get('CF-Connecting-IP') || 'local-development';
  const bytes = new TextEncoder().encode(`${Math.floor(Date.now() / ROOM_TTL_MS)}:${address}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return (digest[0] * 256 + digest[1]) % 256;
}
export default {
  async fetch(request, env, ctx) {
    let cors = {};
    try {
      cors = corsHeaders(request, env);
      const url = new URL(request.url);
      if (url.search) reject(400, 'Query parameters are not supported; never put reconnect tokens in URLs');
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('Access-Control-Request-Method');
        const requested = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (method && !['GET', 'POST'].includes(method) || requested.some(value => !['authorization', 'content-type'].includes(value))) reject(403, 'Unsupported cross-origin request');
        return new Response(null, { status: 204, headers: cors });
      }
      if(url.pathname==='/api/stats'&&request.method==='GET')return withCors(await env.ROOM_CREATION.getByName('creation-v1').fetch(new Request('https://limiter.internal/active')),cors);
      if (url.pathname === '/api/health' && request.method === 'GET') return withCors(json(200, { ok: true, mode: 'cloud', protocol: 1, features: { matchmaking: Boolean(env.MATCHMAKING), spectating: true, restoreGame: true, resultModes: true } }), cors);
      if (/^\/api\/matchmaking\/(start|status|cancel)$/.test(url.pathname)) {
        if (!env.MATCHMAKING) reject(503, 'Matchmaking is not enabled on this backend', { errorCode: 'MATCHMAKING_UNAVAILABLE', recoverable: true });
        const action = url.pathname.split('/').at(-1);
        if (request.method !== (action === 'status' ? 'GET' : 'POST')) reject(405, 'Method not allowed');
        if (request.headers.has('Upgrade')) reject(400, 'Matchmaking uses authenticated HTTP requests');
        const token = tokenFromRequest(request);
        const body = action === 'status' ? {} : await readJson(request);
        fields(body, action === 'start' ? ['options'] : [], action === 'start' ? ['options'] : []);
        const options = action === 'start' ? normalizeMatchOptions(body.options) : undefined;
        const response = await env.MATCHMAKING.getByName('casual-v1').fetch(new Request(`https://matchmaking.internal/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...(options ? { options } : {}), bucket: await creationBucket(request) }),
        }));
        return withCors(response, cors);
      }
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const options = await readJson(request, 100000);
        if(!options?.restoreGame&&byteLength(JSON.stringify(options))>LIMITS.requestBytes)reject(413,'Request body is too large');
        // Validate before consuming a creation slot or allocating a room object.
        createRoom('VALIDATION00', options);
        const gate = env.ROOM_CREATION.getByName('creation-v1');
        const admitted = await gate.fetch(new Request('https://limiter.internal/admit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket: await creationBucket(request) }) }));
        if (!admitted.ok) return withCors(admitted, cors);
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = newCode();
          const response = await env.ROOMS.getByName(code).fetch(new Request('https://room.internal/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, options }) }));
          if (response.status !== 409) return withCors(response, cors);
        }
        reject(503, 'Could not allocate a room; try again');
      }
      const match = /^\/api\/rooms\/([A-Za-z2-9]{12})(?:\/(join|actions|setup|events|watch|restore-confirm))?$/.exec(url.pathname);
      if (!match || !CODE_RE.test(match[1].toUpperCase())) reject(404, 'Not found');
      const path = match[2] || '';
      if (!((!path || path === 'events' || path === 'watch') && request.method === 'GET' || ['join', 'actions', 'setup', 'restore-confirm'].includes(path) && request.method === 'POST')) reject(405, 'Method not allowed');
      if (path === 'events' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') reject(426, 'A WebSocket upgrade is required');
      if (path !== 'events' && request.headers.has('Upgrade')) reject(400, 'Use the events endpoint for WebSockets');
      const response = await env.ROOMS.getByName(match[1].toUpperCase()).fetch(request);
      const actionTime=Number(response.headers.get('X-Game-Action-At'));
      if(path==='actions'&&response.ok&&actionTime>0){
        const report=env.ROOM_CREATION.getByName('creation-v1').fetch(new Request('https://limiter.internal/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:match[1].toUpperCase(),at:actionTime})})).catch(()=>{});
        if(ctx?.waitUntil)ctx.waitUntil(report);else await report;
      }
      return withCors(response, cors);
    } catch (error) { return withCors(errorResponse(error), cors); }
  },
};

// These classes use the SQLite storage backend selected by new_sqlite_classes.
// Its KV API avoids schema writes for probes of nonexistent room codes.
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.traffic = {};
    this.serial = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const values = await ctx.storage.get(['room', 'traffic']);
      this.room = values.get('room') || null;
      this.traffic = values.get('traffic') || {};
    });
  }
  exclusive(operation) {
    // Parsing streams can overlap even in a single-threaded object. Serialize the
    // whole state transition, including persistence, before accepting its result.
    const result = this.serial.then(operation);
    this.serial = result.catch(() => {});
    return result;
  }
  async liveRoom() {
    await this.ready;
    if (!this.room) reject(404, 'Room not found or expired');
    if (Date.now() >= this.room.expiresAt) { await this.expire(); reject(410, 'This room has expired. Continue from your saved local snapshot.', { errorCode: 'ROOM_EXPIRED', recoverable: true }); }
    return this.room;
  }
  async charge(key = 'requests', limit = LIMITS.requestsPerMinute) {
    consumeRate(this.traffic, key, limit);
    await this.ctx.storage.put('traffic', this.traffic);
  }
  async save(next, seat) {
    try { assertCapacity(next); }
    catch (error) { if (error.status === 507) error.details = { ...snapshot(this.room, seat), ...error.details }; throw error; }
    try { await this.ctx.storage.put('room', next); }
    catch { reject(503, 'Cloud storage is unavailable. Export your snapshot and continue locally, or try again later.', { ...snapshot(this.room, seat), errorCode: 'CLOUD_UNAVAILABLE', recoverable: true }); }
    this.room = next;
    this.broadcast();
  }
  async fetch(request) {
    try {
      // Finish reading the request before choosing a revision; parsing may yield.
      const body = request.method === 'POST' ? await readJson(request,new URL(request.url).pathname==='/create'?102000:LIMITS.requestBytes) : undefined;
      return await this.exclusive(() => this.handleRequest(request, body));
    } catch (error) { return errorResponse(error); }
  }
  async handleRequest(request, body) {
    try {
      const path = new URL(request.url).pathname;
      await this.ready;
      if (path === '/create-match' && request.method === 'POST') {
        fields(body, ['code', 'allocationId', 'options', 'tokens', 'createdAt'], ['code', 'allocationId', 'options', 'tokens', 'createdAt']);
        if (!CODE_RE.test(body.code) || !/^[A-Za-z0-9_-]{43}$/.test(body.allocationId)) reject(400, 'Invalid allocation');
        fields(body.tokens, ['A', 'B'], ['A', 'B']);
        if (!['A', 'B'].every(seat => typeof body.tokens[seat] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.tokens[seat])) || body.tokens.A === body.tokens.B) reject(400, 'Invalid allocation credentials');
        if (!Number.isSafeInteger(body.createdAt) || body.createdAt > Date.now() || Date.now() >= body.createdAt + ROOM_TTL_MS) reject(400, 'Invalid allocation time');
        if (body.options?.colorSetup !== 'nigiri') reject(400, 'Matched rooms require nigiri');
        if (this.room) {
          if (this.room.matchAllocation !== body.allocationId || this.room.code !== body.code
            || this.room.tokens.A !== body.tokens.A || this.room.tokens.B !== body.tokens.B) reject(409, 'Room already exists');
          await this.liveRoom();
          return json(200, { ok: true });
        }
        const room = createRoom(body.code, body.options, body.createdAt);
        room.tokens = body.tokens;
        room.matchAllocation = body.allocationId;
        room.revision = 1;
        assertCapacity(room);
        await this.ctx.storage.setAlarm(room.expiresAt);
        await this.ctx.storage.put('room', room);
        this.room = room;
        return json(201, { ok: true });
      }
      if (path === '/create' && request.method === 'POST') {
        fields(body, ['code', 'options'], ['code', 'options']);
        if (!CODE_RE.test(body.code)) reject(400, 'Invalid room code');
        if (this.room) reject(409, 'Room already exists');
        const room = createRoom(body.code, body.options);
        assertCapacity(room);
        // Schedule cleanup first: if storage quota fails between these writes,
        // there can be an empty alarm, but never a stored room without cleanup.
        await this.ctx.storage.setAlarm(room.expiresAt);
        await this.ctx.storage.put('room', room);
        this.room = room;
        return json(201, { ...snapshot(room, 'A'), token: room.tokens.A });
      }
      await this.liveRoom();
      await this.charge();
      // Re-read after the storage gate; all mutations use the authoritative revision.
      const room = this.room;
      if (path.endsWith('/watch') && request.method === 'GET') {
        await this.charge('spectators', 30);
        return json(200, { ...snapshot(room, null), spectator: true });
      }
      if (path.endsWith('/events') && request.method === 'GET') return await this.connect(request);
      if (path.endsWith('/join') && request.method === 'POST') {
        fields(body, []);
        const next = joinRoom(room);
        await this.save(next, 'B');
        return json(200, { ...snapshot(next, 'B'), token: next.tokens.B });
      }
      const seat = authenticate(request, room);
      if (request.method === 'GET') return json(200, snapshot(room, seat));
      await this.charge(seat, LIMITS.actionsPerSeatPerMinute);
      const current = this.room;
      let next;
      if(path.endsWith('/restore-confirm'))next=confirmRestoration(current,seat,body);
      else if (path.endsWith('/setup')) next = applySetup(current, seat, body);
      else if (path.endsWith('/actions')) next = applyAction(current, seat, body);
      else reject(405, 'Method not allowed');
      const changed=path.endsWith('/actions')&&body.type!=='approveScore'&&JSON.stringify(next.game)!==JSON.stringify(current.game);
      if(changed)next.lastGameActionAt=Date.now();
      await this.save(next, seat);
      return json(200, snapshot(next, seat),changed?{'X-Game-Action-At':String(next.lastGameActionAt)}:{});
    } catch (error) { return errorResponse(error); }
  }
  sockets() { return this.ctx.getWebSockets().filter(ws => ws.readyState === 1); }
  async scheduleAlarm() {
    if (!this.room) return;
    let next = this.room.expiresAt;
    for (const ws of this.sockets()) {
      const session = ws.deserializeAttachment();
      if (!session?.seat) next = Math.min(next, session?.deadline || Date.now());
    }
    if (await this.ctx.storage.getAlarm() !== next) await this.ctx.storage.setAlarm(next);
  }
  async connect(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') reject(426, 'A WebSocket upgrade is required');
    const sockets = this.sockets();
    if (sockets.length >= LIMITS.sockets || sockets.filter(ws => !ws.deserializeAttachment()?.seat).length >= LIMITS.pendingSockets) reject(429, 'Too many room connections; wait and retry', { retryAfterMs: LIMITS.authenticationMs });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: null, deadline: Date.now() + LIMITS.authenticationMs });
    try { await this.scheduleAlarm(); }
    catch (error) { server.close(1011, 'Service unavailable'); throw error; }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    return this.exclusive(() => this.handleSocketMessage(ws, message));
  }
  async handleSocketMessage(ws, message) {
    try {
      const room = await this.liveRoom();
      if (typeof message !== 'string' || byteLength(message) > LIMITS.requestBytes) reject(413, 'Invalid WebSocket message size');
      let body;
      try { body = JSON.parse(message); } catch { reject(400, 'Invalid JSON'); }
      const session = ws.deserializeAttachment();
      if (!session || session.seat) reject(400, 'Use authenticated HTTP requests for actions');
      if (Date.now() >= session.deadline) reject(401, 'Authentication timed out');
      fields(body, ['type', 'token'], ['type', 'token']);
      if (body.type !== 'auth') reject(401, 'Authenticate as the first message');
      const seat = authenticateToken(body.token, room);
      if (this.sockets().filter(other => other !== ws && other.deserializeAttachment()?.seat === seat).length >= LIMITS.socketsPerSeat) reject(429, 'This player already has two connected tabs', { retryAfterMs: 15_000 });
      ws.serializeAttachment({ seat });
      ws.send(JSON.stringify({ type: 'snapshot', snapshot: snapshot(room, seat) }));
      // The existing auth alarm may fire early once; no timer keeps the object awake.
    } catch (error) {
      try { ws.send(JSON.stringify({ type: 'error', error: error.status ? error.message : 'Cloud service is unavailable', status: error.status || 503, ...(error.details || {}) })); } catch { /* Client already closed. */ }
      ws.close(error.status === 413 ? 1009 : 1008, 'Connection closed');
    }
  }
  broadcast() {
    if (!this.room) return;
    for (const ws of this.sockets()) {
      const seat = ws.deserializeAttachment()?.seat;
      if (!['A', 'B'].includes(seat)) continue;
      try { ws.send(JSON.stringify({ type: 'snapshot', snapshot: snapshot(this.room, seat) })); }
      catch { ws.close(1011, 'Reconnect to resume'); }
    }
  }
  webSocketClose(ws) { ws.close(1000, ''); }
  webSocketError(ws) { ws.close(1011, 'Reconnect to resume'); }
  async expire() {
    for (const ws of this.sockets()) {
      try { ws.send(JSON.stringify({ type: 'error', status: 410, errorCode: 'ROOM_EXPIRED', error: 'This room has expired. Continue from your saved local snapshot.', recoverable: true })); } catch { /* Already closed. */ }
      ws.close(4004, 'Room expired');
    }
    this.room = null;
    this.traffic = {};
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    return this.exclusive(async () => {
      await this.ready;
      if (!this.room || Date.now() >= this.room.expiresAt) { await this.expire(); return; }
      for (const ws of this.sockets()) {
        const session = ws.deserializeAttachment();
        if (!session?.seat && (!session?.deadline || Date.now() >= session.deadline)) ws.close(1008, 'Authentication timed out');
      }
      await this.scheduleAlarm();
    });
  }
}

export class RoomCreationLimiter {
  constructor(ctx) {
    this.ctx = ctx;
    this.counts = {};this.activity={};
    this.serial = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => { this.counts = await ctx.storage.get('counts') || {};this.activity=await ctx.storage.get('activity')||{}; });
  }
  async fetch(request) {
    try {
      const path=new URL(request.url).pathname;
      if(path==='/active'&&request.method==='GET'){
        await this.ready;const now=Date.now();return json(200,{ok:true,activeRooms:Object.values(this.activity).filter(at=>at>now-300000&&at<=now).length,windowSeconds:300,asOf:now,approximate:true});
      }
      if(path==='/activity'&&request.method==='POST'){
        const body=await readJson(request);fields(body,['code','at'],['code','at']);
        if(!CODE_RE.test(body.code)||!Number.isSafeInteger(body.at)||body.at>Date.now()||body.at<Date.now()-300000)reject(400,'Invalid activity report');
        const result=this.serial.then(async()=>{await this.ready;const now=Date.now(),next=Object.fromEntries(Object.entries(this.activity).filter(([,at])=>at>now-300000));if(!Object.hasOwn(next,body.code)&&Object.keys(next).length>=200)reject(429,'Activity capacity reached',{retryAfterMs:60000});next[body.code]=Math.max(next[body.code]||0,body.at);await this.ctx.storage.put('activity',next);this.activity=next;return json(200,{ok:true});});this.serial=result.catch(()=>{});return await result;
      }
      const body = await readJson(request);
      fields(body, ['bucket', 'allocationId'], ['bucket']);
      if (body.allocationId !== undefined && (typeof body.allocationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.allocationId))) reject(400, 'Invalid allocation');
      if (!Number.isInteger(body.bucket) || body.bucket < 0 || body.bucket >= 256) reject(400, 'Invalid bucket');
      const result = this.serial.then(() => this.admit(body.bucket, body.allocationId));
      this.serial = result.catch(() => {});
      return await result;
    } catch (error) { return errorResponse(error); }
  }
  async admit(bucket, allocationId) {
    try {
      await this.ready;
      const now = Date.now();
      // At most 257 small counters; reset the hourly buckets instead of retaining keys.
      const next = this.counts.hour !== Math.floor(now / 3_600_000)
        ? { day: structuredClone(this.counts.day), hour: Math.floor(now / 3_600_000), ...(this.counts.allocations ? { allocations: structuredClone(this.counts.allocations) } : {}) }
        : structuredClone(this.counts);
      if (next.allocations) for (const [id, receipt] of Object.entries(next.allocations)) if (receipt.expiresAt <= now) delete next.allocations[id];
      if (allocationId && next.allocations?.[allocationId]) {
        if (next.allocations[allocationId].bucket !== bucket) reject(409, 'Allocation bucket changed');
        return json(200, { ok: true });
      }
      consumeRate(next, 'day', 100, now, ROOM_TTL_MS);
      consumeRate(next, `ip${bucket}`, 5, now, 3_600_000);
      if (allocationId) {
        // At most 200 receipts (100/day across a midnight boundary), each kept
        // longer than the matchmaking claim's two-minute recovery window.
        next.allocations ||= {};
        if (Object.keys(next.allocations).length >= 200) reject(429, 'Creation receipts are full', { retryAfterMs: 600_000 });
        next.allocations[allocationId] = { bucket, expiresAt: now + 600_000 };
      }
      const nextDay = (Math.floor(now / ROOM_TTL_MS) + 1) * ROOM_TTL_MS;
      if (await this.ctx.storage.getAlarm() !== nextDay) await this.ctx.storage.setAlarm(nextDay);
      await this.ctx.storage.put('counts', next);
      this.counts = next;
      return json(200, { ok: true });
    } catch (error) { return errorResponse(error); }
  }
  async alarm() {
    const result = this.serial.then(async () => {
      await this.ready;
      // An old midnight alarm can be delivered after a new-day request.
      const now = Date.now();
      if (this.counts.day?.window >= Math.floor(now / ROOM_TTL_MS)) {
        await this.ctx.storage.setAlarm((Math.floor(now / ROOM_TTL_MS) + 1) * ROOM_TTL_MS);
        return;
      }
      const receipts = Object.values(this.counts.allocations || {}).filter(receipt => receipt.expiresAt > now);
      if (receipts.length) { await this.ctx.storage.setAlarm(Math.max(...receipts.map(receipt => receipt.expiresAt))); return; }
      this.counts = {};
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    });
    this.serial = result.catch(() => {});
    return result;
  }
}
