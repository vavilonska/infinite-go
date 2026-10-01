import {remoteEndpoint} from './remote-room.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STORAGE_PREFIX = 'infinite-go-matchmaking:';
const ACTIVE_KEY = 'infinite-go-matchmaking-active';
const STATES = new Set(['waiting','matching','matched','cancelled','expired']);
export const MIN_POLL_MS = 5000;
export function createQueueToken(cryptoImpl = globalThis.crypto) {
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export function saveQueueSession(storage, value) {
  try {
    const endpoint = remoteEndpoint(value.endpoint);
    if (!TOKEN.test(value.token)) return false;
    storage.setItem(STORAGE_PREFIX + endpoint, JSON.stringify({...value,endpoint}));
    storage.setItem(ACTIVE_KEY, endpoint); return true;
  } catch { return false; }
}
export function loadQueueSession(storage, endpoint, now = Date.now()) {
  try {
    endpoint = remoteEndpoint(endpoint ?? storage.getItem(ACTIVE_KEY));
    const value = JSON.parse(storage.getItem(STORAGE_PREFIX + endpoint));
    if (value?.endpoint !== endpoint || !TOKEN.test(value.token) || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) return null;
    return value;
  } catch { return null; }
}
export function clearQueueSession(storage, endpoint) {
  try { endpoint=remoteEndpoint(endpoint);storage.removeItem(STORAGE_PREFIX+endpoint);if(storage.getItem(ACTIVE_KEY)===endpoint)storage.removeItem(ACTIVE_KEY); } catch {}
}
export async function matchmakingCapabilities(endpoint, {fetchImpl = globalThis.fetch.bind(globalThis), signal} = {}) {
  const response = await fetchImpl(remoteEndpoint(endpoint)+'/api/health', {signal,mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
  if (!response.ok) throw new Error('无法检查所选服务，请稍后重试');
  const health = await response.json();
  return {supported:health?.features?.matchmaking === true,health};
}
export class MatchmakingClient {
  constructor({endpoint,token=createQueueToken(),fetchImpl=globalThis.fetch.bind(globalThis),setTimer=globalThis.setTimeout.bind(globalThis),clearTimer=globalThis.clearTimeout.bind(globalThis),now=Date.now,onStatus=()=>{},onMatched=()=>{}}) {
    Object.defineProperty(this,'endpoint',{value:remoteEndpoint(endpoint),enumerable:true});
    if(!TOKEN.test(token))throw new Error('无效的匹配凭据');
    this.token=token;this.fetchImpl=fetchImpl;this.setTimer=setTimer;this.clearTimer=clearTimer;this.now=now;this.onStatus=onStatus;this.onMatched=onMatched;
    this.generation=0;this.closed=false;this.online=true;this.timer=null;this.controllers=new Set();this.inFlight=false;this.status='idle';this.expiresAt=this.now()+300000;this.options=null;this.matched=false;this.confirmed=false;
  }
  emit(status,details={}) {this.status=status;this.onStatus({status,expiresAt:this.expiresAt,...details});}
  async request(path,body) {
    const generation=this.generation,controller=new AbortController();this.controllers.add(controller);
    const timeout=this.setTimer(()=>controller.abort(),15000);
    try {
      const response=await this.fetchImpl(this.endpoint+'/api/matchmaking/'+path,{method:body===undefined?'GET':'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{Authorization:'Bearer '+this.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const data=await response.json();
      if(this.closed||generation!==this.generation)throw new Error('匹配请求已结束');
      if(!response.ok){const error=new Error(data.error||'匹配服务请求失败');error.status=response.status;error.code=data.errorCode;error.retryAfterMs=data.retryAfterMs;throw error;}
      if(!STATES.has(data.status)||data.status==='matched'&&!data.room)throw new Error('匹配服务返回的数据无效');
      return data;
    } catch(error) {
      if(error.name==='AbortError')throw new Error('匹配请求超时，正在恢复同一次排队');
      throw error;
    } finally {this.clearTimer(timeout);this.controllers.delete(controller);}
  }
  accept(data) {
    if(this.closed)return data;
    this.confirmed=true;this.expiresAt=data.expiresAt??this.expiresAt;this.options=data.options??this.options;
    this.emit(data.status,{...data});
    if(data.status==='matched') {this.clearTimer(this.timer);this.timer=null;if(!this.matched){this.matched=true;this.onMatched(data.room);} }
    else if(['waiting','matching'].includes(data.status))this.schedule(data.pollAfterMs);
    return data;
  }
  schedule(delay=MIN_POLL_MS) {
    this.clearTimer(this.timer);this.timer=null;
    if(this.closed||!this.online||this.matched)return;
    this.timer=this.setTimer(()=>{this.timer=null;this.poll();},Math.max(MIN_POLL_MS,Math.min(30000,Number(delay)||MIN_POLL_MS)));
  }
  async start(options) {
    if(this.closed||this.inFlight)return;
    const generation=this.generation;this.options=options;this.inFlight=true;this.emit('starting');
    try{return this.accept(await this.request('start',{options}));}
    catch(error){if(!this.closed&&generation===this.generation)this.failure(error);throw error;}
    finally{if(generation===this.generation)this.inFlight=false;}
  }
  async resume(saved) {
    this.options=saved.options;this.expiresAt=saved.expiresAt;this.confirmed=saved.confirmed===true;this.emit('reconnecting');return this.poll();
  }
  async poll() {
    if(this.closed||!this.online||this.inFlight||this.matched)return;
    if(this.expiresAt<=this.now()){this.emit('expired');this.close();return;}
    const generation=this.generation;this.inFlight=true;
    try{return this.accept(await this.request(this.confirmed?'status':'start',this.confirmed?undefined:{options:this.options}));}
    catch(error){if(!this.closed&&generation===this.generation)this.failure(error);}
    finally{if(generation===this.generation)this.inFlight=false;}
  }
  failure(error) {
    if([400,401,403,404,410,422].includes(error.status)){this.emit('ended',{error:error.message});this.close();return;}
    this.emit(this.online?'reconnecting':'offline',{error:error.message});this.schedule(error.retryAfterMs);
  }
  async cancel() {
    if(this.closed)return {status:'cancelled'};
    // Invalidate in-flight responses before cancelling. A matched cancel response
    // still hands off the room, so the narrow cancel/match race never loses it.
    this.generation++;for(const controller of this.controllers)controller.abort();this.controllers.clear();this.clearTimer(this.timer);this.timer=null;
    this.inFlight=true;this.emit('cancelling');
    try {const data=await this.request('cancel',{});this.accept(data);if(['cancelled','expired'].includes(data.status))this.close();return data;}
    catch(error){if(!this.closed){this.emit('cancel-failed',{error:'取消尚未确认：'+error.message});}throw error;}
    finally{this.inFlight=false;}
  }
  setOnline(online) {this.online=!!online;if(!online){this.clearTimer(this.timer);this.timer=null;this.emit('offline');}else if(!this.closed&&!this.matched)this.poll();}
  reconnect() {if(!this.closed&&this.online&&!this.inFlight&&!this.matched)this.poll();}
  close() {this.closed=true;this.generation++;this.clearTimer(this.timer);this.timer=null;for(const controller of this.controllers)controller.abort();this.controllers.clear();}
}
