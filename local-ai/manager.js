import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LocalAIInstaller } from './installer.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(body)); };
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
async function bodyOf(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'Send application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024) fail(413, 'Request is too large'); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
  if (!object(body)) fail(400, 'Invalid request'); return body;
}
function fields(body, allowed) { if (Object.keys(body).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(body, key))) fail(400, 'Invalid request fields'); }

/** Desktop launcher ONLY. Bind server to 127.0.0.1:0. Never mount on the LAN server. */
export function createLocalAIManager({ dataDir, appOrigin, onStart, onStop = async () => {}, installer = new LocalAIInstaller({ dataDir }) } = {}) {
  const originURL = new URL(appOrigin);
  if (originURL.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(originURL.hostname) || originURL.origin !== appOrigin) throw new Error('The owner app origin must be an exact local HTTP origin');
  if (typeof onStart !== 'function') throw new Error('A desktop engine start callback is required');
  const ownerToken = randomBytes(32).toString('hex'); // Temporary per-process capability; never saved.
  let state = 'idle', error = '', progress = null, running = null, operation = null, controller = null, closed = false;
  async function getStatus() {
    let installed = false;
    try { installed = !!await installer.ready(); } catch (cause) { if (!error) error = cause.message; }
    if (running?.isAlive && !running.isAlive()) { error = 'KataGo stopped unexpectedly. Stop it, then start again to retry.'; }
    return { state, installed, supported: installer.plan.supported, error, progress, ...(running?.providerUrl ? { providerUrl: running.providerUrl } : {}) };
  }
  async function stop() {
    if (running) { try { await onStop(); } finally { running = null; state = 'idle'; } }
  }
  function install(body) {
    if (state === 'installing' || operation || running) fail(409, 'Another local AI operation is active');
    if (body.consent !== true || body.manifestId !== installer.plan.manifestId) fail(400, 'Approve the displayed download plan first');
    if (!installer.plan.supported) fail(400, installer.plan.reason);
    state = 'installing'; error = ''; progress = null; controller = new AbortController();
    operation = installer.install({ ...body, signal: controller.signal, onProgress: value => { progress = value; } })
      .then(() => { state = 'idle'; })
      .catch(cause => { state = 'idle'; error = controller.signal.aborted ? 'Installation cancelled. Nothing incomplete is enabled; you can retry.' : cause.message; })
      .finally(() => { operation = null; controller = null; });
  }
  const server = createServer(async (req, res) => {
    try {
      if (closed) fail(503, 'Desktop launcher is closing');
      if (!loopback(req.socket.remoteAddress)) fail(403, 'Only the desktop owner can control local AI');
      const expectedHost = `127.0.0.1:${server.address()?.port}`;
      if (req.headers.host !== expectedHost || req.headers.origin !== appOrigin) fail(403, 'Local AI owner origin mismatch');
      res.setHeader('Access-Control-Allow-Origin', appOrigin); res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        if (!['GET', 'POST'].includes(req.headers['access-control-request-method'])) fail(403, 'Unsupported preflight');
        const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        if (requested.some(value => !['authorization', 'content-type'].includes(value))) fail(403, 'Unsupported preflight headers');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.writeHead(204); res.end(); return;
      }
      const auth = req.headers.authorization || '', expected = `Bearer ${ownerToken}`;
      if (!/^Bearer [a-f0-9]{64}$/.test(auth) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) fail(403, 'Owner capability is missing or expired. Reopen the desktop launcher.');
      if (req.url === '/plan' && req.method === 'GET') { json(res, 200, installer.plan); return; }
      if (req.url === '/status' && req.method === 'GET') { json(res, 200, await getStatus()); return; }
      if (req.method !== 'POST' || !['/install', '/start', '/stop', '/cancel'].includes(req.url)) fail(404, 'Not found');
      const body = await bodyOf(req);
      if (req.url === '/install') { fields(body, ['manifestId', 'consent']); install(body); json(res, 202, await getStatus()); return; }
      fields(body, []);
      if (req.url === '/cancel') { controller?.abort(); json(res, 202, await getStatus()); return; }
      if (operation || state === 'starting' || state === 'stopping') fail(409, 'Another local AI operation is active');
      if (req.url === '/stop') { state = 'stopping'; try { await stop(); state = 'idle'; error = ''; } catch (cause) { state = 'idle'; throw cause; } json(res, 200, await getStatus()); return; }
      if (running) { json(res, 200, await getStatus()); return; }
      state = 'starting'; error = '';
      operation = (async () => {
        try {
          const files = await installer.ready({ verify: true });
          if (!files) fail(409, 'Download and install local AI first');
          if (closed) fail(503, 'Desktop launcher is closing');
          const started = await onStart(files);
          if (!started?.providerUrl) throw new Error('The desktop engine did not return a provider URL');
          const provider = new URL(started.providerUrl);
          if (provider.protocol !== 'http:' || provider.hostname !== '127.0.0.1' || provider.pathname !== '/' || provider.search || provider.hash || provider.username || provider.password) throw new Error('The desktop engine must bind a loopback provider');
          running = started; state = 'running';
        } catch (cause) { await Promise.resolve().then(onStop).catch(() => {}); state = 'idle'; error = cause.message; throw cause; }
      })();
      try { await operation; } finally { operation = null; }
      json(res, 200, await getStatus());
    } catch (cause) { json(res, cause.status || 500, { error: cause.message }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return {
    server, ownerToken, getStatus,
    async close() {
      if (closed) return; closed = true; controller?.abort();
      if (operation) await operation.catch(() => {});
      try { await stop(); }
      finally { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
    },
  };
}
