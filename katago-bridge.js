// Optional local adapter. No engine, neural-network weights, or network service is bundled.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { apply, createGame, replay } from './engine.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const COLS = 'ABCDEFGHJKLMNOPQRST';
const RULE_NAME = 'chinese-positional-superko';
export const KATAGO_RULES = Object.freeze({ ko: 'POSITIONAL', scoring: 'AREA', tax: 'NONE', suicide: false, hasButton: false, whiteHandicapBonus: '0', friendlyPassOk: true });
const DEFAULT_ORIGINS = ['http://localhost:8000', 'http://127.0.0.1:8000'];
class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new BridgeError(status, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateFields(value, allowed, required = allowed) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(400, 'Invalid request fields');
}
const validId = id => typeof id === 'string' && /^[\w.:-]{1,128}$/.test(id);
export function toGtp(at, size) { return COLS[at % size] + (size - Math.floor(at / size)); }
export function fromGtp(move, size) {
  if (typeof move === 'string' && move.toLowerCase() === 'pass') return { type: 'pass' };
  if (typeof move !== 'string' || !/^[A-HJ-T][1-9][0-9]?$/.test(move)) fail(502, 'KataGo returned an invalid move');
  const x = COLS.indexOf(move[0]), y = size - Number(move.slice(1));
  if (x < 0 || x >= size || y < 0 || y >= size) fail(502, 'KataGo returned an out-of-bounds move');
  return { type: 'play', at: y * size + x };
}
export function buildQuery(body, maxVisits = 64) {
  validateFields(body, ['requestId', 'nodeId', 'boardSize', 'komi', 'rules', 'history']);
  if (!validId(body.requestId) || !(typeof body.nodeId === 'string' && body.nodeId.length > 0 && body.nodeId.length <= 512000 || Number.isSafeInteger(body.nodeId))) fail(400, 'Invalid requestId or nodeId');
  if (body.rules !== RULE_NAME) fail(400, 'Unsupported rules');
  try { createGame(body.boardSize, 0); } catch (error) { fail(400, error.message); }
  if (!Number.isFinite(body.komi) || Math.abs(body.komi)>400 || !Number.isInteger(body.komi * 2)) fail(400, 'KataGo requires integer or half-integer komi between -400 and 400');
  if (!Array.isArray(body.history) || body.history.length > 10000) fail(400, 'Invalid or oversized history');
  for (const move of body.history) {
    if (!isObject(move)) fail(400, 'Invalid history move');
    if (move.type === 'resume') validateFields(move, ['type']);
    else if (move.type === 'pass') validateFields(move, ['type', 'color']);
    else if (move.type === 'play') validateFields(move, ['type', 'color', 'at']);
    else fail(400, 'Unknown history move');
  }
  let state;
  try { state = replay(body.history, body.boardSize); } catch (error) { fail(400, `Invalid history: ${error.message}`); }
  return {
    state,
    query: {
      id: randomUUID(),
      moves: body.history.filter(move => move.type !== 'resume').map(move => [move.color, move.type === 'pass' ? 'pass' : toGtp(move.at, body.boardSize)]),
      rules: KATAGO_RULES, komi: body.komi,
      boardXSize: body.boardSize, boardYSize: body.boardSize,
      initialPlayer: 'B', maxVisits,
      overrideSettings: { ignorePreRootHistory: false },
    },
  };
}

