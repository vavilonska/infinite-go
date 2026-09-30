import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.js';

async function host(t, options = {}) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  return { request, origin };
}
async function twoPlayers(request) {
  const created = await request('/api/rooms', { method: 'POST', body: { size: 9, komi: 7.5 } });
  assert.equal(created.status, 201);
  const black = created.data;
  const joined = await request(`/api/rooms/${black.code}/join`, { method: 'POST', body: {} });
  assert.equal(joined.status, 200);
  return { black, white: joined.data, path: `/api/rooms/${black.code}` };
}
const action = (request, path, token, body) => request(`${path}/actions`, { method: 'POST', token, body });

test('two clients get distinct colors and private reconnect tokens', async t => {
  const { request } = await host(t);
  const { black, white, path } = await twoPlayers(request);
  assert.equal(black.role, 'B');
  assert.equal(white.role, 'W');
  assert.match(black.code, /^[A-Z2-9]{6}$/);
  assert.equal(black.token.length, 43);
  assert.notEqual(black.token, white.token);
  assert.deepEqual(white.players, { B: true, W: true });
  const reconnected = await request(path, { token: black.token });
  assert.equal(reconnected.status, 200);
  assert.equal(reconnected.data.role, 'B');
  assert.equal(reconnected.data.revision, white.revision);
  assert.equal(JSON.stringify(reconnected.data).includes(white.token), false);
  assert.equal(JSON.stringify(reconnected.data).includes(black.token), false);
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, { token: 'a'.repeat(43) })).status, 401);
  assert.equal((await request(`${path}/join`, { method: 'POST', body: {} })).status, 409);
});

test('room directory reveals only seat occupancy, allowing a single open room to be found', async t => {
  const { request } = await host(t);
  assert.deepEqual((await request('/api/rooms')).data, { rooms: [] });
  const first = await request('/api/rooms', { method: 'POST', body: {} });
  const listing = await request('/api/rooms');
  assert.deepEqual(listing.data, { rooms: [{ code: first.data.code, players: { B: true, W: false } }] });
  assert.equal(JSON.stringify(listing.data).includes(first.data.token), false);
  assert.equal(JSON.stringify(listing.data).includes('game'), false);
  const open = listing.data.rooms.filter(room => !room.players.W);
  assert.equal(open.length, 1);
  assert.equal((await request(`/api/rooms/${open[0].code}/join`, { method: 'POST', body: {} })).status, 200);
  assert.deepEqual((await request('/api/rooms')).data.rooms[0].players, { B: true, W: true });
});

test('turn ownership and stale revisions protect authoritative state', async t => {
  const { request } = await host(t);
  const { black, white, path } = await twoPlayers(request);
  const first = { revision: white.revision, type: 'play', id: 1, index: 0, at: 0 };
  assert.equal((await action(request, path, white.token, first)).status, 403);
  const moved = await action(request, path, black.token, first);
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.data.game.lines[0].history, [{ type: 'play', color: 'B', at: 0 }]);
  const stale = await action(request, path, black.token, first);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.revision, moved.data.revision);
  assert.deepEqual(stale.data.game, moved.data.game);
  assert.equal((await action(request, path, black.token, { ...first, revision: moved.data.revision, index: 1, at: 1 })).status, 403);
  const next = await action(request, path, white.token, { ...first, revision: moved.data.revision, index: 1, at: 1 });
  assert.equal(next.status, 200);
  const reconnect = await request(path, { token: black.token });
  assert.deepEqual(reconnect.data.game, next.data.game);
  assert.equal(reconnect.data.game.lines[0].history[1].color, 'W');
});

