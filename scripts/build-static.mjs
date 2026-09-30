import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const destination=resolve(process.argv[2]||resolve(root,'dist'));
await mkdir(destination,{recursive:true});
const assets=['index.html','style.css','app.js','engine.js','tree.js','annotations.js','nigiri.js','ai.js','providers.js','LICENSE','NOTICE'];
const contents=await Promise.all(assets.map(asset=>readFile(resolve(root,asset),'utf8')));const version=createHash('sha256').update(contents.join('\n')).digest('hex').slice(0,12);
for(let i=0;i<assets.length;i++){let text=contents[i];if(assets[i].endsWith('.js'))text=text.replace(/(['"])(\.\/[a-z-]+\.js)\1/g,(_,quote,path)=>`${quote}${path}?v=${version}${quote}`);if(assets[i]==='index.html')text=text.replace('src="app.js"',`src="app.js?v=${version}"`).replace('href="style.css"',`href="style.css?v=${version}"`);await writeFile(resolve(destination,assets[i]),text);}
await mkdir(resolve(destination,'assets'),{recursive:true});
for(const name of ['icon.png','favicon.png','apple-touch-icon.png'])await copyFile(resolve(root,'assets',name),resolve(destination,'assets',name));
await writeFile(resolve(destination,'deployment.js'),'export const STATIC_HOST = true;\n');
await writeFile(resolve(destination,'.nojekyll'),'');
console.log(`Prepared ${assets.length+5} static assets. No room server, AI engine, model, or credentials included.`);
