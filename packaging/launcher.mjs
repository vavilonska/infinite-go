import {createServer} from './app/server.js';
import {fileURLToPath} from 'node:url';import {networkInterfaces} from 'node:os';import {spawn} from 'node:child_process';
const port=Number(process.env.PORT||8000),host=process.env.HOST||'0.0.0.0';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be 1..65535');
const server=createServer({staticDir:fileURLToPath(new URL('./app/',import.meta.url))});
server.on('error',e=>{console.error('Could not start Infinite Go: '+e.message);process.exitCode=1;});
server.listen(port,host,()=>{
 const url=`http://localhost:${port}`;console.log(`Infinite Go: ${url}\nKeep this window open. Close it or press Ctrl+C to stop.\nRooms are held in memory: export games before stopping.\nTrusted LAN only; do not expose this port to the public Internet.`);
 if(host==='0.0.0.0')for(const entries of Object.values(networkInterfaces()))for(const item of entries||[])if(item.family==='IPv4'&&!item.internal)console.log(`Friends: http://${item.address}:${port}`);
 if(process.env.IG_NO_BROWSER!=='1'){
  const command=process.platform==='win32'?'cmd':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['/c','start','',url]:[url];const child=spawn(command,args,{stdio:'ignore',windowsHide:true});child.on('error',()=>console.log('Open the address above in a browser.'));child.unref();
 }
});
