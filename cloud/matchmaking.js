import { createGame } from '../engine.js';
import { fields, reject, consumeRate, newCode, newToken, byteLength, ROOM_TTL_MS } from './room-state.js';
import { json, errorResponse, readJson } from './http.js';

export const MATCH_LIMITS = Object.freeze({
  waitingMs: 5 * 60_000, presenceMs: 30_000, allocationMs: 2 * 60_000,
  receiptMs: 10 * 60_000, tombstoneMs: 60_000, cancellationMs: 5 * 60_000, pollAfterMs: 5000,
  tickets: 96, waitingTickets: 64, bucketTickets: 4, stateBytes: 96 * 1024,
  requestsPerMinute: 1000, requestsPerDay: 10_000, requestsPerTicketMinute: 20,
  startsPerBucketHour: 10,
});
export const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
export function tokenFromRequest(request) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')?.[1];
  if (!token) reject(401, 'A private matchmaking ticket is required', { errorCode: 'MATCHMAKING_AUTH' });
  return token;
}
export function normalizeMatchOptions(options) {
  fields(options, ['size', 'komi', 'branchLimitExponent', 'pruningMode', 'compensationC', 'rules']);
  if (options.rules !== undefined && options.rules !== 'infinite-go-v2') reject(400, 'Unsupported matchmaking rules');
  if (options.size === null || options.komi === null) reject(400, 'Size and komi cannot be null');
  let game;
  try {
    game = createGame(options.size ?? 9, options.komi ?? 7.5,
      Object.hasOwn(options, 'branchLimitExponent') ? options.branchLimitExponent : 9,
      { pruningMode: options.pruningMode, compensationC: options.compensationC });
  } catch (error) { reject(400, error.message); }
  // Include even currently inactive settings. Matching never changes game rules.
  return { rules: 'infinite-go-v2', size: game.size, komi: game.komi,
    branchLimitExponent: game.branchLimitExponent, pruningMode: game.pruningMode, compensationC: game.compensationC };
}
export const matchKey = options => JSON.stringify(normalizeMatchOptions(options));
const emptyState = () => ({ tickets: {}, pairs: {}, traffic: {}, starts: {} });
const unavailable = () => reject(503, 'Matchmaking is temporarily unavailable. Retry with the same ticket.', { errorCode: 'MATCHMAKING_UNAVAILABLE', recoverable: true });
function expireTicket(ticket, now) {
  ticket.status = 'expired';
  ticket.deleteAt = now + MATCH_LIMITS.tombstoneMs;
  delete ticket.pair;
}
function clean(state, now) {
  for (const [id, pair] of Object.entries(state.pairs)) {
    if (now < pair.deadline) continue;
    for (const token of pair.tickets) if (state.tickets[token]?.status === 'matching') expireTicket(state.tickets[token], now);
    delete state.pairs[id];
  }
  for (const [token, ticket] of Object.entries(state.tickets)) {
    if (ticket.status === 'waiting' && (now >= ticket.expiresAt || now >= ticket.presentUntil)) expireTicket(ticket, now);
    if (now >= ticket.deleteAt) delete state.tickets[token];
  }
  for (const [key, value] of Object.entries(state.starts)) if (value.window !== Math.floor(now / 3_600_000)) delete state.starts[key];
  for (const [key, value] of Object.entries(state.traffic)) {
    const period = key === 'day' ? ROOM_TTL_MS : 60_000;
    if (value.window !== Math.floor(now / period)) delete state.traffic[key];
  }
}
function nextAlarm(state, now) {
  const times = [];
  for (const ticket of Object.values(state.tickets)) times.push(ticket.deleteAt,
    ...(ticket.status === 'waiting' ? [ticket.expiresAt, ticket.presentUntil] : []));
  for (const pair of Object.values(state.pairs)) times.push(pair.deadline);
  if (Object.keys(state.starts).length) times.push((Math.floor(now / 3_600_000) + 1) * 3_600_000);
  if (Object.keys(state.traffic).length) times.push((Math.floor(now / ROOM_TTL_MS) + 1) * ROOM_TTL_MS);
  return times.length ? Math.min(...times) : null;
}

