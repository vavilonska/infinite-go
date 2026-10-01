// D1 is authoritative: atomic compare-and-swap, never isolate-local state.
import { GameRoom, RoomCreationLimiter } from './worker.js';
import { MatchmakingQueue, tokenFromRequest } from './matchmaking.js';
import { json } from './http.js';
const RETENTION_MS = 2 * 86_400_000;
class Store {
  constructor(db,id,deferred=false) { this.commits=0;this.deferred=deferred;this.dirty=false;this.db=db;this.id=id;this.revision=null;this.values={};this.alarm=null;this.conflicted=false; }
  async load() {
    const row=await this.db.prepare('SELECT revision, value FROM game_objects WHERE id = ?').bind(this.id).first();
    if(row) { const saved=JSON.parse(row.value);this.revision=row.revision;this.values=saved.values;this.alarm=saved.alarm; }
  }
  async get(key) { return Array.isArray(key)?new Map(key.map(k=>[k,structuredClone(this.values[k])])):structuredClone(this.values[key]); }
  async commit(values=this.values,alarm=this.alarm) {
    if(this.deferred){this.values=structuredClone(values);this.alarm=alarm;this.dirty=true;return;}
    const serialized=JSON.stringify({values,alarm});
    if(new TextEncoder().encode(serialized).length>1_500_000) throw new Error('State capacity exceeded');
    const expires=Date.now()+RETENTION_MS;
    const result=this.revision===null
      ?await this.db.prepare('INSERT INTO game_objects (id, revision, value, expires_at) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO NOTHING').bind(this.id,serialized,expires).run()
      :await this.db.prepare('UPDATE game_objects SET revision = revision + 1, value = ?, expires_at = ? WHERE id = ? AND revision = ?').bind(serialized,expires,this.id,this.revision).run();
    if(result.meta.changes!==1) { this.conflicted=true;throw new Error('CAS conflict'); }
    this.commits++;this.revision=(this.revision??0)+1;this.values=structuredClone(values);this.alarm=alarm;
  }
  async flush(){if(this.dirty){this.deferred=false;await this.commit();this.dirty=false;}}
  async put(key,value) { const next=structuredClone(this.values);if(typeof key==='string')next[key]=structuredClone(value);else Object.assign(next,structuredClone(key));await this.commit(next); }
  // Alarm updates are persisted with the next state mutation. On-access alarms
  // enforce expiry; opportunistic indexed cleanup bounds cold rows.
  async setAlarm(time) { this.alarm=time; }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm=null; }
  async deleteAll() { await this.commit({},null); }
}
export function namespaces(db) {
  const env={};
  for(const [binding,Class,prefix] of [['ROOMS',GameRoom,'room:'],['ROOM_CREATION',RoomCreationLimiter,'limit:'],['MATCHMAKING',MatchmakingQueue,'queue:']]) {
    env[binding]={getByName(name){return {async fetch(request){
      const bytes=request.body?await request.arrayBuffer():undefined;
      let queueAdmitted=false;
      for(let attempt=0;attempt<10;attempt++) {
        const storage=new Store(db,prefix+name,binding==='ROOMS');await storage.load();
        const ctx={storage,blockConcurrencyWhile:fn=>fn(),getWebSockets:()=>[]};
        const object=new Class(ctx,env);
        let response,admissionStart=0,handling=false;
        try {
          if(storage.alarm!==null&&storage.alarm<=Date.now())await object.alarm();
          admissionStart=storage.commits;handling=true;
          if(binding==='MATCHMAKING'&&queueAdmitted){
            await object.ready;const ticket=object.state.tickets[tokenFromRequest(request)];
            if(ticket?.status==='matching')await object.finishPair(ticket.pair);
            response=await object.respond(tokenFromRequest(request));
          }else response=await object.fetch(new Request(request.url,{method:request.method,headers:request.headers,...(bytes?{body:bytes.slice(0)}:{})}));
          await storage.flush();
        } catch(error) { if(!storage.conflicted)throw error; }
        if(binding==='MATCHMAKING'&&handling&&storage.commits>admissionStart)queueAdmitted=true;
        if(!storage.conflicted)return response;
      }
      return json(503,{error:'房间正在同步，请稍后重试',errorCode:'CLOUD_UNAVAILABLE',recoverable:true});
    }}}};
  }
  return env;
}
export async function cleanup(db) {
  await db.prepare('DELETE FROM game_objects WHERE id IN (SELECT id FROM game_objects WHERE expires_at < ? LIMIT 128)').bind(Date.now()).run();
}
