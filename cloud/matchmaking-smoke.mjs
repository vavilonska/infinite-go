// Operator-invoked integration check. Creates one disposable matched game and
// temporary queue entries. It never prints queue or room credentials.
import assert from 'node:assert/strict';
const origin=new URL(process.argv[2]||'http://127.0.0.1:8787').origin;
const headers={Origin:'https://vavilonska.github.io','Content-Type':'application/json'};
const token=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
async function call(path,body,credential){const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(credential?{Authorization:'Bearer '+credential}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.ok,true,data.error||'Unexpected HTTP error');return data;}
const health=await call('/api/health');assert.equal(health.features?.matchmaking,true,'Deploy the matchmaking backend before running this test');
const options={size:9,komi:17.5,branchLimitExponent:9,pruningMode:'komi',compensationC:'20',rules:'infinite-go-v2'};
const a=token(),b=token(),c=token();
const first=await call('/api/matchmaking/start',{options},a);assert.equal(first.status,'waiting');
const second=await call('/api/matchmaking/start',{options},b);
async function assigned(credential,initial){let data=initial;for(let tries=0;tries<5&&data.status!=='matched';tries++){await new Promise(r=>setTimeout(r,Math.max(data.pollAfterMs||5000,1000)));data=await call('/api/matchmaking/status',undefined,credential);}assert.equal(data.status,'matched','Matching did not finish');return data;}
const [ma,mb]=await Promise.all([assigned(a,first),assigned(b,second)]);
assert.equal(ma.room.code,mb.room.code,'Both players must have the same game');assert.equal(ma.room.token===mb.room.token,false,'Each seat must have a different credential');assert.notEqual(ma.room.seat,mb.room.seat);
assert.equal(ma.room.setup.phase,'guess');assert.equal(ma.room.setup.count,undefined,'Hidden nigiri count must not leak');
const retry=await call('/api/matchmaking/start',{options},a);assert.equal(retry.room.code,ma.room.code,'A lost response retry must not rematch');
const racedCancel=await call('/api/matchmaking/cancel',{},a);assert.equal(racedCancel.status,'matched','A completed match wins a late cancel');
const waiting=await call('/api/matchmaking/start',{options:{...options,komi:18.5}},c);assert.equal(waiting.status,'waiting');
const cancelled=await call('/api/matchmaking/cancel',{},c);assert.equal(cancelled.status,'cancelled');assert.equal((await call('/api/matchmaking/status',undefined,c)).status,'cancelled');
const players={A:ma.room.seat==='A'?ma.room:mb.room,B:ma.room.seat==='B'?ma.room:mb.room};
const path='/api/rooms/'+ma.room.code;
let state=await call(path,undefined,players.B.token);
state=await call(path+'/setup',{type:'guess',guess:'odd',revision:state.revision},players.B.token);
state=await call(path+'/setup',{type:'choose',color:'B',revision:state.revision},players[state.setup.winner].token);
const black=players[state.setup.winner],white=players[state.setup.winner==='A'?'B':'A'];
state=await call(path+'/actions',{type:'play',id:1,index:0,at:0,revision:state.revision},black.token);
state=await call(path+'/actions',{type:'play',id:1,index:1,at:1,revision:state.revision},white.token);
assert.equal(state.game.lines[0].history.length,2);
console.log('PASS: matching identical settings, unique seats, idempotent start, late-cancel recovery, unmatched cancel, concealed nigiri and authoritative alternating moves');
