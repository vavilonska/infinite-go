// Explicitly creates one disposable room at the endpoint passed by its operator.
// Node 22+. Never print seat credentials.
import assert from 'node:assert/strict';
const origin=new URL(process.argv[2]||'http://127.0.0.1:8787').origin;
const headers={Origin:'https://vavilonska.github.io','Content-Type':'application/json'};
async function call(path,body,token,status=200){const res=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();assert.equal(res.status,status,data.error||"Unexpected HTTP status");return data;}
const health=await call('/api/health');assert.equal(health.mode,'cloud');
const a=await call('/api/rooms',{size:9,colorSetup:'manual',hostColor:'B'},null,201);
assert.ok(a.token);const path='/api/rooms/'+a.code;
const b=await call(path+'/join',{},null);assert.ok(b.token);assert.equal(a.token===b.token,false,'Seat credentials must differ');
const clients=[];
async function socket(token){const url=new URL(origin+path+'/events');url.protocol=url.protocol==='https:'?'wss:':'ws:';
 const ws=new WebSocket(url,{headers:{Origin:headers.Origin}});clients.push(ws);const messages=[];let wait;
 ws.addEventListener('message',e=>{const data=JSON.parse(e.data);messages.push(data);wait?.();});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});setTimeout(()=>reject(new Error('Socket open timeout')),5000).unref();});
 ws.send(JSON.stringify({type:'auth',token}));
 async function snapshot(revision){const check=()=>messages.find(x=>x.type==='snapshot'&&x.snapshot?.revision>=revision)?.snapshot;const existing=check();if(existing)return existing;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Snapshot timeout')),5000);wait=()=>{const result=check();if(result){clearTimeout(timer);wait=null;resolve(result);}};});}
 await snapshot(b.revision);return{ws,snapshot};
}
// Keep authentication checks separate from the successful flow.
try{
 await call(path,undefined,undefined,401);
 const sa=await socket(a.token),sb=await socket(b.token);
 await call(path+'/actions',{type:'play',id:1,index:0,at:0,revision:b.revision},b.token,403);
 const moved=await call(path+'/actions',{type:'play',id:1,index:0,at:0,revision:b.revision},a.token);
 assert.equal((await sb.snapshot(moved.revision)).game.lines[0].history.length,1);
 await call(path+'/actions',{type:'play',id:1,index:1,at:1,revision:b.revision},b.token,409);
 const replied=await call(path+'/actions',{type:'play',id:1,index:1,at:1,revision:moved.revision},b.token);
 assert.equal((await sa.snapshot(replied.revision)).game.lines[0].history.length,2);
 sb.ws.close();const restored=await socket(b.token);assert.equal((await restored.snapshot(replied.revision)).role,'W');
 const results=await Promise.all([2,3].map(at=>fetch(origin+path+'/actions',{method:'POST',headers:{...headers,Authorization:'Bearer '+a.token},body:JSON.stringify({type:'play',id:1,index:2,at,revision:replied.revision})})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const snap=await call(path,undefined,a.token);assert.equal(snap.revision,replied.revision+1);assert.equal(JSON.stringify(snap.game).includes(a.token),false);
 console.log('PASS: two seats, WebSocket broadcast, authoritative turn rejection, stale-version/concurrent-write rejection, reconnect and credential-free game snapshot');
}finally{for(const ws of clients)ws.close();}
