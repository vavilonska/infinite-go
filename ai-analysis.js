import {AnalysisWorkerCore} from './ai-worker.js';
const abortError=()=>Object.assign(new Error('Analysis cancelled'),{name:'AbortError'});
export class AnalysisQueue {
 constructor({endpoint,WorkerImpl=globalThis.Worker,onProgress=()=>{},fallbackProvider}={}){
  this.pending=new Map();this.generation=0;this.sequence=0;this.onProgress=onProgress;this.key=null;
  if(WorkerImpl)try{this.worker=new WorkerImpl(new URL('./ai-worker.js',import.meta.url),{type:'module'});this.worker.onmessage=event=>this.receive(event.data);this.worker.onerror=()=>this.failAll(new Error('分析 Worker 不可用，请重新连接服务'));}catch{}
  if(!this.worker)this.core=new AnalysisWorkerCore(message=>this.receive(message),fallbackProvider);
  this.send({type:'configure',endpoint});
 }
 get execution(){return this.worker?'Web Worker':'HTTP async fallback';}
 send(message){if(this.worker)this.worker.postMessage(message);else void this.core.receive(message);}
 failAll(error){for(const task of this.pending.values())task.reject(error);this.pending.clear();}
 setState(game,key){if(key===this.key)return;this.cancel();this.key=key;this.send({type:'state',generation:this.generation,game:structuredClone({size:game.size,komi:game.komi,komiCompensation:game.komiCompensation,lines:game.lines.map(({id,status,history,frozenKomi})=>({id,status,history,frozenKomi}))})});}
 request(lineId,kind='analysis'){if(!['analysis','move'].includes(kind))return Promise.reject(new Error('Unsupported analysis job'));const jobId=++this.sequence;return new Promise((resolve,reject)=>{this.pending.set(jobId,{resolve,reject,generation:this.generation});this.send({type:'job',jobId,lineId,kind,generation:this.generation});});}
 receive(message){const task=this.pending.get(message.jobId);if(!task||task.generation!==message.generation||message.generation!==this.generation)return;if(message.type==='progress'){this.onProgress(message);return;}this.pending.delete(message.jobId);if(message.type==='result')task.resolve(message.value);else task.reject(new Error(message.error||'Analysis failed'));}
 cancel(){this.generation++;this.key=null;this.failAll(abortError());this.send({type:'cancel',generation:this.generation});}
 close(){this.cancel();this.worker?.terminate();}
}
export function analysisCapabilities(caps={}){
 const max=Math.max(1,Math.min(2,Number.isInteger(caps.maxConcurrentAnalyses)?caps.maxConcurrentAnalyses:1));
 return {maxConcurrent:max,model:typeof caps.modelName==='string'?caps.modelName:'服务端已配置模型',backend:typeof caps.backend==='string'?caps.backend:'HTTP 服务端推理',threads:Number.isInteger(caps.threads)?caps.threads:null,visits:Number.isInteger(caps.maxVisits)?caps.maxVisits:null,downloadBytes:Number.isSafeInteger(caps.modelBytes)&&caps.modelBytes>0?caps.modelBytes:null};
}