test('concurrent same-revision moves commit exactly once', async t => {
  const { request } = await host(t);
  const { black, white, path } = await twoPlayers(request);
  const results = await Promise.all([0, 1].map(at => action(request, path, black.token, { revision: white.revision, type: 'play', id: 1, index: 0, at })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const state = await request(path, { token: black.token });
  assert.equal(state.data.game.lines[0].history.length, 1);
});

test('historical branches preserve the authenticated color and authoritative timeline queue', async t => {
  const { request } = await host(t);
  const { black, white, path } = await twoPlayers(request);
  let result = await action(request, path, black.token, { revision: white.revision, type: 'play', id: 1, index: 0, at: 0 });
  result = await action(request, path, white.token, { revision: result.data.revision, type: 'play', id: 1, index: 1, at: 1 });
  const wrongHistory = await action(request, path, black.token, { revision: result.data.revision, type: 'play', id: 1, index: 1, at: 2 });
  assert.equal(wrongHistory.status, 422);
  result = await action(request, path, black.token, { revision: result.data.revision, type: 'play', id: 1, index: 0, at: 2 });
  assert.equal(result.status, 200);
  assert.equal(result.data.game.lines.length, 2);
  assert.deepEqual(result.data.game.lines[1].history, [{ type: 'play', color: 'B', at: 2 }]);
  assert.deepEqual(result.data.game.lines.map(line => line.weight), [{ n: '1', d: '2' }, { n: '1', d: '2' }]);
  const skipQueue = await action(request, path, white.token, { revision: result.data.revision, type: 'play', id: 2, index: 1, at: 3 });
  assert.equal(skipQueue.status, 422);
  result = await action(request, path, black.token, { revision: result.data.revision, type: 'play', id: 1, index: 2, at: 3 });
  assert.equal(result.status, 200);
  result = await action(request, path, white.token, { revision: result.data.revision, type: 'play', id: 2, index: 1, at: 4 });
  assert.equal(result.status, 200);
  assert.equal(result.data.game.lines[1].history[1].color, 'W');
});

test('both players must separately approve scoring; a dispute clears approval', async t => {
  const { request } = await host(t);
  const { black, white, path } = await twoPlayers(request);
  let revision = white.revision;
  const run = async (token, body) => {
    const result = await action(request, path, token, { revision, id: 1, ...body });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    revision = result.data.revision;
    return result.data;
  };
  await run(black.token, { type: 'play', index: 0, at: 0 });
  await run(white.token, { type: 'play', index: 1, at: 1 });
  await run(black.token, { type: 'play', index: 2, at: null });
  const scoring = await run(white.token, { type: 'play', index: 3, at: null });
  assert.equal(scoring.game.lines[0].status, 'scoring');
  assert.equal((await action(request, path, black.token, { revision, type: 'approveScore', id: 1, color: 'W' })).status, 403);
  const approved = await run(black.token, { type: 'approveScore' });
  assert.deepEqual(approved.game.lines[0].approvals, ['B']);
  const dead = await run(white.token, { type: 'toggleDead', at: 0 });
  assert.deepEqual(dead.game.lines[0].dead, [0]);
  assert.deepEqual(dead.game.lines[0].approvals, []);
  await run(black.token, { type: 'approveScore' });
  const settled = await run(white.token, { type: 'approveScore' });
  assert.equal(settled.game.lines[0].status, 'settled');
  assert.ok(settled.game.lines[0].result);
  assert.equal((await action(request, path, black.token, { revision, type: 'resume', id: 1 })).status, 422);
});

test('either participant can resume unsettled scoring but cannot take the next player’s move', async t => {
  const { request } = await host(t);
  const { black, white, path } = await twoPlayers(request);
  let result = await action(request, path, black.token, { revision: white.revision, type: 'play', id: 1, index: 0, at: null });
  result = await action(request, path, white.token, { revision: result.data.revision, type: 'play', id: 1, index: 1, at: null });
  result = await action(request, path, white.token, { revision: result.data.revision, type: 'resume', id: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.data.game.lines[0].status, 'playing');
  assert.deepEqual(result.data.game.queue, [1]);
  assert.equal((await action(request, path, white.token, { revision: result.data.revision, type: 'play', id: 1, index: 3, at: 0 })).status, 403);
});

test('malformed inputs, unknown routes, cross-site writes, and filesystem access are rejected', async t => {
  const { request, origin } = await host(t);
  assert.equal((await request('/api/rooms', { method: 'POST', body: { size: 5 } })).status, 400);
  assert.equal((await request('/api/rooms', { method: 'POST', body: { size: null } })).status, 400);
  assert.equal((await request('/api/rooms', { method: 'POST', body: [] })).status, 400);
  assert.equal((await request('/api/rooms', { method: 'POST', body: {}, headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await request('/api/rooms', { method: 'POST', body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/package.json')).status, 404);
  assert.equal((await request('/server.js')).status, 404);
  assert.equal((await request('/.git/config')).status, 404);
  assert.equal((await request('/api/rooms/AAAAAA')).status, 404);
  const malformed = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extra: 'x'.repeat(5000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await request('/api/rooms', { method: 'POST', body: {}, headers: { 'Content-Type': 'application/jsonp' } })).status, 415);
  const { black, white, path } = await twoPlayers(request);
  for (const change of [{ at: -1 }, { at: 81 }, { at: '0' }, { index: -1 }, { revision: '1' }, { id: null }, { extra: true }]) {
    const result = await action(request, path, black.token, { revision: white.revision, type: 'play', id: 1, index: 0, at: 0, ...change });
    assert.equal(result.status, 400);
  }
  const valid = await action(request, path, black.token, { revision: white.revision, type: 'play', id: 1, index: 0, at: 0 });
  const illegal = await action(request, path, white.token, { revision: valid.data.revision, type: 'play', id: 1, index: 1, at: 0 });
  assert.equal(illegal.status, 422);
  const unchanged = await request(path, { token: black.token });
  assert.deepEqual(unchanged.data.game, valid.data.game);
  assert.equal(unchanged.data.revision, valid.data.revision);
});

test('server health, static assets, and bounded room creation', async t => {
  const { request, origin } = await host(t, { maxRooms: 1 });
  assert.deepEqual((await request('/api/health')).data, { ok: true, mode: 'lan' });
  const asset = await fetch(`${origin}/engine.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await asset.text(), /createGame/);
  assert.equal((await request('/api/rooms', { method: 'POST', body: {}, headers: { Origin: origin } })).status, 201);
  assert.equal((await request('/api/rooms', { method: 'POST', body: {} })).status, 503);
});
