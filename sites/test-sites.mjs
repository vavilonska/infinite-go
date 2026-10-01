import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloud/sites-entry.js';
function database(){
 const sql=new DatabaseSync(':memory:');
 sql.exec('CREATE TABLE game_objects(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL);CREATE INDEX idx_game_objects_expiry ON game_objects(expires_at)');
 return {sql,prepare(text){let params=[];return {bind(...p){params=p;return this},async first(){await new Promise(r=>setImmediate(r));return sql.prepare(text).get(...params)||null},async run(){await new Promise(r=>setImmediate(r));const r=sql.prepare(text).run(...params);return {meta:{changes:Number(r.changes)}}}}}};
}
const token=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
function service(){const DB=database();const env={DB,ASSETS:{fetch:()=>new Response('asset')}};return {DB,async call(path,body,credential,ip='test'){
 const response=await worker.fetch(new Request('https://example.test'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://example.test','Content-Type':'application/json','CF-Connecting-IP':ip,...(credential?{Authorization:'Bearer '+credential}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil:p=>p.catch(()=>{})});
 return {status:response.status,...await response.json()};
}}}
test('D1 authoritative rooms: concurrent join, stale move rejection, reload and auth',async()=>{
 const {call}=service();assert.equal((await call('/api/health')).transport,'polling');
 const a=await call('/api/rooms',{size:9,colorSetup:'manual',hostColor:'B'});assert.equal(a.status,201);
 const path='/api/rooms/'+a.code;
 const joins=await Promise.all([call(path+'/join',{}),call(path+'/join',{})]);assert.deepEqual(joins.map(x=>x.status).sort(),[200,409]);
 const b=joins.find(x=>x.status===200);assert.notEqual(a.token,b.token);
 const state=await call(path,undefined,a.token);assert.equal(state.revision,1);
 const move={type:'play',id:1,index:0,at:0,revision:state.revision};
 const moves=await Promise.all([call(path+'/actions',move,a.token),call(path+'/actions',{...move,at:1},a.token)]);
 assert.deepEqual(moves.map(x=>x.status).sort(),[200,409]);
 const latest=await call(path,undefined,b.token);assert.equal(latest.game.lines[0].history.length,1);
 assert.equal((await call(path,undefined,token())).status,401);
 assert.equal(JSON.stringify(latest).includes(a.token),false);
});
test('D1 queue: 4 concurrent players receive disjoint stable pairings; cancellation stays cancelled',async()=>{
 const {call}=service(),options={size:9,komi:17.5,branchLimitExponent:9,pruningMode:'komi',compensationC:'20',rules:'infinite-go-v2'};
 const players=Array.from({length:4},()=>token());
 const starts=await Promise.all(players.map((t,i)=>call('/api/matchmaking/start',{options},t,'p'+i)));
 assert(starts.every(x=>['waiting','matched','matching'].includes(x.status)),JSON.stringify(starts));
 const results=await Promise.all(players.map((t,i)=>call('/api/matchmaking/status',undefined,t,'p'+i)));
 assert(results.every(x=>x.status==='matched'),JSON.stringify(results));
 assert.equal(new Set(results.map(x=>x.room.code)).size,2);assert.equal(new Set(results.map(x=>x.room.token)).size,4);
 for(let i=0;i<4;i++){const again=await call('/api/matchmaking/start',{options},players[i],'p'+i);assert.equal(again.room.code,results[i].room.code);assert.equal(again.room.token,results[i].room.token);}
 const cancelledToken=token();await call('/api/matchmaking/start',{options:{...options,komi:19.5}},cancelledToken,'cancel');
 const cancel=await call('/api/matchmaking/cancel',{},cancelledToken,'cancel');assert.equal(cancel.status,'cancelled');
 assert.equal((await call('/api/matchmaking/start',{options:{...options,komi:19.5}},cancelledToken,'cancel')).status,'cancelled');
 const room=results[0].room,opponent=results.find(x=>x.room.code===room.code&&x.room.seat!==room.seat).room;
 const seats={ [room.seat]:room,[opponent.seat]:opponent },path='/api/rooms/'+room.code;
 assert.equal(room.setup.count,undefined);
 let state=await call(path+'/setup',{type:'guess',guess:'odd',revision:room.revision},seats.B.token);
 const winner=state.setup.winner;state=await call(path+'/setup',{type:'choose',color:'B',revision:state.revision},seats[winner].token);
 state=await call(path+'/actions',{type:'play',id:1,index:0,at:0,revision:state.revision},seats[winner].token);assert.equal(state.status,200);assert.equal(state.game.lines[0].history.length,1);
});
test('D1 cancel versus matching race has a single coherent result',async()=>{
 const {call}=service(),options={size:9},a=token(),b=token();await call('/api/matchmaking/start',{options},a,'a');
 await Promise.all([call('/api/matchmaking/cancel',{},a,'a'),call('/api/matchmaking/start',{options},b,'b')]);
 const aa=await call('/api/matchmaking/status',undefined,a,'a'),bb=await call('/api/matchmaking/status',undefined,b,'b');
 assert(['cancelled','matched'].includes(aa.status));
 if(aa.status==='matched'){assert.equal(bb.status,'matched');assert.equal(aa.room.code,bb.room.code)}else assert.equal(bb.status,'waiting');
});
test('D1 8-way queue contention: each admitted logical request is charged once',async()=>{
 const {call,DB}=service(),options={size:9,komi:27.5};
 const ts=Array.from({length:8},()=>token());
 const starts=await Promise.all(ts.map((t,i)=>call('/api/matchmaking/start',{options},t,'race'+i)));
 assert(starts.every(x=>x.status===503||['waiting','matching','matched'].includes(x.status)));
 const saved=JSON.parse(DB.sql.prepare("SELECT value FROM game_objects WHERE id='queue:casual-v1'").get().value).values.queue;
 assert.equal(saved.traffic.minute.count,8);
 assert(Object.values(saved.tickets).every(t=>t.rate.requests.count===1));
 const recovered=[];
 for(let i=0;i<8;i++)recovered.push(await call('/api/matchmaking/status',undefined,ts[i],'race'+i));
 assert(recovered.every(r=>r.status==='matched'),JSON.stringify(recovered));
 assert.equal(new Set(recovered.map(r=>r.room.code)).size,4);
 assert.equal(new Set(recovered.map(r=>r.room.token)).size,8);
});
