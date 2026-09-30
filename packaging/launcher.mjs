import {createServer} from './app/server.js';
import {fileURLToPath} from 'node:url';import {networkInterfaces,homedir} from 'node:os';import {spawn} from 'node:child_process';import {join} from 'node:path';
import {createLocalAIManager} from './app/local-ai/manager.js';
import {createKataGoClient,createBridge} from './app/katago-bridge.js';
const port=Number(process.env.PORT||8000),host=process.env.HOST||'0.0.0.0';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be 1..65535');
const server=createServer({staticDir:fileURLToPath(new URL('./app/',import.meta.url))});
server.on('error',e=>{console.error('Could not start Infinite Go: '+e.message);process.exitCode=1;});
let manager,engine,bridge,closing=false;
async function stopAI(){if(bridge){bridge.closeAllConnections();if(bridge.listening)await new Promise(resolve=>bridge.close(resolve));bridge=null;}engine?.close();engine=null;}
async function close(){if(closing)return;closing=true;await manager?.close();await stopAI();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>close().catch(()=>{process.exitCode=1;}));
server.listen(port,host,async()=>{
 const url=`http://localhost:${port}`;console.log(`Infinite Go: ${url}\nKeep this window open. Close it or press Ctrl+C to stop.\nRooms are held in memory: export games before stopping.\nTrusted LAN only; do not expose this port to the public Internet.`);
 if(host==='0.0.0.0')for(const entries of Object.values(networkInterfaces()))for(const item of entries||[])if(item.family==='IPv4'&&!item.internal)console.log(`Friends: http://${item.address}:${port}`);
 let ownerURL=url;
 try{
  manager=createLocalAIManager({dataDir:join(homedir(),'.infinite-go','local-ai'),appOrigin:url,onStop:stopAI,onStart:async files=>{
   engine=createKataGoClient({...files,maxVisits:32});
   await engine.analyze({requestId:'local-start-health',nodeId:'initial',boardSize:9,komi:7.5,rules:'chinese-positional-superko',history:[]});
   bridge=createBridge({engine,origins:[url]});
   await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
   return {providerUrl:`http://127.0.0.1:${bridge.address().port}`,isAlive:()=>!!engine?.alive};
  }});
  await new Promise((resolve,reject)=>{manager.server.once('error',reject);manager.server.listen(0,'127.0.0.1',resolve);});
  ownerURL=url+'/#localAI='+encodeURIComponent(`http://127.0.0.1:${manager.server.address().port}`)+'&ownerToken='+manager.ownerToken;
 }catch(error){console.error('Optional local AI setup unavailable: '+error.message);}
 if(process.env.IG_NO_BROWSER!=='1'){
  const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=[ownerURL];const child=spawn(command,args,{stdio:'ignore',windowsHide:true});child.on('error',()=>console.log('Open the address above in a browser.'));child.unref();
 }
});
