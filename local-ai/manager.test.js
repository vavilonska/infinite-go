import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAIManager } from './manager.js';
import { installationPlan } from './manifest.js';
import { request } from 'node:http';

async function managerFixture(t, overrides = {}) {
  let installed = false, starts = 0, stops = 0, installs = 0;
  const plan = installationPlan('win32', 'x64');
  const installer = {
    plan,
    async ready() { return installed ? { bin: 'fake', model: 'fake', config: 'fake' } : null; },
    async install({ signal }) { installs++; await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 35); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true }); }); installed = true; },
    ...overrides.installer,
  };
  const manager = createLocalAIManager({ appOrigin: 'http://localhost:8000', installer, onStart: async () => { starts++; return { providerUrl: 'http://127.0.0.1:18080' }; }, onStop: async () => { stops++; }, ...overrides, installer });
  await new Promise(resolve => manager.server.listen(0, '127.0.0.1', resolve));
  t.after(() => manager.close());
  const port = manager.server.address().port;
  function call(path = '/status', { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, method, path, headers: { Origin: 'http://localhost:8000', Authorization: `Bearer ${manager.ownerToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, headers: res.headers }); });
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { manager, installer, plan, call, installed: () => { installed = true; }, counts: () => ({ starts, stops, installs }) };
}
const settle = async fixture => { for (let i = 0; i < 40; i++) { const status = await fixture.manager.getStatus(); if (status.state !== 'installing') return status; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Fixture did not settle'); };

test('owner API requires exact origin, ephemeral capability and bound loopback Host', async t => {
  const f = await managerFixture(t);
  assert.equal((await f.call('/plan')).status, 200);
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: '' }, { Authorization: '' }, { Authorization: 'Bearer wrong' }, { Host: 'evil.test' }, { Host: '127.0.0.1:9999' }]) assert.equal((await f.call('/status', { headers })).status, 403);
  assert.equal((await f.call('/plan', { headers: { Authorization: 'Bearer ' + 'é'.repeat(64) } })).status, 403);
  assert.match(f.manager.ownerToken, /^[a-f0-9]{64}$/);
  assert.equal((await f.call()).headers['cache-control'], 'no-store');
});
test('preflight only allows the owner origin and exact API headers', async t => {
  const f = await managerFixture(t);
  assert.equal((await f.call('/install', { method: 'OPTIONS', headers: { Authorization: '', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } })).status, 204);
  assert.equal((await f.call('/install', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } })).status, 403);
  assert.equal((await f.call('/install', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-remote-url' } })).status, 403);
});
test('install rejects missing approval, stale plan and any arbitrary URL/path fields', async t => {
  const f = await managerFixture(t);
  for (const body of [{ consent: false, manifestId: f.plan.manifestId }, { consent: true, manifestId: 'stale' }, { consent: true, manifestId: f.plan.manifestId, url: 'https://evil.test' }, { consent: true }, { consent: true, manifestId: f.plan.manifestId, dataDir: '/tmp' }]) assert.equal((await f.call('/install', { method: 'POST', body })).status, 400);
  assert.equal(f.counts().installs, 0);
});
test('install is single flight; start is explicit and idempotent; stop tears down', async t => {
  const f = await managerFixture(t);
  assert.equal((await f.call('/start', { method: 'POST', body: {} })).status, 409);
  assert.equal((await f.call('/install', { method: 'POST', body: { manifestId: f.plan.manifestId, consent: true } })).status, 202);
  assert.equal((await f.call('/install', { method: 'POST', body: { manifestId: f.plan.manifestId, consent: true } })).status, 409);
  assert.equal((await f.call('/start', { method: 'POST', body: {} })).status, 409);
  assert.equal((await settle(f)).installed, true); assert.equal(f.counts().starts, 0);
  let response = await f.call('/start', { method: 'POST', body: {} }); assert.equal(response.status, 200); assert.equal(response.body.providerUrl, 'http://127.0.0.1:18080');
  await f.call('/start', { method: 'POST', body: {} }); assert.equal(f.counts().starts, 1);
  response = await f.call('/stop', { method: 'POST', body: {} }); assert.equal(response.body.state, 'idle'); assert.equal(response.body.providerUrl, undefined);
});
test('cancel and close stop pending installation without starting an engine', async t => {
  const f = await managerFixture(t);
  await f.call('/install', { method: 'POST', body: { manifestId: f.plan.manifestId, consent: true } });
  assert.equal((await f.call('/cancel', { method: 'POST', body: {} })).status, 202);
  assert.match((await settle(f)).error, /cancelled/); assert.equal(f.counts().starts, 0);
  await f.call('/install', { method: 'POST', body: { manifestId: f.plan.manifestId, consent: true } });
  await f.manager.close(); assert.equal(f.manager.server.listening, false); assert.equal(f.counts().starts, 0);
});
test('closing during asynchronous startup still stops the newly created engine', async t => {
  let completeStart, enteredStart, stopCount = 0;
  const entered = new Promise(resolve => { enteredStart = resolve; });
  const f = await managerFixture(t, { onStart: async () => { enteredStart(); return await new Promise(resolve => { completeStart = resolve; }); }, onStop: async () => { stopCount++; } });
  f.installed();
  const response = f.call('/start', { method: 'POST', body: {} }).catch(error => ({ error }));
  await entered; const closing = f.manager.close();
  completeStart({ providerUrl: 'http://127.0.0.1:18080' });
  await closing; await response; assert.equal(stopCount, 1); assert.equal(f.manager.server.listening, false);
});

test('manager closes its control server even if engine shutdown callback fails', async t => {
  const f = await managerFixture(t, { onStop: async () => { throw new Error('Fixture shutdown failure'); } });
  f.installed(); await f.call('/start', { method: 'POST', body: {} });
  await assert.rejects(f.manager.close(), /Fixture shutdown failure/); assert.equal(f.manager.server.listening, false);
});
