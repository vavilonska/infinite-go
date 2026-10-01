import {HttpGoProvider,requestFor} from './providers.js';
// This worker prepares and transports analysis. It is not a bundled Go engine.
export class AnalysisWorkerCore {
 constructor(post,makeProvider=url=>new HttpGoProvider(url)){this.post=post;this.makeProvider=makeProvider;this.generation=0;this.provider=null;}
 async receive(message){
  if(message.type==='configure'){this.provider?.cancelAll();this.provider=this.makeProvider(message.endpoint);return;}
  if(message.type==='state'){this.provider?.cancelAll();this.generation=message.generation;this.game=message.game;return;}
  if(message.type==='cancel'){this.provider?.cancelAll();this.generation=message.generation;return;}
  if(message.type!=='job')return;
  const generation=message.generation;
  try{
   if(generation!==this.generation||!this.provider||!this.game)throw new Error('Analysis state expired');
   const line=this.game.lines.find(l=>l.id===message.lineId);if(!line)throw new Error('Unknown analysis line');
   const request=requestFor(this.game,line);
   const bytes=new TextEncoder().encode(JSON.stringify({size:this.game.size,komi:request.komi,id:line.id,history:line.history}));
   request.nodeId=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
   if(generation!==this.generation)return;
   this.post({type:'progress',jobId:message.jobId,generation,phase:'analyzing'});
   const result=await(message.kind==='move'?this.provider.generateMove(request):this.provider.analyze(request));
   if(generation!==this.generation)return;
   // Human analysis never emits candidate moves, principal variations or advice.
   this.post({type:'result',jobId:message.jobId,generation,value:{blackWinrate:result.blackWinrate,visits:result.visits,nodeId:request.nodeId,...(message.kind==='move'?{move:result.move}:{})}});
  }catch(error){if(generation===this.generation)this.post({type:'error',jobId:message.jobId,generation,error:error.message});}
 }
}
if(typeof self!=='undefined'&&typeof self.postMessage==='function'&&typeof document==='undefined'){
 const core=new AnalysisWorkerCore(message=>self.postMessage(message));self.addEventListener('message',event=>{void core.receive(event.data);});
}
