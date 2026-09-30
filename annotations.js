import {initial,apply} from './engine.js';
// Move numbers include passes, never the administrative resume event.
export function boardAnnotations(line,index,size){
 let state=initial(size),moveNumber=0;const numbers=Array(size*size).fill(null);
 const end=Math.min(index,line.history.length),forkIndex=Number.isInteger(line.forkAt)&&line.parent!=null?line.forkAt:null;
 const branchMove=forkIndex===null?null:line.history.slice(0,forkIndex+1).filter(m=>m.type!=='resume').length;
 let branchAt=null;
 for(let j=0;j<end;j++){
  const move=line.history[j];state=apply(state,move,size);if(move.type!=='resume')moveNumber++;
  for(let p=0;p<numbers.length;p++)if(!state.board[p])numbers[p]=null;
  if(move.type==='play')numbers[move.at]=moveNumber;
 }
 if(forkIndex!==null&&forkIndex<end){const move=line.history[forkIndex];if(move?.type==='play'&&numbers[move.at]===branchMove)branchAt=move.at;}
 return {state,numbers,moveNumber,branchMove,branchAt};
}
export function moveCoordinate(move,size){
 if(!move)return '未知';if(move.type==='pass')return '停一手';if(move.type!=='play')return '续弈';
 return 'ABCDEFGHJKLMNOPQRST'[move.at%size]+(size-Math.floor(move.at/size));
}
export function branchDescription(game,line){
 if(line.parent==null||!Number.isInteger(line.forkAt))return '';
 const move=line.history[line.forkAt],parent=game.lines.find(l=>l.id===line.parent)??(game.archives??[]).flatMap(a=>a.lines).find(l=>l.id===line.parent);
 const number=line.history.slice(0,line.forkAt+1).filter(m=>m.type!=='resume').length;
 return `从第 ${number} 手分叉：${move?.color==='B'?'黑':'白'}${moveCoordinate(move,game.size)}（原着 ${moveCoordinate(parent?.history[line.forkAt],game.size)}）· 来源 #${line.parent}`;
}
