import {restoredGame,restorePublic,requireRestoreReady,confirmRestoration} from './room-restore.js';
// A small, dependency-free, authoritative server for trusted home LANs.
import { createServer as createHttpServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import {createNigiri,revealNigiri,chooseNigiri,publicNigiri} from './nigiri.js';
import { createGame, lineById, replay, play, toggleDead, approveScore, resume, prune } from './engine.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STATIC_FILES = new Map([
  ['/browser-provider.js',['browser-provider.js','text/javascript; charset=utf-8']],
  ['/browser-ai/settings.js',['browser-ai/settings.js','text/javascript; charset=utf-8']],
  ['/browser-ai/models.js',['browser-ai/models.js','text/javascript; charset=utf-8']],
  ...['engine.worker.js','engine.worker.js.LEGAL.txt','THIRD-PARTY-LICENSES.txt','runtime-info.json','wasm/tfjs-backend-wasm.wasm','wasm/tfjs-backend-wasm-simd.wasm','wasm/tfjs-backend-wasm-threaded-simd.wasm'].map(name=>['/browser-ai/dist/'+name,['browser-ai/dist/'+name,name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/plain; charset=utf-8']]),
  ['/ai-analysis.js',['ai-analysis.js','text/javascript; charset=utf-8']],
  ['/ai-worker.js',['ai-worker.js','text/javascript; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/local-ai/panel.js', ['local-ai/panel.js', 'text/javascript; charset=utf-8']],
  ['/matchmaking-client.js', ['matchmaking-client.js', 'text/javascript; charset=utf-8']],
  ['/remote-room.js', ['remote-room.js', 'text/javascript; charset=utf-8']],
  ['/remote-config.js', ['remote-config.js', 'text/javascript; charset=utf-8']],
  ['/host-address.js', ['host-address.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/nigiri.js', ['nigiri.js', 'text/javascript; charset=utf-8']],
  ['/annotations.js', ['annotations.js', 'text/javascript; charset=utf-8']],
  ['/LICENSE', ['LICENSE', 'text/plain; charset=utf-8']],
  ...['icon.png','icon-192.png','favicon.png','apple-touch-icon.png'].map(name=>['/assets/'+name,['assets/'+name,'image/png']]),
  ['/engine.js', ['engine.js', 'text/javascript; charset=utf-8']],
  ['/tree.js', ['tree.js', 'text/javascript; charset=utf-8']],
  ['/providers.js', ['providers.js', 'text/javascript; charset=utf-8']],
  ['/ai.js', ['ai.js', 'text/javascript; charset=utf-8']],
  ['/deployment.js', ['deployment.js', 'text/javascript; charset=utf-8']],
  ...['gameplay.jpg','social-preview.jpg'].map(name=>['/assets/'+name,['assets/'+name,'image/jpeg']]),
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
async function readJson(req,maxBytes=4096) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') reject(415, 'Send application/json');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) reject(413, 'Request body is too large');
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
  for (const role of ['A', 'B']) {
    const expected = room.tokens[role];
    if (expected && timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return role;
  }
  reject(401, 'Invalid reconnect token');
}
const snapshot = (room, seat) => ({
  code: room.code, seat, role:room.roles?.[seat]??null, revision: room.revision, game: room.game, restoration:restorePublic(room), setup:publicNigiri(room.nigiri),
  players: { B: Boolean(room.tokens.A), W: Boolean(room.tokens.B) },
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
        sendJson(res, 200, { ok: true, mode: 'lan', features: { spectating: true, restoreGame: true, resultModes: true } });
        return;
      }
      if(path==='/api/stats'&&req.method==='GET'){const now=Date.now();sendJson(res,200,{ok:true,activeRooms:[...rooms.values()].filter(room=>now-room.touched<roomTtlMs&&room.lastGameActionAt>now-300000).length,windowSeconds:300,asOf:now,approximate:false});return;}
      if (path === '/api/rooms' && req.method === 'GET') {
        for (const [code, room] of rooms) if (Date.now() - room.touched > roomTtlMs) rooms.delete(code);
        sendJson(res, 200, { rooms: [...rooms.values()].map(room => ({ code: room.code, players: { B: Boolean(room.tokens.A), W: Boolean(room.tokens.B) } })) });
        return;
      }
      if (path === '/api/rooms' && req.method === 'POST') {
        const body = await readJson(req,100000);
        if(!body?.restoreGame&&Buffer.byteLength(JSON.stringify(body))>4096)reject(413,'Request body is too large');
        fields(body, ['size', 'komi', 'branchLimitExponent','pruningMode','compensationC','colorSetup','hostColor','restoreGame','resultMode','resignationMargin']);
        if(body.restoreGame===undefined&&Object.hasOwn(body,'resultMode')&&!Object.hasOwn(body,'size'))reject(400,'Choose a board size');
        if(body.colorSetup!==undefined&&!['manual','nigiri'].includes(body.colorSetup))reject(400,'Invalid color setup');
        if(body.hostColor!==undefined&&!['B','W'].includes(body.hostColor))reject(400,'Invalid host color');
        let game;
        try { game = body.restoreGame!==undefined?restoredGame(body):createGame(body.size ?? 9, body.komi ?? 7.5, Object.hasOwn(body,'branchLimitExponent') ? body.branchLimitExponent : 9,{resultMode:body.resultMode,resignationMargin:body.resignationMargin,pruningMode:Object.hasOwn(body,'pruningMode')?body.pruningMode:'none',compensationC:Object.hasOwn(body,'compensationC')?body.compensationC:'32'}); } catch (error) { reject(400, error.message); }
        if (body.size === null || body.komi === null) reject(400, 'Size and komi cannot be null');
        for (const [code, room] of rooms) if (Date.now() - room.touched > roomTtlMs) rooms.delete(code);
        if (rooms.size >= maxRooms) reject(503, 'Room limit reached; restart the host to clear old rooms');
        let code;
        do { code = newCode(); } while (rooms.has(code));
        const token = randomBytes(32).toString('base64url');
        const room = { code, game, ...(body.restoreGame!==undefined?{restoration:{confirmations:[]}}:{}), revision: 0, tokens: { A: token, B: null }, roles:body.colorSetup==='nigiri'?null:{A:body.hostColor??'B',B:body.hostColor==='W'?'B':'W'}, nigiri:body.colorSetup==='nigiri'?createNigiri():null, touched: Date.now() };
        rooms.set(code, room);
        sendJson(res, 201, { ...snapshot(room, 'A'), token });
        return;
      }
      const match = /^\/api\/rooms\/([A-Za-z2-9]{6})(?:\/(join|actions|setup|watch|restore-confirm))?$/.exec(path);
      if (!match) reject(404, 'Not found');
      const code = match[1].toUpperCase();
      const action = match[2];
      const room = rooms.get(code);
      if (!room || Date.now() - room.touched > roomTtlMs) { rooms.delete(code); reject(404, 'Room not found or expired'); }
      if (action === 'watch') {
        if (req.method !== 'GET') reject(405, 'Spectating is read-only');
        const minute = Math.floor(Date.now() / 60000);
        if (room.watchMinute !== minute) { room.watchMinute = minute; room.watchRequests = 0; }
        if (++room.watchRequests > 30) reject(429, 'Spectator rate limit; wait and retry');
        sendJson(res, 200, { ...snapshot(room, null), spectator: true });
        return;
      }
      if (action === 'join' && req.method === 'POST') {
        fields(await readJson(req), []);
        if (room.tokens.B) reject(409, 'This room already has two players; reconnect with your saved token');
        const token = randomBytes(32).toString('base64url');
        room.tokens.B = token;
        room.revision++;
        room.touched = Date.now();
        sendJson(res, 200, { ...snapshot(room, 'B'), token });
        return;
      }
      const seat = authenticate(req, room),role=room.roles?.[seat]??null;
      room.touched = Date.now();
      if (!action && req.method === 'GET') {
        sendJson(res, 200, snapshot(room, seat));
        return;
      }
      if(action==='restore-confirm'&&req.method==='POST'){const next=confirmRestoration(room,seat,await readJson(req));rooms.set(code,next);sendJson(res,200,snapshot(next,seat));return;}
      if(req.method==='POST')requireRestoreReady(room);
      if(action==='setup'&&req.method==='POST'){
        const body=await readJson(req);fields(body,['type','revision','guess','color'],['type','revision']);
        if(body.revision!==room.revision)reject(409,'State changed; refresh and try again',snapshot(room,seat));
        if(!room.nigiri||room.game.lines.some(l=>l.history.length))reject(409,'Color setup is unavailable after play starts');
        if(!room.tokens.B)reject(409,'Wait for the other player to join');
        try{
          if(body.type==='guess'){if(seat!=='B')reject(403,'The joining player guesses odd or even');room.nigiri=revealNigiri(room.nigiri,body.guess);}
          else if(body.type==='choose'){room.nigiri=chooseNigiri(room.nigiri,seat,body.color);room.roles=room.nigiri.roles;}
          else reject(400,'Unknown setup action');
        }catch(error){if(error instanceof HttpError)throw error;reject(422,error.message);}
        room.revision++;sendJson(res,200,snapshot(room,seat));return;
      }
      if(!role)reject(409,'Finish guessing and choosing colors before playing');
      if (action !== 'actions' || req.method !== 'POST') reject(405, 'Method not allowed');
      const body = await readJson(req);
      if (!isObject(body) || !['play', 'toggleDead', 'approveScore', 'resume','prune'].includes(body.type)) reject(400, 'Unknown action');
      const common = ['revision', 'type', 'id'];
      const extras = { play: ['index', 'at'], toggleDead: ['at'], approveScore: ['color'], resume: [],prune:['index'] }[body.type];
      fields(body, [...common, ...extras], [...common, ...(body.type === 'play' ? ['index', 'at'] : body.type === 'toggleDead' ? ['at'] : body.type==='prune'?['index']:[])]);
      if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !Number.isSafeInteger(body.id) || body.id < 1) reject(400, 'Invalid revision or timeline ID');
      if (body.revision !== room.revision) reject(409, 'State changed; refresh and try again', snapshot(room, seat));
      if (['play','prune'].includes(body.type) && (!Number.isSafeInteger(body.index) || body.index < 0)) reject(400, 'Invalid history position');
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
        else if(body.type==='prune')prune(game,body.id,body.index,role);
        else resume(game, body.id); // Either player may dispute an unsettled score.
      } catch (error) {
        if (error instanceof HttpError) throw error;
        reject(422, error.message);
      }
      if(body.type!=='approveScore'&&JSON.stringify(room.game)!==JSON.stringify(game))room.lastGameActionAt=Date.now();
      room.game = game;
      room.revision++;
      sendJson(res, 200, snapshot(room, seat));
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
