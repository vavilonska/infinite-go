import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpectatorRoomClient} from '../remote-room.js';
const state=revision=>({code:'ABCDEFGHJKLM',spectator:true,seat:null,role:null,revision,game:{lines:[{}]}});
function fixture(fetchImpl){const timers=new Map();let id=0;const events=[],states=[];const client=new SpectatorRoomClient({endpoint:'https://room.example',fetchImpl,onSnapshot:s=>states.push(s),onStatus:s=>events.push(s),setTimer:cb=>{timers.set(++id,cb);return id;},clearTimer:key=>timers.delete(key)});return {client,timers,events,states};}
test('spectator only fetches watch route without credentials; old revisions cannot overwrite',async()=>{
 let revision=2;const calls=[];const f=fixture(async(url,opts)=>{calls.push({url,opts});return Response.json(state(revision));});await f.client.watch('ABCDEFGHJKLM');revision=1;await f.client.poll();assert.equal(f.states.length,1);assert.equal(f.states[0].revision,2);assert.equal(calls[0].url,'https://room.example/api/rooms/ABCDEFGHJKLM/watch');assert.equal(calls[0].opts.credentials,'omit');assert.equal(calls[0].opts.headers,undefined);assert.throws(()=>f.client.mutate(),/只读/);f.client.close();assert.equal(f.timers.size,0);
});
test('spectator rejects token-bearing or player snapshots and invalid code before request',async()=>{
 const f=fixture(async()=>Response.json({...state(0),token:'private'}));await assert.rejects(f.client.watch('bad'),/有效/);await assert.rejects(f.client.watch('ABCDEFGHJKLM'),/无效/);f.client.close();
});
test('spectator stops on expiry, pauses polling and does not acquire a replacement seat',async()=>{
 let expired=false,calls=0;const f=fixture(async()=>{calls++;return expired?Response.json({error:'expired'},{status:410}):Response.json(state(0));});await f.client.watch('ABCDEFGHJKLM');f.client.start();f.client.setPaused(true);await f.client.poll();assert.equal(calls,1);f.client.setPaused(false);expired=true;await f.client.poll();assert.equal(f.client.closed,true);assert.equal(f.events.at(-1).state,'ended');assert.equal(f.timers.size,0);
});
test('spectator offline transition suspends reads and online schedules recovery',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return Response.json(state(0));});await f.client.watch('ABCDEFGHJKLM');f.client.start();f.client.setOnline(false);await f.client.poll();assert.equal(calls,1);assert.equal(f.timers.size,0);assert.equal(f.events.at(-1).state,'offline');f.client.setOnline(true);assert.equal(f.timers.size,1);await f.client.poll();assert.equal(calls,2);f.client.close();
});
