import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function buildStatic(destination, { remoteConfig, networkOnlyApi = false, navigationAsset = 'index.html' } = {}) {
destination=resolve(destination);
await mkdir(destination,{recursive:true});
const assets=['index.html','style.css','app.js','engine.js','tree.js','annotations.js','nigiri.js','host-address.js','remote-room.js','remote-config.js','matchmaking-client.js','manifest.webmanifest','ai.js','providers.js','LICENSE','NOTICE'];
const contents=await Promise.all(assets.map(asset=>asset==='remote-config.js'&&remoteConfig!==undefined?remoteConfig:readFile(resolve(root,asset),'utf8')));const version=createHash('sha256').update(contents.join('\n')+ (networkOnlyApi?'\nnetwork-only-api\nnavigation-asset:'+navigationAsset:'')).digest('hex').slice(0,12);
for(let i=0;i<assets.length;i++){let text=contents[i];if(assets[i].endsWith('.js'))text=text.replace(/(['"])(\.\/[a-z-]+\.js)\1/g,(_,quote,path)=>`${quote}${path}?v=${version}${quote}`);if(assets[i]==='index.html')text=text.replace('src="app.js"',`src="app.js?v=${version}"`).replace('href="style.css"',`href="style.css?v=${version}"`);await writeFile(resolve(destination,assets[i]),text);}
await mkdir(resolve(destination,'assets'),{recursive:true});
for(const name of ['icon.png','icon-192.png','favicon.png','apple-touch-icon.png','gameplay.jpg','social-preview.jpg'])await copyFile(resolve(root,'assets',name),resolve(destination,'assets',name));
await writeFile(resolve(destination,'deployment.js'),'export const STATIC_HOST = true;\n');
await writeFile(resolve(destination,'.nojekyll'),'');
console.log(`Prepared ${assets.length+5} static assets. No room server, AI engine, model, or credentials included.`);

const precache=[...assets.map(asset=>asset==='index.html'?navigationAsset:asset),'deployment.js','assets/icon.png','assets/icon-192.png','assets/favicon.png','assets/apple-touch-icon.png'];
await writeFile(resolve(destination,'sw.js'),`const CACHE='infinite-go-${version}';const FILES=${JSON.stringify(precache)};self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('infinite-go-')&&key!==CACHE).map(key=>caches.delete(key))))));self.addEventListener('fetch',event=>{${networkOnlyApi?"const url=new URL(event.request.url);if(url.pathname==='/api'||url.pathname.startsWith('/api/'))return;":''}if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;event.respondWith(caches.open(CACHE).then(async cache=>{if(event.request.mode==='navigate'){return await cache.match(${JSON.stringify(navigationAsset)})||fetch(event.request);}return await cache.match(event.request,{ignoreSearch:true})||fetch(event.request);}));});`);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildStatic(process.argv[2]||resolve(root,'dist'));