/** Owns a fresh KataGo process; never connects to an existing engine session. */
export function createKataGoClient({ bin, model, config = join(ROOT, 'katago-analysis.cfg'), maxVisits = 64, timeoutMs = 120000, spawnProcess = spawn } = {}) {
  if (!bin || !model) throw new Error('Set KATAGO_BIN and KATAGO_MODEL, or use --katago and --model');
  if (!Number.isSafeInteger(maxVisits) || maxVisits < 1 || maxVisits > 100000) throw new Error('Visits must be an integer from 1 to 100000');
  const overrides = 'reportAnalysisWinratesAs=BLACK,ignorePreRootHistory=false,numAnalysisThreads=1,numSearchThreadsPerAnalysisThread=1,numEigenThreadsPerModel=2';
  const child = spawnProcess(bin, ['analysis', '-model', model, '-config', config, '-override-config', overrides, '-quit-without-waiting'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const byRequest = new Map();
  let alive = true;
  let closed = false;
  const write = data => { if (alive && !child.stdin.destroyed) child.stdin.write(JSON.stringify(data) + '\n'); };
  function settle(id, error, result) {
    const task = pending.get(id);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(id); byRequest.delete(task.requestId);
    error ? task.reject(error) : task.resolve(result);
  }
  function terminate(id, message, status) {
    if (!pending.has(id)) return false;
    write({ id: randomUUID(), action: 'terminate', terminateId: id });
    settle(id, new BridgeError(status, message));
    return true;
  }
  function stopped(message) {
    alive = false;
    for (const id of [...pending.keys()]) settle(id, new BridgeError(503, message));
  }
  child.on('error', error => stopped(`KataGo could not start: ${error.message}`));
  child.on('exit', (code, signal) => stopped(`KataGo exited (${signal || code}); restart the bridge`));
  child.stdin.on('error', () => stopped('KataGo input pipe closed; restart the bridge'));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    if (reply.error) {
      if (reply.id) settle(reply.id, new BridgeError(502, `KataGo: ${reply.error}`));
      else stopped(`KataGo: ${reply.error}`);
      return;
    }
    if (reply.warning) {
      // Never silently accept an engine changing the requested rules or history.
      if (pending.has(reply.id)) terminate(reply.id, `KataGo warning: ${reply.warning}`, 502);
      return;
    }
    if (reply.isDuringSearch === false) settle(reply.id, null, reply);
  });
  return {
    get alive() { return alive; }, maxVisits,
    analyze(body) {
      const { query, state } = buildQuery(body, maxVisits);
      if (!alive) return Promise.reject(new BridgeError(503, 'KataGo is unavailable; check the bridge terminal and restart'));
      if (byRequest.has(body.requestId)) return Promise.reject(new BridgeError(409, 'requestId is already active'));
      if (pending.size >= 8) return Promise.reject(new BridgeError(429, 'Analysis queue is full'));
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => terminate(query.id, 'KataGo request timed out', 504), timeoutMs);
        pending.set(query.id, { requestId: body.requestId, resolve, reject, timer });
        byRequest.set(body.requestId, query.id);
        write(query);
      });
      return promise.then(reply => {
        const winrate = reply.rootInfo?.winrate;
        if (reply.noResults || !Number.isFinite(winrate) || winrate < 0 || winrate > 1) fail(502, 'KataGo did not return a valid analysis');
        const candidates = [...(reply.moveInfos || [])].sort((a, b) => a.order - b.order);
        let move;
        for (const candidate of candidates) {
          try {
            const proposed = fromGtp(candidate.move, body.boardSize);
            apply(state, { ...proposed, color: state.toPlay }, body.boardSize);
            move = proposed;
            break;
          } catch { /* A recommendation must also pass the app's exact rules. */ }
        }
        return { requestId: body.requestId, nodeId: body.nodeId, blackWinrate: winrate, visits: reply.rootInfo.visits, ...(move ? { move } : {}) };
      });
    },
    cancel(requestId) {
      const id = byRequest.get(requestId);
      return id ? terminate(id, 'Request cancelled', 499) : false;
    },
    close() {
      if (closed) return;
      closed = true;
      stopped('Bridge stopped');
      reader.close();
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

async function readBody(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'Send application/json');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) fail(413, 'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
}
function json(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
export function createBridge({ engine, origins = DEFAULT_ORIGINS } = {}) {
  if (!engine) throw new Error('An engine client is required');
  const allowedOrigins = new Set(origins);
  const server = createServer(async (req, res) => {
    try {
      // Check Host too: a hostile domain rebinding to loopback must not become a client.
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { fail(403, 'Invalid host'); }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) fail(403, 'The bridge is loopback-only');
      if (req.headers.origin) {
        if (!allowedOrigins.has(req.headers.origin)) fail(403, 'This app origin is not allowed');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204); res.end(); return;
      }
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/capabilities') {
        json(res, engine.alive === false ? 503 : 200, { name: 'Local KataGo', analyze: true, generateMove: true, cancel: true, boardSizes: [9, 13, 19], rules: [RULE_NAME], winratePerspective: 'black', maxVisits: engine.maxVisits, available: engine.alive !== false });
        return;
      }
      if (req.method !== 'POST' || !['/analyze', '/generate-move', '/cancel'].includes(path)) fail(404, 'Not found');
      const body = await readBody(req);
      if (path === '/cancel') {
        validateFields(body, ['requestId']);
        if (!validId(body.requestId)) fail(400, 'Invalid requestId');
        json(res, 200, { requestId: body.requestId, cancelled: engine.cancel(body.requestId) });
        return;
      }
      buildQuery(body, engine.maxVisits); // Validate even when a test or alternate client is injected.
      const onClose = () => { if (!res.writableEnded) engine.cancel(body.requestId); };
      res.on('close', onClose);
      try {
        const result = await engine.analyze(body);
        if (path === '/generate-move' && !result.move) fail(422, 'No legal recommendation; resolve or resume scoring first');
        json(res, 200, result);
      } finally { res.off('close', onClose); }
    } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'Bridge error; check the terminal' }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 15000;
  server.on('close', () => engine.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const aliases = { '--katago': 'bin', '--model': 'model', '--config': 'config', '--port': 'port', '--origins': 'origins', '--visits': 'maxVisits' };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = aliases[process.argv[i]];
    if (!key || !process.argv[i + 1]) throw new Error('Use --katago PATH --model PATH [--config PATH] [--port 8787] [--origins ORIGIN,ORIGIN] [--visits 64]');
    options[key] = process.argv[i + 1];
  }
  const port = Number(options.port || process.env.KATAGO_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bridge port must be from 1 to 65535');
  const origins = (options.origins || process.env.KATAGO_ORIGINS)?.split(',').map(value => value.trim()).filter(Boolean) || DEFAULT_ORIGINS;
  for (const origin of origins) if (new URL(origin).origin !== origin || !/^https?:/.test(origin)) throw new Error('Each allowed origin must be an exact HTTP(S) origin with no path');
  const engine = createKataGoClient({ bin: options.bin || process.env.KATAGO_BIN, model: options.model || process.env.KATAGO_MODEL, config: options.config || process.env.KATAGO_CONFIG, maxVisits: Number(options.maxVisits || process.env.KATAGO_VISITS || 64) });
  const server = createBridge({ engine, origins });
  server.on('error', error => { console.error(error.message); engine.close(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local KataGo bridge: http://127.0.0.1:${port}\nAllowed app origins: ${origins.join(', ')}\nModel loading may take a moment. This bridge is local-only.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { engine.close(); server.closeAllConnections(); server.close(); });
}
