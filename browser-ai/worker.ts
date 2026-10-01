import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-wasm';import '@tensorflow/tfjs-backend-webgpu';
import {setWasmPaths,setThreadsCount} from '@tensorflow/tfjs-backend-wasm';import pako from 'pako';
import {parseKataGoModelV8} from './vendor/engine/katago/loadModelV8';
import {KataGoModelV8Tf} from './vendor/engine/katago/modelV8';
import {MctsSearch} from './vendor/engine/katago/analyzeMcts';
import {setBoardSize} from './vendor/engine/katago/fastBoard';
import {RULES} from './vendor/utils/goRules';import {situationalKey} from './vendor/utils/superko';
import * as E from '../engine.js';import {BROWSER_MODELS} from './models.js';import {browserSettings} from './settings.js';
// Match Infinite Go, not upstream's simple-ko Chinese preset.
RULES.chinese.ko='positional';RULES.chinese.handicapBonus='zero';
let model:KataGoModelV8Tf|null=null,generation=0,controller:AbortController|null=null,chain=Promise.resolve(),visits=32,threadCount=1,config=browserSettings();
const post=(value:unknown)=>self.postMessage(value);
async function weights(entry:any,signal:AbortSignal,file?:Blob){
 const key=new URL('./models/'+entry.sha256,self.location.href).href;let cache:Cache|undefined;try{cache=await caches.open('ig-ai-models-v1');}catch{}
 let response=file?new Response(file):await cache?.match(key);if(!response){if(entry.requiresFile)throw new Error('此模型需选择从官方链接下载的文件（无需上传）');response=await fetch(entry.url,{signal,credentials:'omit',mode:'cors'});if(!response.ok)throw new Error('模型下载失败 HTTP '+response.status);}
 const reader=response.body?.getReader();if(!reader)throw new Error('无法读取模型数据');const chunks:Uint8Array[]=[];let count=0,last=0;
 while(true){if(signal.aborted){await reader.cancel();throw new DOMException('Cancelled','AbortError');}const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>entry.bytes){await reader.cancel();throw new Error('模型超过已核验大小');}chunks.push(value);if(performance.now()-last>100){post({type:'download',downloadedBytes:count,totalBytes:entry.bytes});last=performance.now();}}
 if(count!==entry.bytes)throw new Error('模型大小不符');const bytes=new Uint8Array(count);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==entry.sha256)throw new Error('模型 SHA-256 不符，已拒绝加载');
 try{await cache?.put(key,new Response(bytes));}catch{}post({type:'download',downloadedBytes:count,totalBytes:entry.bytes});return bytes;
}
async function init(message:any){
 const epoch=++generation;controller?.abort();controller=new AbortController();const entry=BROWSER_MODELS.find(m=>m.id===message.modelId);if(!entry)throw new Error('未知模型');
 config=browserSettings({backend:message.backend,threads:message.threads,visits:message.visits,maxTimeMs:message.maxTimeMs,batchSize:message.batchSize,maxChildren:message.maxChildren});
 if(config.threads>1&&!(self.crossOriginIsolated&&typeof SharedArrayBuffer!=='undefined'))throw new Error('多线程需要跨源隔离；当前只能使用 1 线程');
 threadCount=config.threads;visits=config.visits;setThreadsCount(threadCount);const wasmVersion=new URL(self.location.href).search;const wasmPaths=Object.fromEntries(['tfjs-backend-wasm.wasm','tfjs-backend-wasm-simd.wasm','tfjs-backend-wasm-threaded-simd.wasm'].map(file=>[file,new URL('./wasm/'+file,self.location.href).href+wasmVersion]));setWasmPaths(wasmPaths);const requested=config.backend;
 await tf.setBackend(requested);await tf.ready();if(tf.getBackend()!==requested)throw new Error('所选计算后端不可用');
 const bytes=await weights(entry,controller.signal,message.file);if(epoch!==generation)throw new DOMException('Cancelled','AbortError');model?.dispose();model=new KataGoModelV8Tf(parseKataGoModelV8(pako.ungzip(bytes)));
 post({type:'ready',generation:epoch,modelName:model.modelName,backend:tf.getBackend(),threads:requested==='wasm'?threadCount:1,maxVisits:visits,modelBytes:entry.bytes});
}
async function job(message:any){
 const epoch=generation;if(message.generation!==epoch)return;if(!model)throw new Error('模型未就绪');const request=message.request,size=request.boardSize;if(request.rules!=='chinese-positional-superko'||!Number.isFinite(request.komi))throw new Error('不支持的规则或贴目');if(![9,13,19].includes(size))throw new Error('棋盘尺寸不支持');if(!Array.isArray(request.history)||request.history.length>2048)throw new Error('浏览器分析支持至多 2048 手历史；棋局仍可继续或改用外部 provider');setBoardSize(size);
 let state=E.initial(size);const frames=[state.board],moveHistory:any[]=[];
 for(const move of request.history){state=E.apply(state,move,size);frames.push(state.board);if(move.type==='resume')moveHistory.length=0;else moveHistory.push({x:move.type==='pass'?-1:move.at%size,y:move.type==='pass'?-1:Math.floor(move.at/size),player:move.color==='B'?'black':'white'});}
 const board=(flat:any[])=>Array.from({length:size},(_,y)=>flat.slice(y*size,(y+1)*size).map(c=>c==='B'?'black':c==='W'?'white':null));
 const repetitionHistory=frames.map(f=>situationalKey(board(f) as any,'black')); // Positional normalization deliberately ignores this prefix.
 const search=await MctsSearch.create({model,board:board(state.board),previousBoard:board(frames.at(-2)||state.board),previousPreviousBoard:board(frames.at(-3)||state.board),currentPlayer:state.toPlay==='B'?'black':'white',moveHistory,repetitionHistory,komi:request.komi,rules:'chinese',nnRandomize:false,conservativePass:true,maxChildren:config.maxChildren,ownershipMode:'none'} as any);
 const started=performance.now();let stopped=false;
 for(let target=16;target<=visits&&epoch===generation;target+=16){
  stopped=await search.run({visits:Math.min(target,visits),maxTimeMs:Math.max(25,config.maxTimeMs-(performance.now()-started)),batchSize:config.batchSize,shouldAbort:()=>epoch!==generation});
  const current=search.getAnalysis({topK:1,analysisPvLen:1});post({type:'analysis-progress',id:message.id,visits:current.rootVisits,target:visits});if(stopped||performance.now()-started>=config.maxTimeMs)break;
 }
 if(epoch!==generation)return;const analysis=search.getAnalysis({topK:10,analysisPvLen:1});if(!Number.isFinite(analysis.rootWinRate)||analysis.rootWinRate<0||analysis.rootWinRate>1)throw new Error('模型返回无效胜率');let move:any;
 if(message.kind==='move')for(const candidate of analysis.moves){const trial=candidate.x<0||candidate.y<0?{type:'pass',color:state.toPlay}:{type:'play',color:state.toPlay,at:candidate.y*size+candidate.x};try{E.apply(state,trial,size);move=trial.type==='pass'?{type:'pass'}:{type:'play',at:trial.at};break;}catch{}}
 if(message.kind==='move'&&!move)throw new Error('模型没有返回合法落子');
 post({type:'result',id:message.id,value:{requestId:request.requestId,nodeId:request.nodeId,blackWinrate:analysis.rootWinRate,visits:analysis.rootVisits,...(move?{move}:{})}});
}
self.onmessage=event=>{const m=event.data;if(m.type==='cancel'){generation++;controller?.abort();return;}if(m.type==='init'){void init(m).catch(error=>post({type:'error',error:error.message}));return;}if(m.type==='job'){chain=chain.then(()=>job(m)).catch(error=>post({type:'error',id:m.id,error:error.message}));}};
