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
  const freeChoice = await action(request, path, white.token, { revision: result.data.revision, type: 'play', id: 2, index: 1, at: 3 });
  assert.equal(freeChoice.status, 200);result=freeChoice;
  result = await action(request, path, black.token, { revision: result.data.revision, type: 'play', id: 1, index: 2, at: 3 });
  assert.equal(result.status, 200);
  result = await action(request, path, white.token, { revision: result.data.revision, type: 'play', id: 1, index: 3, at: 4 });
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
  assert.deepEqual((await request('/api/health')).data, { ok: true, mode: 'lan', features: { spectating: true, restoreGame: true, resultModes: true } });
  const asset = await fetch(`${origin}/engine.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await asset.text(), /createGame/);
  assert.equal((await request('/api/rooms', { method: 'POST', body: {}, headers: { Origin: origin } })).status, 201);
  assert.equal((await request('/api/rooms', { method: 'POST', body: {} })).status, 503);
});
test('room configuration validates and retains branch thresholds', async t => {
  const { request } = await host(t);
  assert.equal((await request('/api/rooms', {method:'POST',body:{branchLimitExponent:1}})).status,400);
  for(const exponent of [null,2,9,12]){const result=await request('/api/rooms',{method:'POST',body:{branchLimitExponent:exponent}});assert.equal(result.status,201);assert.equal(result.data.game.branchLimitExponent,exponent);}
});
test('authoritative pruning enforces roles, ledger compensation, and archived route protection',async t=>{
 const {request}=await host(t);const created=await request('/api/rooms',{method:'POST',body:{pruningMode:'komi',compensationC:'8'}});const black=created.data;const white=(await request(`/api/rooms/${black.code}/join`,{method:'POST',body:{}})).data;const path=`/api/rooms/${black.code}`;let revision=white.revision;
 async function run(token,move){const response=await action(request,path,token,{revision,...move});assert.equal(response.status,200,JSON.stringify(response.data));revision=response.data.revision;return response.data;}
 await run(black.token,{type:'play',id:1,index:0,at:0});await run(white.token,{type:'play',id:1,index:1,at:1});await run(black.token,{type:'play',id:1,index:0,at:2});
 assert.equal((await action(request,path,white.token,{revision,type:'prune',id:1,index:1})).status,422);
 const pruned=await run(black.token,{type:'prune',id:1,index:1});assert.deepEqual(pruned.game.komiCompensation,{n:'4',d:'1'});assert.equal(pruned.game.lines.length,1);assert.deepEqual(pruned.game.lines[0].weight,{n:'1',d:'1'});assert.equal(pruned.game.archives.length,1);
 await run(white.token,{type:'play',id:2,index:1,at:3});const blocked=await action(request,path,black.token,{revision,type:'play',id:2,index:0,at:0});assert.equal(blocked.status,422);assert.match(blocked.data.error,/archived/);
});
test('LAN permits immediate response and free board choice but denies an early repeated source',async t=>{const {request}=await host(t);const {black,white,path}=await twoPlayers(request);let revision=white.revision;
 async function run(token,id,index,at){const r=await action(request,path,token,{revision,type:'play',id,index,at});assert.equal(r.status,200,JSON.stringify(r.data));revision=r.data.revision;return r.data;}
 await run(black.token,1,0,0);await run(white.token,1,1,1);await run(black.token,1,0,2);await run(white.token,2,1,3);await run(black.token,1,2,4);await run(white.token,1,3,5);
 const denied=await action(request,path,black.token,{revision,type:'play',id:1,index:4,at:6});assert.equal(denied.status,422);
 const wrongColor=await action(request,path,white.token,{revision,type:'play',id:2,index:2,at:7});assert.equal(wrongColor.status,403);
 await run(black.token,2,2,7);const resumed=await run(black.token,1,4,6);assert.equal(resumed.game.lines[0].history.length,5);assert.ok(resumed.game.turns.B.epoch>1);
});

test('LAN nigiri keeps seats separate, hides count, lets winner select color and freezes setup',async t=>{
 const {request}=await host(t);
 const created=await request('/api/rooms',{method:'POST',body:{colorSetup:'nigiri'}}),a=created.data,path=`/api/rooms/${a.code}`;
 assert.equal(a.seat,'A');assert.equal(a.role,null);assert.deepEqual(a.setup,{phase:'guess'});
 const b=(await request(`${path}/join`,{method:'POST',body:{}})).data;assert.equal(b.seat,'B');assert.equal(b.role,null);assert.deepEqual(b.setup,{phase:'guess'});
 assert.equal((await action(request,path,a.token,{type:'play',id:1,index:0,at:0,revision:b.revision})).status,409);
 const setup=(token,body)=>request(`${path}/setup`,{method:'POST',token,body});
 assert.equal((await setup(a.token,{type:'guess',guess:'odd',revision:b.revision})).status,403);
 const reveal=await setup(b.token,{type:'guess',guess:'odd',revision:b.revision});assert.equal(reveal.status,200);const state=reveal.data.setup;assert.ok(state.count>=1&&state.count<=20);assert.equal(state.winner,state.count%2?'B':'A');
 assert.equal((await setup(b.token,{type:'guess',guess:'even',revision:reveal.data.revision})).status,422);
 const winner=state.winner==='A'?a:b,loser=state.winner==='A'?b:a;
 assert.equal((await setup(loser.token,{type:'choose',color:'W',revision:reveal.data.revision})).status,422);
 const chosen=await setup(winner.token,{type:'choose',color:'W',revision:reveal.data.revision});assert.equal(chosen.status,200);assert.equal(chosen.data.role,'W');
 const black=(await request(path,{token:loser.token})).data;assert.equal(black.role,'B');assert.equal((await request(path,{token:winner.token})).data.role,'W');
 const played=await action(request,path,loser.token,{type:'play',id:1,index:0,at:0,revision:black.revision});assert.equal(played.status,200);
 assert.equal((await setup(winner.token,{type:'choose',color:'B',revision:played.data.revision})).status,409);
});
test('manual LAN color choice can give the host White',async t=>{const {request}=await host(t);const a=(await request('/api/rooms',{method:'POST',body:{hostColor:'W',colorSetup:'manual'}})).data;assert.equal(a.role,'W');assert.equal((await request(`/api/rooms/${a.code}/join`,{method:'POST',body:{}})).data.role,'B');});

test('LAN watch is read-only, leaves seats open and reveals no player credentials', async t=>{
 const {request}=await host(t);const created=await request('/api/rooms',{method:'POST',body:{colorSetup:'nigiri'}});const a=created.data,path='/api/rooms/'+a.code;
 const view=await request(path+'/watch');assert.equal(view.status,200);assert.equal(view.data.spectator,true);assert.equal(view.data.seat,null);assert.equal(view.data.role,null);assert.equal(view.data.players.W,false);assert.equal(view.data.token,undefined);assert.equal(view.data.setup.count,undefined);assert.equal(JSON.stringify(view.data).includes(a.token),false);
 for(const suffix of ['/actions','/setup'])assert.equal((await request(path+suffix,{method:'POST',body:{}})).status,401);
 assert.equal((await request(path+'/watch',{method:'POST',body:{}})).status,405);
 assert.equal((await request(path+'/join',{method:'POST',body:{}})).status,200);
 assert.equal((await request(path+'/watch')).data.players.W,true);
});

test('LAN restores new rooms and requires both authenticated players to confirm',async t=>{
 const {request}=await host(t);const E=await import('../engine.js');const game=E.createGame(13,7.5,9,{resultMode:'weighted-margin',pruningMode:'komi'});E.play(game,1,0,0);
 const made=await request('/api/rooms',{method:'POST',body:{restoreGame:game,hostColor:'W'}});assert.equal(made.status,201);const a=made.data,p='/api/rooms/'+a.code;assert.equal(a.game.size,13);assert.equal(a.game.resultMode,'weighted-margin');
 const b=(await request(p+'/join',{method:'POST',body:{}})).data;
 const action={type:'play',revision:b.revision,id:1,index:1,at:1};assert.equal((await request(p+'/actions',{method:'POST',token:a.token,body:action})).status,409);
 assert.equal((await request(p+'/restore-confirm',{method:'POST',body:{revision:b.revision}})).status,401);
 const one=await request(p+'/restore-confirm',{method:'POST',token:a.token,body:{revision:b.revision}});assert.equal(one.status,200);
 const two=await request(p+'/restore-confirm',{method:'POST',token:b.token,body:{revision:one.data.revision}});assert.equal(two.status,200);assert.equal(two.data.restoration.pending,false);
 assert.equal((await request(p+'/actions',{method:'POST',token:a.token,body:{...action,revision:two.data.revision}})).status,200);
});

test('new explicit result-mode creation requires an explicit board size',async t=>{const {request}=await host(t);assert.equal((await request('/api/rooms',{method:'POST',body:{resultMode:'weighted-margin'}})).status,400);});
test('LAN active count ignores creation/join/watch and follows successful moves',async t=>{
 const {request}=await host(t),a=(await request('/api/rooms',{method:'POST',body:{}})).data,p='/api/rooms/'+a.code;await request(p+'/join',{method:'POST',body:{}});await request(p+'/watch');assert.equal((await request('/api/stats')).data.activeRooms,0);
 const played=await request(p+'/actions',{method:'POST',token:a.token,body:{type:'play',id:1,index:0,at:0,revision:1}});assert.equal(played.status,200);const stats=(await request('/api/stats')).data;assert.equal(stats.activeRooms,1);assert.equal(JSON.stringify(stats).includes(a.code),false);
});
