import legacy,{corsHeaders} from './worker.js';
import {namespaces,cleanup} from './sites-storage.js';
import {json,errorResponse} from './http.js';
import {reject} from './room-state.js';
export default {
 async fetch(request,env,ctx) {
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  try {
   const cors=corsHeaders(request,env);
   if(url.pathname==='/api/health'&&request.method==='GET') {
    if(!env.DB)reject(503,'Game database unavailable');
    await env.DB.prepare('SELECT id FROM game_objects LIMIT 1').first();
    return json(200,{ok:true,mode:'sites',protocol:1,transport:'polling',features:{matchmaking:true}},cors);
   }
   if(url.pathname.endsWith('/events'))return json(400,{error:'This backend uses authenticated HTTP polling'},cors);
   if(!env.DB)reject(503,'Game database unavailable');
   const db=env.DB.withSession?env.DB.withSession('first-primary'):env.DB;
   const response=await legacy.fetch(request,{...env,...namespaces(db)});
   if(Math.random()<0.02)ctx.waitUntil(cleanup(db).catch(()=>{}));
   return response;
  }catch(error){return errorResponse(error);}
 }
};
