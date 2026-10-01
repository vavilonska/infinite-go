import {BROWSER_MODELS} from './browser-ai/models.js';import {browserSettings} from './browser-ai/settings.js';
export {BROWSER_MODELS};
const cancelled=()=>Object.assign(new Error('Browser analysis cancelled'),{name:'AbortError'});
export class BrowserGoProvider {
 constructor({modelId='tiny',backend='wasm',threads=1,visits=32,maxTimeMs=3000,batchSize=1,maxChildren=32,file,onProgress=()=>{},WorkerImpl=globalThis.Worker}={}){
  if(!WorkerImpl||typeof WebAssembly==='undefined'||!globalThis.crypto?.subtle)throw new Error('浏览器本机分析需要 Worker、WebAssembly 和安全上下文 SHA-256；请使用 HTTPS 或 localhost');
  if(!BROWSER_MODELS.some(m=>m.id===modelId))throw new Error('未知模型');
  const settings=browserSettings({backend,threads,visits,maxTimeMs,batchSize,maxChildren});
  this.jobs=new Map();this.sequence=0;this.generation=0;this.cancelEpoch=0;this.onProgress=onProgress;this.closed=false;
  this.worker=new WorkerImpl(new URL('./browser-ai/dist/engine.worker.js',import.meta.url),{type:'module'});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.worker.onmessage=event=>this.receive(event.data);this.worker.onerror=()=>{this.rejectReady(new Error('浏览器引擎未构建或无法启动；可改用 HTTP provider'));this.cancelAll();};
  this.worker.postMessage({type:'init',modelId,...settings,file});
 }
 receive(data){
  if(this.closed)return;
  if(data.type==='ready'){this.generation=data.generation;this.info=data;this.resolveReady({name:'Web KatRain · TS search',analyze:true,generateMove:true,cancel:true,boardSizes:[9,13,19],rules:['chinese-positional-superko'],winratePerspective:'black',maxConcurrentAnalyses:1,modelName:data.modelName,backend:data.backend,threads:data.threads,maxVisits:data.maxVisits,modelBytes:data.modelBytes});return;}
  if(data.type==='download'||data.type==='analysis-progress'){if(data.type==='download'||this.jobs.has(data.id))this.onProgress(data);return;}
  if(data.type==='error'&&!data.id){this.rejectReady(new Error(data.error));return;}
  const job=this.jobs.get(data.id);if(!job)return;this.jobs.delete(data.id);if(data.type==='error')job.reject(new Error(data.error));else if(data.value?.requestId!==job.request.requestId||data.value?.nodeId!==job.request.nodeId)job.reject(new Error('浏览器分析节点不匹配'));else if(!Number.isFinite(data.value?.blackWinrate)||data.value.blackWinrate<0||data.value.blackWinrate>1)job.reject(new Error('浏览器返回无效胜率'));else if(job.kind==='move'&&(!['play','pass'].includes(data.value?.move?.type)||data.value.move.type==='play'&&!Number.isInteger(data.value.move.at)))job.reject(new Error('浏览器返回无效落子'));else job.resolve(data.value);
 }
 capabilities(){return this.ready;}
 async call(kind,request){const started=this.cancelEpoch;await this.ready;if(this.closed||started!==this.cancelEpoch)throw cancelled();const id=++this.sequence;return new Promise((resolve,reject)=>{this.jobs.set(id,{resolve,reject,request,kind});this.worker.postMessage({type:'job',id,kind,request,generation:this.generation});});}
 analyze(request){return this.call('analysis',request);}
 generateMove(request){return this.call('move',request);}
 cancelAll(){this.cancelEpoch++;this.generation++;for(const task of this.jobs.values())task.reject(cancelled());this.jobs.clear();this.worker.postMessage({type:'cancel'});}
 close(){this.closed=true;this.cancelAll();this.worker.terminate();this.rejectReady(cancelled());}
}
