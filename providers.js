import {effectiveKomi} from './engine.js';
// Small, explicit HTTP protocol. No provider credentials are stored by this app.
export class HttpGoProvider {
 constructor(baseURL){this.base=new URL(baseURL);if(!['http:','https:'].includes(this.base.protocol))throw new Error('Provider URL must use HTTP(S)');this.controllers=new Map();}
 async call(path,body){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);if(body?.requestId)this.controllers.set(body.requestId,controller);try{const r=await fetch(new URL(path,this.base),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});const data=await r.json();if(!r.ok)throw new Error(data.error||'AI service error');if(body&&(data.requestId!==body.requestId||data.nodeId!==body.nodeId))throw new Error('AI response refers to a different request or history node');return data;}finally{clearTimeout(timer);if(body?.requestId)this.controllers.delete(body.requestId);}}
 capabilities(){return this.call('/capabilities');}
 async analyze(request){const data=await this.call('/analyze',request);if(!Number.isFinite(data.blackWinrate)||data.blackWinrate<0||data.blackWinrate>1)throw new Error('Expected blackWinrate in [0, 1]');return data;}
 async generateMove(request){const data=await this.call('/generate-move',request);if(!data.move||!['play','pass'].includes(data.move.type)||data.move.type==='play'&&!Number.isInteger(data.move.at))throw new Error('Invalid AI move');return data;}
 async cancel(requestId){this.controllers.get(requestId)?.abort();try{await fetch(new URL('/cancel',this.base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId})});}catch{}}
 cancelAll(){for(const id of this.controllers.keys())this.cancel(id);}
}
export function requestFor(game,line){return {requestId:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`,nodeId:JSON.stringify({id:line.id,history:line.history}),boardSize:game.size,komi:effectiveKomi(game,line),rules:'chinese-positional-superko',history:structuredClone(line.history)};}
