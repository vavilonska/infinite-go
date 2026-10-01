import test from 'node:test';
import assert from 'node:assert/strict';
import {MatchmakingClient,matchmakingCapabilities,createQueueToken,saveQueueSession,loadQueueSession,clearQueueSession} from '../matchmaking-client.js';
const endpoint='https://queue.example',token='a'.repeat(43),options={size:9,komi:7.5,pruningMode:'none',branchLimitExponent:9,rules:'infinite-go-v2'};
const reply=(data,status=200)=>({ok:status<400,status,json:async()=>data});
function fixture(fetchImpl,extra={}){const timers=new Map();let id=0;const statuses=[],matched=[];const client=new MatchmakingClient({endpoint,token,fetchImpl,now:()=>1000,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),onStatus:s=>statuses.push(s),onMatched:r=>matched.push(r),...extra});return {client,timers,statuses,matched};}
test('health capability gate rejects old protocol and carries no queue credentials',async()=>{
 const calls=[];const fetchImpl=async(...args)=>{calls.push(args);return reply({ok:true,protocol:1});};
 assert.equal((await matchmakingCapabilities(endpoint,{fetchImpl})).supported,false);
 assert.equal(calls[0][0],endpoint+'/api/health');assert.equal(calls[0][1].credentials,'omit');assert.equal(calls[0][1].headers,undefined);
 assert.equal((await matchmakingCapabilities(endpoint,{fetchImpl:async()=>reply({features:{matchmaking:true}})})).supported,true);
});
test('queue token is random 32-byte URL-safe value and sessions are isolated by exact origin',()=>{
 assert.match(createQueueToken(),/^[\w-]{43}$/);const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 assert.ok(saveQueueSession(storage,{endpoint,token,options,confirmed:true,expiresAt:2000}));assert.equal(loadQueueSession(storage,endpoint,1000).token,token);assert.equal(loadQueueSession(storage,'https://other.example',1000),null);assert.equal(loadQueueSession(storage,endpoint,3000),null);clearQueueSession(storage,endpoint);assert.equal(loadQueueSession(storage,endpoint,1000),null);
});
test('queue authenticates in headers, locks endpoint, and never polls faster than five seconds',async()=>{
 const calls=[];const {client,timers}=fixture(async(...args)=>{calls.push(args);return reply({status:'waiting',expiresAt:300000,pollAfterMs:1,options});});await client.start(options);
 assert.equal(calls.length,1);assert.equal(calls[0][0],endpoint+'/api/matchmaking/start');assert.equal(calls[0][1].headers.Authorization,'Bearer '+token);assert.deepEqual(JSON.parse(calls[0][1].body),{options});assert.equal(calls[0][1].redirect,'error');assert.throws(()=>client.endpoint='https://other.example');assert.deepEqual([...timers.values()].map(t=>t.ms),[5000]);client.close();assert.equal(timers.size,0);
});
test('uncertain initial start retries same token idempotently, acknowledged restore only polls status',async()=>{
 const calls=[];let first=true;const {client}=fixture(async(url,init)=>{calls.push([url,init]);if(first){first=false;throw new Error('offline');}return reply({status:'waiting',expiresAt:300000,options});});await assert.rejects(client.start(options));await client.poll();assert.deepEqual(calls.map(c=>c[0].split('/').at(-1)),['start','start']);assert.equal(calls[0][1].headers.Authorization,calls[1][1].headers.Authorization);client.close();
 const restored=[];const b=fixture(async(url)=>{restored.push(url);return reply({status:'waiting',expiresAt:300000,options});});await b.client.resume({options,expiresAt:300000,confirmed:true});assert.deepEqual(restored,[endpoint+'/api/matchmaking/status']);b.client.close();
});
test('cancel wins against delayed start and late responses cannot revive the queue',async()=>{
 let resolveStart;const {client,statuses}=fixture((url)=>url.endsWith('/start')?new Promise(r=>resolveStart=r):Promise.resolve(reply({status:'cancelled'})));
 const pending=client.start(options).catch(()=>{});const data=await client.cancel();assert.equal(data.status,'cancelled');resolveStart(reply({status:'waiting',expiresAt:300000}));await pending;assert.equal(client.closed,true);assert.equal(statuses.at(-1).status,'cancelled');
});
test('cancel racing a committed match preserves matched-room handoff exactly once',async()=>{
 const room={code:'ABCDEFGH2345',token:'b'.repeat(43)};const {client,matched}=fixture(async()=>reply({status:'matched',room}));await client.cancel();assert.deepEqual(matched,[room]);client.accept({status:'matched',room});assert.equal(matched.length,1);client.close();
});
test('cancel failure does not silently close the queue or claim cancellation',async()=>{
 const {client,statuses}=fixture(async()=>{throw new Error('network');});await assert.rejects(client.cancel());assert.equal(client.closed,false);assert.equal(statuses.at(-1).status,'cancel-failed');client.close();
});
test('offline stops polling; foreground reconnect obtains same ticket status',async()=>{
 let requests=0;const {client,timers}=fixture(async()=>{requests++;return reply({status:'waiting',expiresAt:300000});});await client.start(options);client.setOnline(false);assert.equal(timers.size,0);await client.poll();assert.equal(requests,1);client.setOnline(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,2);client.close();
});
test('expired queue credentials cannot create a fresh ticket during recovery',async()=>{
 let requests=0;const {client,statuses}=fixture(async()=>{requests++;return reply({status:'waiting'});});await client.resume({options,expiresAt:999,confirmed:false});assert.equal(requests,0);assert.equal(statuses.at(-1).status,'expired');assert.equal(client.closed,true);
});
test('known expired ticket error ends recovery instead of restarting the queue',async()=>{
 const {client,statuses,timers}=fixture(async()=>reply({error:'expired',errorCode:'MATCHMAKING_EXPIRED'},404));await client.resume({options,expiresAt:2000,confirmed:true});assert.equal(statuses.at(-1).status,'ended');assert.equal(timers.size,0);client.close();
});
