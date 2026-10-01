import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import online from '../cloud/online-entry.js';

test('online assets accept version queries while API failures remain JSON and never fetch assets', async () => {
  const fetched = [];
  const env = { ASSETS: { fetch(request) { fetched.push(request); return new Response('asset', { headers: { 'Content-Type': 'text/html' } }); } } };
  for (const path of ['/', '/app.js?v=123', '/assets/favicon.png', '/missing.js']) {
    const request = new Request('https://rooms.example' + path);
    assert.equal(await (await online.fetch(request, env)).text(), 'asset');
    assert.equal(fetched.at(-1), request);
  }
  const failures = [
    ['/api', {}, 404], ['/api/missing', {}, 404],
    ['/api/health?token=secret', {}, 400],
    ['/api/health', { headers: { Origin: 'https://unapproved.example' } }, 403],
    ['/api/matchmaking/status', {}, 503],
    ['/api/rooms/AAAAAAAAAAAA/events', {}, 426],
    ['/api/rooms/AAAAAAAAAAAA/actions', {}, 405],
    ['/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }, 400],
  ];
  for (const [path, options, status] of failures) {
    const response = await online.fetch(new Request('https://rooms.example' + path, options), env);
    assert.equal(response.status, status, path);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(fetched.length, 4);
  const health = await online.fetch(new Request('https://rooms.example/api/health'), { ...env, MATCHMAKING: {} });
  assert.deepEqual(await health.json(), { ok: true, mode: 'cloud', protocol: 1, features: { matchmaking: true } });
  assert.equal(fetched.length, 4);
});

test('room WebSocket requests are passed intact to the existing authority', async () => {
  let forwarded;
  const request = new Request('https://rooms.example/api/rooms/AAAAAAAAAAAA/events', { headers: { Upgrade: 'websocket' } });
  const response = await online.fetch(request, {
    ASSETS: { fetch() { assert.fail('A WebSocket must not fetch assets'); } },
    ROOMS: { getByName(code) { assert.equal(code, 'AAAAAAAAAAAA'); return { fetch(value) { forwarded = value; return new Response('room'); } }; } },
  });
  assert.equal(forwarded, request);
  assert.equal(await response.text(), 'room');
});

test('Cloudflare build is a clean frontend whitelist with same-origin API and network-only API navigation', async () => {
  await promisify(execFile)(process.execPath, ['cloud/build.mjs']);
  const files = (await readdir('cloud/dist', { recursive: true })).map(path => path.replaceAll('\\', '/')).sort();
  assert.deepEqual(files, [
    '.nojekyll', 'LICENSE', 'NOTICE', 'ai.js', 'annotations.js', 'app.js', 'assets',
    'assets/apple-touch-icon.png', 'assets/favicon.png', 'assets/gameplay.jpg', 'assets/icon-192.png',
    'assets/icon.png', 'assets/social-preview.jpg', 'deployment.js', 'engine.js', 'host-address.js',
    'index.html', 'manifest.webmanifest', 'matchmaking-client.js', 'nigiri.js', 'providers.js',
    'remote-config.js', 'remote-room.js', 'style.css', 'sw.js', 'tree.js',
  ].sort());
  assert.equal(await readFile('cloud/dist/remote-config.js', 'utf8'), 'export const DEFAULT_REMOTE_ENDPOINT = globalThis.location.origin;\nexport const ONLINE_PLAY_URL = globalThis.location.origin;\n');
  assert.match(await readFile('remote-config.js', 'utf8'), /DEFAULT_REMOTE_ENDPOINT = ""/);
  const config = JSON.parse(await readFile('cloud/wrangler.jsonc', 'utf8'));
  assert.deepEqual(config.assets, { directory: './dist', binding: 'ASSETS', run_worker_first: ['/api', '/api/*'], not_found_handling: 'none' });
  assert.deepEqual(config.migrations, [
    { tag: 'v1', new_sqlite_classes: ['GameRoom', 'RoomCreationLimiter'] },
    { tag: 'v2', new_sqlite_classes: ['MatchmakingQueue'] },
  ]);
  const handlers = {};
  let precached;
  runInNewContext(await readFile('cloud/dist/sw.js', 'utf8'), {
    URL, self: { location: { origin: 'https://rooms.example' }, addEventListener(name, callback) { handlers[name] = callback; } },
    caches: { open: async () => ({
      addAll: async files => { precached = Array.from(files); },
      match: async key => { assert.equal(key, './'); return new Response('cached page'); },
    }) },
  });
  let installation;
  handlers.install({ waitUntil(promise) { installation = promise; } });
  await installation;
  assert.ok(precached.includes('./'));
  assert.ok(!precached.includes('index.html'));
  for (const pathname of ['/api', '/api/health', '/api/rooms/AAAAAAAAAAAA']) {
    handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://rooms.example' + pathname }, respondWith() { assert.fail('API navigation must bypass offline HTML'); } });
  }
  let page;
  handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://rooms.example/' }, respondWith(response) { page = response; } });
  assert.equal(await (await page).text(), 'cached page');
});
