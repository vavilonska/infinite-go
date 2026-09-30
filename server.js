// A small, dependency-free, authoritative server for trusted home LANs.
import { createServer as createHttpServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { createGame, lineById, replay, play, toggleDead, approveScore, resume } from './engine.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/engine.js', ['engine.js', 'text/javascript; charset=utf-8']],
  ['/tree.js', ['tree.js', 'text/javascript; charset=utf-8']],
  ['/providers.js', ['providers.js', 'text/javascript; charset=utf-8']],
  ['/ai.js', ['ai.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}
const reject = (status, message, details) => { throw new HttpError(status, message, details); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(body, allowed, required = []) {
  if (!isObject(body) || Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) {
    reject(400, 'Invalid request fields');
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') reject(415, 'Send application/json');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) reject(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(400, 'Invalid JSON'); }
}
function checkOrigin(req) {
  // Do not allow another website to create rooms or drive an authenticated UI.
  if (req.headers['sec-fetch-site'] === 'cross-site') reject(403, 'Cross-site requests are not allowed');
  if (!req.headers.origin) return; // Native clients and tests may omit Origin.
  let sameOrigin = false;
  try { sameOrigin = new URL(req.headers.origin).origin === new URL(`http://${req.headers.host}`).origin; } catch { /* rejected below */ }
  if (!sameOrigin) reject(403, 'Use this server from its own page');
}
function newCode() {
  return [...randomBytes(6)].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}
function authenticate(req, room) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
  if (!token) reject(401, 'A reconnect token is required');
  for (const role of ['B', 'W']) {
    const expected = room.tokens[role];
    if (expected && timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return role;
  }
  reject(401, 'Invalid reconnect token');
}
const snapshot = (room, role) => ({
  code: room.code, role, revision: room.revision, game: room.game,
  players: { B: Boolean(room.tokens.B), W: Boolean(room.tokens.W) },
});

/** Creates an unbound server. Importing this file never opens a listening port. */
export function createServer({ staticDir = ROOT, maxRooms = 100, roomTtlMs = 24 * 60 * 60 * 1000 } = {}) {
  const rooms = new Map();
  const server = createHttpServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) reject(405, 'Method not allowed');
        const asset = STATIC_FILES.get(path);
        if (!asset) reject(404, 'Not found');
        let data;
        try { data = await readFile(join(staticDir, asset[0])); } catch { reject(404, 'Not found'); }
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
      }
      checkOrigin(req);
      if (path === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, mode: 'lan' });
        return;
      }
      if (path === '/api/rooms' && req.method === 'GET') {
        for (const [code, room] of rooms) if (Date.now() - room.touched > roomTtlMs) rooms.delete(code);
        sendJson(res, 200, { rooms: [...rooms.values()].map(room => ({ code: room.code, players: { B: Boolean(room.tokens.B), W: Boolean(room.tokens.W) } })) });
        return;
      }
      if (path === '/api/rooms' && req.method === 'POST') {
        const body = await readJson(req);
        fields(body, ['size', 'komi']);
        let game;
        try { game = createGame(body.size ?? 9, body.komi ?? 7.5); } catch (error) { reject(400, error.message); }
        if (body.size === null || body.komi === null) reject(400, 'Size and komi cannot be null');
        for (const [code, room] of rooms) if (Date.now() - room.touched > roomTtlMs) rooms.delete(code);
        if (rooms.size >= maxRooms) reject(503, 'Room limit reached; restart the host to clear old rooms');
        let code;
        do { code = newCode(); } while (rooms.has(code));
        const token = randomBytes(32).toString('base64url');
        const room = { code, game, revision: 0, tokens: { B: token, W: null }, touched: Date.now() };
        rooms.set(code, room);
        sendJson(res, 201, { ...snapshot(room, 'B'), token });
        return;
      }
      const match = /^\/api\/rooms\/([A-Za-z2-9]{6})(?:\/(join|actions))?$/.exec(path);
      if (!match) reject(404, 'Not found');
      const code = match[1].toUpperCase();
      const action = match[2];
      const room = rooms.get(code);
      if (!room || Date.now() - room.touched > roomTtlMs) { rooms.delete(code); reject(404, 'Room not found or expired'); }
      if (action === 'join' && req.method === 'POST') {
        fields(await readJson(req), []);
        if (room.tokens.W) reject(409, 'This room already has two players; reconnect with your saved token');
        const token = randomBytes(32).toString('base64url');
        room.tokens.W = token;
        room.revision++;
        room.touched = Date.now();
        sendJson(res, 200, { ...snapshot(room, 'W'), token });
        return;
      }
      const role = authenticate(req, room);
      room.touched = Date.now();
      if (!action && req.method === 'GET') {
        sendJson(res, 200, snapshot(room, role));
        return;
      }
      if (action !== 'actions' || req.method !== 'POST') reject(405, 'Method not allowed');
      const body = await readJson(req);
      if (!isObject(body) || !['play', 'toggleDead', 'approveScore', 'resume'].includes(body.type)) reject(400, 'Unknown action');
      const common = ['revision', 'type', 'id'];
      const extras = { play: ['index', 'at'], toggleDead: ['at'], approveScore: ['color'], resume: [] }[body.type];
      fields(body, [...common, ...extras], [...common, ...(body.type === 'play' ? ['index', 'at'] : body.type === 'toggleDead' ? ['at'] : [])]);
      if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !Number.isSafeInteger(body.id) || body.id < 1) reject(400, 'Invalid revision or timeline ID');
      if (body.revision !== room.revision) reject(409, 'State changed; refresh and try again', snapshot(room, role));
      if (body.type === 'play' && (!Number.isSafeInteger(body.index) || body.index < 0)) reject(400, 'Invalid history position');
      if (['play', 'toggleDead'].includes(body.type) && !(body.type === 'play' && body.at === null) && (!Number.isInteger(body.at) || body.at < 0 || body.at >= room.game.size ** 2)) reject(400, 'Invalid intersection');
      if (body.type === 'approveScore' && Object.hasOwn(body, 'color') && body.color !== role) reject(403, 'You can only approve your own color');
      // Mutate a copy so an invalid action never leaves a partly changed room.
      const game = structuredClone(room.game);
      try {
        const line = lineById(game, body.id);
        if (body.type === 'play') {
          if (replay(line.history, game.size).toPlay !== role) reject(403, 'It is the other player’s turn');
          play(game, body.id, body.index, body.at);
        } else if (body.type === 'toggleDead') toggleDead(game, body.id, body.at);
        else if (body.type === 'approveScore') approveScore(game, body.id, role);
        else resume(game, body.id); // Either player may dispute an unsettled score.
      } catch (error) {
        if (error instanceof HttpError) throw error;
        reject(422, error.message);
      }
      room.game = game;
      room.revision++;
      sendJson(res, 200, snapshot(room, role));
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Internal server error', ...(error.details || {}) });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.on('error', error => { console.error(`Could not start Infinite Go: ${error.message}`); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`Infinite Go: http://localhost:${port}`);
    if (host === '0.0.0.0') {
      try {
        for (const entries of Object.values(networkInterfaces())) for (const entry of entries || []) {
          if (entry.family === 'IPv4' && !entry.internal) console.log(`LAN: http://${entry.address}:${port}`);
        }
      } catch { console.log(`LAN: open http://<this computer's LAN IP>:${port} on the same network (automatic address lookup unavailable).`); }
    }
    console.log('Trusted LAN only. Do not expose this server to the Internet or forward your router port.');
    console.log('Rooms live in memory and are lost when this server stops.');
  });
}
