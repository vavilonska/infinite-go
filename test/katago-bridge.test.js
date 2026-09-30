import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { buildQuery, createBridge, createKataGoClient, fromGtp, toGtp } from '../katago-bridge.js';

const request = changes => ({ requestId: 'req-1', nodeId: '1:0', boardSize: 9, komi: 7.5, rules: 'chinese-positional-superko', history: [], ...changes });

test('KataGo query preserves full inherited moves and passes, skips resume, and sets exact rules', () => {
  const history = [{ type: 'play', color: 'B', at: 0 }, { type: 'pass', color: 'W' }, { type: 'pass', color: 'B' }, { type: 'resume' }, { type: 'play', color: 'W', at: 80 }];
  const { query, state } = buildQuery(request({ history }));
  assert.deepEqual(query.moves, [['B', 'A9'], ['W', 'pass'], ['B', 'pass'], ['W', 'J1']]);
  assert.equal(query.rules.ko, 'POSITIONAL');
  assert.equal(query.rules.scoring, 'AREA');
  assert.equal(query.rules.suicide, false);
  assert.equal(query.overrideSettings.ignorePreRootHistory, false);
  assert.equal(query.maxVisits, 64);
  assert.equal(state.toPlay, 'B');
  for (const size of [9, 13, 19]) for (let at = 0; at < size ** 2; at++) assert.deepEqual(fromGtp(toGtp(at, size), size), { type: 'play', at });
  assert.deepEqual(fromGtp('pass', 9), { type: 'pass' });
  assert.throws(() => fromGtp('I5', 9));
  assert.throws(() => fromGtp('T19', 9));
});

test('KataGo query rejects invalid histories and unsupported settings', () => {
  for (const changes of [
    { rules: 'chinese' }, { boardSize: 5 }, { komi: 0.1 }, { requestId: '' }, { extra: true },
    { history: [{ type: 'play', color: 'W', at: 0 }] },
    { history: [{ type: 'resume' }] }, { history: [{ type: 'play', color: 'B', at: 81 }] },
  ]) assert.throws(() => buildQuery(request(changes)));
});

function fakeProcess() {
  const process = new EventEmitter();
  process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = () => { process.emit('exit', 0); process.stdout.end(); };
  const queries = [];
  process.stdin.on('data', chunk => queries.push(JSON.parse(chunk.toString())));
  return { process, queries };
}
test('client owns a process, maps asynchronous IDs, fixes Black perspective, and cancels individual searches', async () => {
  const fake = fakeProcess();
  let args;
  const client = createKataGoClient({ bin: 'katago', model: 'model.bin.gz', spawnProcess: (bin, argv) => { args = argv; return fake.process; } });
  try {
    assert.ok(args.includes('-quit-without-waiting'));
    assert.ok(args.some(value => value.includes('reportAnalysisWinratesAs=BLACK')));
    const resultPromise = client.analyze(request({ history: [{ type: 'play', color: 'B', at: 0 }] }));
    const query = fake.queries[0];
    assert.notEqual(query.id, 'req-1');
    fake.process.stdout.write(JSON.stringify({ id: query.id, isDuringSearch: false, rootInfo: { winrate: 0.8, visits: 64 }, moveInfos: [{ move: 'A9', order: 0 }, { move: 'B9', order: 1 }] }) + '\n');
    const result = await resultPromise;
    assert.equal(result.blackWinrate, 0.8); // White to play does not flip Black's value.
    assert.deepEqual(result.move, { type: 'play', at: 1 }); // Illegal first candidate was discarded.
    assert.equal(result.requestId, 'req-1');
    const cancelled = client.analyze(request({ requestId: 'cancel-me' }));
    const rejected = assert.rejects(cancelled, /cancelled/);
    assert.equal(client.cancel('cancel-me'), true);
    await rejected;
    assert.equal(fake.queries.at(-1).action, 'terminate');
    assert.equal(client.cancel('cancel-me'), false);
    const first = client.analyze(request({ requestId: 'first' }));
    const firstId = fake.queries.at(-1).id;
    const second = client.analyze(request({ requestId: 'second' }));
    const secondId = fake.queries.at(-1).id;
    for (const [id, winrate] of [[secondId, 0.2], [firstId, 0.7]]) fake.process.stdout.write(JSON.stringify({ id, isDuringSearch: false, rootInfo: { winrate, visits: 64 }, moveInfos: [{ move: 'pass', order: 0 }] }) + '\n');
    assert.equal((await first).blackWinrate, 0.7);
    assert.equal((await second).blackWinrate, 0.2);
  } finally { client.close(); }
});

test('HTTP bridge restricts origins, validates requests, and exposes cancellation and capabilities', async t => {
  const received = [];
  const engine = { alive: true, maxVisits: 64, analyze: async body => { received.push(body); return { requestId: body.requestId, nodeId: body.nodeId, blackWinrate: 0.5, move: { type: 'pass' } }; }, cancel: id => id === 'req-1', close() {} };
  const server = createBridge({ engine });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, origin = 'http://localhost:8000') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const capabilities = await fetch(base + '/capabilities');
  assert.equal((await capabilities.json()).winratePerspective, 'black');
  const result = await post('/generate-move', request());
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), 'http://localhost:8000');
  assert.deepEqual((await result.json()).move, { type: 'pass' });
  assert.equal(received.length, 1);
  assert.equal((await post('/analyze', request(), 'https://example.com')).status, 403);
  assert.equal((await post('/analyze', request({ history: 'board snapshot' }))).status, 400);
  assert.equal((await post('/cancel', { requestId: 'req-1' })).status, 200);
  const cancel = await post('/cancel', { requestId: 'missing' });
  assert.equal((await cancel.json()).cancelled, false);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/capabilities', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHost, 403);
});
