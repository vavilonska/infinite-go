import {restoredGame,restorePublic,requireRestoreReady} from '../room-restore.js';
// Cloud transport policy is deliberately separate from the unlimited local rules.
import { createGame, lineById, replay, play, toggleDead, approveScore, resume, prune } from '../engine.js';
import { createNigiri, revealNigiri, chooseNigiri, publicNigiri } from '../nigiri.js';

export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-HJ-NP-Z2-9]{12}$/;
export const LIMITS = Object.freeze({
  stateBytes: 96 * 1024, requestBytes: 4096, timelineRecords: 128,
  historyMoves: 2048, movesPerHistory: 512, requestsPerMinute: 120,
  actionsPerSeatPerMinute: 30, sockets: 8, socketsPerSeat: 2,
  pendingSockets: 4, authenticationMs: 15_000,
});
const encoder = new TextEncoder();
export const byteLength = value => encoder.encode(value).byteLength;
export class HttpError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}
export const reject = (status, message, details) => { throw new HttpError(status, message, details); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fields(body, allowed, required = []) {
  if (!isObject(body) || Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) reject(400, 'Invalid request fields');
}
export function newCode() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map(byte => CODE_ALPHABET[byte & 31]).join('');
}
export function newToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function createRoom(code, options, now = Date.now()) {
  fields(options, ['size', 'komi', 'branchLimitExponent', 'pruningMode', 'compensationC', 'colorSetup', 'hostColor', 'resultMode', 'resignationMargin', 'restoreGame']);
  if (options.colorSetup !== undefined && !['manual', 'nigiri'].includes(options.colorSetup)) reject(400, 'Invalid color setup');
  if (options.hostColor !== undefined && !['B', 'W'].includes(options.hostColor)) reject(400, 'Invalid host color');
  if(options.restoreGame===undefined&&Object.hasOwn(options,'resultMode')&&!Object.hasOwn(options,'size'))reject(400,'Choose a board size');
  if (options.size === null || options.komi === null) reject(400, 'Size and komi cannot be null');
  let game;
  try {
    game = options.restoreGame!==undefined?restoredGame(options):createGame(options.size ?? 9, options.komi ?? 7.5,
      Object.hasOwn(options, 'branchLimitExponent') ? options.branchLimitExponent : 9,
      {resultMode:options.resultMode,resignationMargin:options.resignationMargin, pruningMode: Object.hasOwn(options, 'pruningMode') ? options.pruningMode : 'none', compensationC: Object.hasOwn(options, 'compensationC') ? options.compensationC : '32' });
  } catch (error) { reject(400, error.message); }
  return {
    code, game, ...(options.restoreGame!==undefined?{restoration:{confirmations:[]}}:{}), revision: 0, createdAt: now, expiresAt: now + ROOM_TTL_MS,
    tokens: { A: newToken(), B: null },
    roles: options.colorSetup === 'nigiri' ? null : { A: options.hostColor ?? 'B', B: options.hostColor === 'W' ? 'B' : 'W' },
    nigiri: options.colorSetup === 'nigiri' ? createNigiri() : null,
  };
}
export const snapshot = (room, seat) => ({
  code: room.code, seat, role: room.roles?.[seat] ?? null, revision: room.revision,
  game: room.game, restoration:restorePublic(room), setup: publicNigiri(room.nigiri),
  players: { B: Boolean(room.tokens.A), W: Boolean(room.tokens.B) },
  expiresAt: room.expiresAt, limits: LIMITS,
});
export function authenticateToken(token, room) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) reject(401, 'A reconnect token is required');
  let seat = null;
  // Fixed-size comparisons; never place tokens in URLs, socket attachments or snapshots.
  for (const candidate of ['A', 'B']) {
    const expected = room.tokens[candidate] || '.'.repeat(43);
    let difference = 0;
    for (let index = 0; index < 43; index++) difference |= token.charCodeAt(index) ^ expected.charCodeAt(index);
    if (difference === 0 && room.tokens[candidate]) seat = candidate;
  }
  if (!seat) reject(401, 'Invalid reconnect token');
  return seat;
}
export const authenticate = (request, room) => authenticateToken(/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')?.[1], room);
export function assertCapacity(room, limits = LIMITS) {
  const lines = [...room.game.lines, ...room.game.archives.flatMap(archive => archive.lines)];
  if (lines.length > limits.timelineRecords || lines.some(line => line.history.length > limits.movesPerHistory)
    || lines.reduce((sum, line) => sum + line.history.length, 0) > limits.historyMoves
    || byteLength(JSON.stringify(room)) > limits.stateBytes) {
    reject(507, 'This room reached its cloud resource limit. Export the game and continue locally; the game rules are unchanged.', { errorCode: 'ROOM_RESOURCE_LIMIT', recoverable: true });
  }
}
export function joinRoom(room) {
  if (room.tokens.B) reject(409, 'This room already has two players; reconnect with your saved token');
  return { ...room, tokens: { ...room.tokens, B: newToken() }, revision: room.revision + 1 };
}
export function applySetup(room, seat, body) {
  requireRestoreReady(room);
  fields(body, ['type', 'revision', 'guess', 'color'], ['type', 'revision']);
  checkRevision(room, body.revision, seat);
  if (!room.nigiri || room.game.lines.some(line => line.history.length)) reject(409, 'Color setup is unavailable after play starts');
  if (!room.tokens.B) reject(409, 'Wait for the other player to join');
  const next = structuredClone(room);
  try {
    if (body.type === 'guess') {
      if (seat !== 'B') reject(403, 'The joining player guesses odd or even');
      next.nigiri = revealNigiri(next.nigiri, body.guess);
    } else if (body.type === 'choose') {
      next.nigiri = chooseNigiri(next.nigiri, seat, body.color);
      next.roles = next.nigiri.roles;
    } else reject(400, 'Unknown setup action');
  } catch (error) { if (error instanceof HttpError) throw error; reject(422, error.message); }
  next.revision++;
  return next;
}
function checkRevision(room, revision, seat) {
  if (!Number.isSafeInteger(revision) || revision < 0) reject(400, 'Invalid revision');
  if (revision !== room.revision) reject(409, 'State changed; refresh and try again', snapshot(room, seat));
}
export function applyAction(room, seat, body) {
  requireRestoreReady(room);
  const role = room.roles?.[seat];
  if (!role) reject(409, 'Finish guessing and choosing colors before playing');
  if (!isObject(body) || !['play', 'toggleDead', 'approveScore', 'resume', 'prune'].includes(body.type)) reject(400, 'Unknown action');
  const common = ['revision', 'type', 'id'];
  const extras = { play: ['index', 'at'], toggleDead: ['at'], approveScore: ['color'], resume: [], prune: ['index'] }[body.type];
  fields(body, [...common, ...extras], [...common, ...(body.type === 'play' ? ['index', 'at'] : body.type === 'toggleDead' ? ['at'] : body.type === 'prune' ? ['index'] : [])]);
  checkRevision(room, body.revision, seat);
  if (!Number.isSafeInteger(body.id) || body.id < 1) reject(400, 'Invalid timeline ID');
  if (['play', 'prune'].includes(body.type) && (!Number.isSafeInteger(body.index) || body.index < 0)) reject(400, 'Invalid history position');
  if (['play', 'toggleDead'].includes(body.type) && !(body.type === 'play' && body.at === null)
    && (!Number.isInteger(body.at) || body.at < 0 || body.at >= room.game.size ** 2)) reject(400, 'Invalid intersection');
  if (body.type === 'approveScore' && Object.hasOwn(body, 'color') && body.color !== role) reject(403, 'You can only approve your own color');
  const next = structuredClone(room);
  try {
    const line = lineById(next.game, body.id);
    if (body.type === 'play') {
      if (replay(line.history, next.game.size).toPlay !== role) reject(403, 'It is the other player’s turn');
      play(next.game, body.id, body.index, body.at);
    } else if (body.type === 'toggleDead') toggleDead(next.game, body.id, body.at);
    else if (body.type === 'approveScore') approveScore(next.game, body.id, role);
    else if (body.type === 'prune') prune(next.game, body.id, body.index, role);
    else resume(next.game, body.id);
  } catch (error) { if (error instanceof HttpError) throw error; reject(422, error.message); }
  next.revision++;
  return next;
}
export function consumeRate(state, key, limit, now = Date.now(), period = 60_000) {
  const window = Math.floor(now / period);
  if (!state[key] || state[key].window !== window) state[key] = { window, count: 0 };
  if (state[key].count >= limit) reject(429, 'Too many requests; wait and retry', { retryAfterMs: period - now % period });
  state[key].count++;
}
