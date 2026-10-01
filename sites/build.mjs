import {mkdir,cp,writeFile,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'..'),output=resolve(directory,'dist');
await rm(output,{recursive:true,force:true});await mkdir(resolve(output,'server'),{recursive:true});
execFileSync(process.execPath,[resolve(root,'scripts/build-static.mjs'),resolve(output,'client')],{stdio:'inherit'});
// This build is the online edition. Its API is always the same origin, never a
// copied deployment credential or the optional backup service.
await writeFile(resolve(output,'client/remote-config.js'),'export const DEFAULT_REMOTE_ENDPOINT = globalThis.location.origin;\nexport const ONLINE_PLAY_URL = globalThis.location.origin;\n');
await build({entryPoints:[resolve(root,'cloud/sites-entry.js')],outfile:resolve(output,'server/index.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'inline'});
await writeFile(resolve(output,'server/wrangler.json'),JSON.stringify({name:'infinite-go-sites',main:'index.js',compatibility_date:'2026-09-01',assets:{directory:'../client',binding:'ASSETS',run_worker_first:['/api/*']},d1_databases:[{binding:'DB',database_name:'infinite-go-sites',database_id:'00000000-0000-0000-0000-000000000000'}]}));
// Registration metadata belongs to each deployment, not the public repository.
try{await mkdir(resolve(output,'.openai'),{recursive:true});await cp(resolve(directory,'.openai/hosting.json'),resolve(output,'.openai/hosting.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