// One bounded coordinator serializes claim/cancel and persists claims before any
// cross-object operation. Retrying a claim reuses its room, tokens and quota ID.
export class MatchmakingQueue {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = emptyState();
    this.serial = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => { this.state = await ctx.storage.get('queue') || emptyState(); });
  }
  exclusive(operation) {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => {});
    return result;
  }
  async save(next) {
    if (byteLength(JSON.stringify(next)) > MATCH_LIMITS.stateBytes) reject(503, 'The matchmaking queue is full. Try again shortly.', { errorCode: 'MATCHMAKING_FULL', recoverable: true });
    const alarm = nextAlarm(next, Date.now());
    // Arm cleanup before storing anything; failed writes cannot leave unbounded state.
    if (alarm !== null) await this.ctx.storage.setAlarm(alarm);
    await this.ctx.storage.put('queue', next);
    this.state = next;
    if (alarm === null) await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    try {
      const body = await readJson(request);
      const token = tokenFromRequest(request);
      return await this.exclusive(() => this.handle(request, body, token));
    } catch (error) { return errorResponse(error); }
  }
  async handle(request, body, token) {
    await this.ready;
    const action = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !['start', 'status', 'cancel'].includes(action)) reject(404, 'Not found');
    fields(body, action === 'start' ? ['options', 'bucket'] : ['bucket'], action === 'start' ? ['options', 'bucket'] : ['bucket']);
    if (!Number.isInteger(body.bucket) || body.bucket < 0 || body.bucket >= 256) reject(400, 'Invalid bucket');
    const options = action === 'start' ? normalizeMatchOptions(body.options) : null;
    const now = Date.now(), next = structuredClone(this.state);
    clean(next, now);
    let ticket = next.tickets[token];
    if (!ticket && action === 'status') reject(404, 'Matchmaking ticket not found or expired', { errorCode: 'MATCHMAKING_EXPIRED' });
    if (ticket?.key && options && JSON.stringify(options) !== ticket.key) reject(409, 'This ticket already belongs to different game settings', { errorCode: 'MATCHMAKING_SETTINGS' });
    consumeRate(next.traffic, 'minute', MATCH_LIMITS.requestsPerMinute, now);
    consumeRate(next.traffic, 'day', MATCH_LIMITS.requestsPerDay, now, ROOM_TTL_MS);
    if (!ticket) {
      const tickets = Object.values(next.tickets);
      if (tickets.length >= MATCH_LIMITS.tickets || tickets.filter(value => value.status === 'waiting').length >= MATCH_LIMITS.waitingTickets) reject(503, 'The matchmaking queue is full. Try again shortly.', { errorCode: 'MATCHMAKING_FULL', recoverable: true });
      if (tickets.filter(value => value.bucket === body.bucket && ['waiting', 'matching'].includes(value.status)).length >= MATCH_LIMITS.bucketTickets) reject(429, 'Too many active tickets from this connection', { errorCode: 'MATCHMAKING_RATE_LIMIT', retryAfterMs: MATCH_LIMITS.presenceMs });
      consumeRate(next.starts, `ip${body.bucket}`, MATCH_LIMITS.startsPerBucketHour, now, 3_600_000);
      ticket = next.tickets[token] = { status: action === 'cancel' ? 'cancelled' : 'waiting', options, key: options ? JSON.stringify(options) : null, bucket: body.bucket,
        createdAt: now, expiresAt: now + MATCH_LIMITS.waitingMs, presentUntil: now + MATCH_LIMITS.presenceMs,
        deleteAt: now + (action === 'cancel' ? MATCH_LIMITS.cancellationMs : MATCH_LIMITS.waitingMs + MATCH_LIMITS.tombstoneMs), rate: {} };
    }
    consumeRate(ticket.rate, 'requests', MATCH_LIMITS.requestsPerTicketMinute, now);
    if (action === 'cancel' && ticket.status === 'waiting') {
      ticket.status = 'cancelled';
      ticket.deleteAt = now + MATCH_LIMITS.cancellationMs;
    } else if (ticket.status === 'waiting') {
      ticket.presentUntil = Math.min(ticket.expiresAt, now + MATCH_LIMITS.presenceMs);
      const opponent = Object.entries(next.tickets).find(([otherToken, value]) => otherToken !== token && value.status === 'waiting' && value.key === ticket.key);
      if (opponent) {
        const id = newToken(), [otherToken, other] = opponent;
        const pair = next.pairs[id] = { id, code: newCode(), options: ticket.options, bucket: other.bucket, createdAt: now,
          deadline: now + MATCH_LIMITS.allocationMs, tokens: { A: newToken(), B: newToken() }, tickets: [otherToken, token] };
        // A is the earlier waiting player; B guesses nigiri and its winner chooses colors.
        for (const [seat, value] of [['A', other], ['B', ticket]]) {
          value.status = 'matching'; value.pair = id; value.seat = seat;
          value.expiresAt = pair.deadline; value.deleteAt = pair.deadline + MATCH_LIMITS.tombstoneMs;
        }
      }
    }
    await this.save(next);
    if (ticket.status === 'matching') await this.finishPair(ticket.pair);
    return this.respond(token);
  }
  async finishPair(id) {
    const pair = this.state.pairs[id];
    if (!pair) return;
    if (Date.now() >= pair.deadline) { const next = structuredClone(this.state); clean(next, Date.now()); await this.save(next); return; }
    const admitted = await this.env.ROOM_CREATION.getByName('creation-v1').fetch(new Request('https://limiter.internal/admit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket: pair.bucket, allocationId: pair.id }),
    }));
    // Keep the durable claim on all errors. A later poll can recover without
    // exposing the players to a different opponent or consuming a second quota.
    if (!admitted.ok) { const error = await admitted.json(); reject(admitted.status, error.error, { ...error, errorCode: error.errorCode || 'MATCHMAKING_QUOTA' }); }
    const { rules, ...options } = pair.options;
    const created = await this.env.ROOMS.getByName(pair.code).fetch(new Request('https://room.internal/create-match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pair.code, allocationId: pair.id, options: { ...options, colorSetup: 'nigiri' }, tokens: pair.tokens, createdAt: pair.createdAt }),
    }));
    if (created.status === 409) {
      // This code belongs to a different allocation; no room for this claim was
      // created here. Persist a new code before retrying with the same quota ID.
      const next = structuredClone(this.state); next.pairs[id].code = newCode(); await this.save(next);
      unavailable();
    }
    if (!created.ok) unavailable();
    const next = structuredClone(this.state), now = Date.now();
    for (const [index, token] of pair.tickets.entries()) {
      const ticket = next.tickets[token], seat = index === 0 ? 'A' : 'B';
      ticket.status = 'matched'; ticket.room = { code: pair.code, token: pair.tokens[seat] };
      ticket.expiresAt = now + MATCH_LIMITS.receiptMs; ticket.deleteAt = ticket.expiresAt;
      delete ticket.pair;
    }
    delete next.pairs[id];
    await this.save(next);
  }
  async respond(token) {
    const ticket = this.state.tickets[token];
    if (!ticket) reject(404, 'Matchmaking ticket not found or expired', { errorCode: 'MATCHMAKING_EXPIRED' });
    const result = { status: ticket.status, options: ticket.options, expiresAt: ticket.expiresAt, pollAfterMs: MATCH_LIMITS.pollAfterMs };
    if (ticket.status === 'matched') {
      const response = await this.env.ROOMS.getByName(ticket.room.code).fetch(new Request(`https://room.internal/api/rooms/${ticket.room.code}`, { headers: { Authorization: `Bearer ${ticket.room.token}` } }));
      if (!response.ok) unavailable();
      result.room = { ...await response.json(), token: ticket.room.token };
    }
    return json(200, result);
  }
  async alarm() {
    return this.exclusive(async () => {
      await this.ready;
      const next = structuredClone(this.state);
      clean(next, Date.now());
      if (!Object.keys(next.tickets).length && !Object.keys(next.traffic).length && !Object.keys(next.starts).length) {
        await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); this.state = emptyState();
      } else await this.save(next);
    });
  }
}
