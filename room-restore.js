import {importGame} from './engine.js';
const fail=(message,status=400)=>{const error=new Error(message);error.status=status;throw error;};
export function restoredGame(options){
 if(!options.restoreGame||typeof options.restoreGame!=='object')fail('Choose a valid saved game');
 if(Object.keys(options).some(key=>!['restoreGame','hostColor'].includes(key)))fail('Restored rules come from the save, not new-game settings');
 const raw=options.restoreGame;
 if(JSON.stringify(raw).length>96000)fail('Saved game exceeds hosted room capacity',413);
 const lines=[...(Array.isArray(raw.lines)?raw.lines:[]),...(Array.isArray(raw.archives)?raw.archives.flatMap(a=>Array.isArray(a.lines)?a.lines:[]):[])];
 if(lines.length>128||lines.some(l=>!Array.isArray(l.history)||l.history.length>512)||lines.reduce((n,l)=>n+l.history.length,0)>2048)fail('Saved game exceeds hosted timeline capacity',413);
 try{return importGame(JSON.stringify(raw));}catch(error){fail('Invalid saved game: '+error.message);}
}
export const restorePublic=room=>room.restoration?{pending:room.restoration.confirmations.length<2,confirmations:[...room.restoration.confirmations]}:null;
export function requireRestoreReady(room){if(room.restoration&&room.restoration.confirmations.length<2)fail('Both players must confirm the restored position before continuing',409);}
export function confirmRestoration(room,seat,body){
 if(!['A','B'].includes(seat))fail('A player seat is required',403);
 if(!body||Object.keys(body).some(k=>k!=='revision')||!Number.isSafeInteger(body.revision))fail('Invalid confirmation');
 if(body.revision!==room.revision)fail('State changed; refresh and confirm again',409);
 if(!room.restoration)fail('This is not a restored room',409);
 if(!room.tokens.B)fail('Wait for the other player to join',409);
 const next=structuredClone(room);
 if(!next.restoration.confirmations.includes(seat)){next.restoration.confirmations.push(seat);next.revision++;}
 return next;
}
