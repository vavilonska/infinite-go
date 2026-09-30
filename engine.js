// Infinite Go: deterministic local rules, no engine evaluations in match scoring.
export const other = color => color === 'B' ? 'W' : 'B';
const fail = message => { throw new Error(message); };
const gcd = (a,b) => b ? gcd(b,a%b) : a;
export function fraction(n=1n,d=1n) { n=BigInt(n); d=BigInt(d); if(d<=0n||n<0n) fail('Invalid weight'); const g=gcd(n,d); return {n:String(n/g),d:String(d/g)}; }
export const half = w => fraction(w.n,BigInt(w.d)*2n);
export const add = (a,b) => fraction(BigInt(a.n)*BigInt(b.d)+BigInt(b.n)*BigInt(a.d),BigInt(a.d)*BigInt(b.d));
export const weightText = w => `${w.n}/${w.d}`;
export const majority = w => BigInt(w.n)*2n>BigInt(w.d);
export function neighbors(i,size) { const x=i%size,y=Math.floor(i/size); return [x?i-1:-1,x<size-1?i+1:-1,y?i-size:-1,y<size-1?i+size:-1].filter(n=>n>=0); }
export function group(board,i,size) { const color=board[i], stones=new Set([i]), liberties=new Set(), todo=[i]; while(todo.length) for(const n of neighbors(todo.pop(),size)) { if(!board[n]) liberties.add(n); else if(board[n]===color&&!stones.has(n)) { stones.add(n); todo.push(n); } } return {stones:[...stones],liberties}; }
export function initial(size) { return {board:Array(size*size).fill(null),toPlay:'B',passes:0,seen:new Set([Array(size*size).fill('.').join('')])}; }
const hash = board => board.map(x=>x||'.').join('');
export function apply(state,move,size) {
  const s={board:[...state.board],toPlay:other(state.toPlay),passes:0,seen:new Set(state.seen)};
  if(move.type==='resume') { if(state.passes!==2) fail('Can only resume after two passes'); return {...s,toPlay:state.toPlay}; }
  if(state.passes===2) fail('Scoring is pending');
  if(move.color!==state.toPlay) fail('Wrong player');
  if(move.type==='pass') return {...s,passes:state.passes+1}; // Pass exempt from positional superko.
  if(move.type!=='play'||!Number.isInteger(move.at)||move.at<0||move.at>=size*size) fail('Invalid move');
  if(s.board[move.at]) fail('This intersection is occupied');
  s.board[move.at]=move.color;
  for(const n of neighbors(move.at,size)) if(s.board[n]===other(move.color)) { const g=group(s.board,n,size); if(!g.liberties.size) for(const p of g.stones) s.board[p]=null; }
  if(!group(s.board,move.at,size).liberties.size) fail('Suicide is not allowed');
  const key=hash(s.board); if(s.seen.has(key)) fail('Positional superko: this board has appeared on this history');
  s.seen.add(key); return s;
}
export function replay(history,size) { return history.reduce((s,m)=>apply(s,m,size),initial(size)); }
const moveKey = m => m.type==='play'?`${m.color}:${m.at}`:m.type==='pass'?`${m.color}:pass`:'resume';
export const historyKey = history => history.map(moveKey).join('|');
export function createGame(size=9,komi=7.5,branchLimitExponent=9) {
  if(branchLimitExponent!==null&&(!Number.isSafeInteger(branchLimitExponent)||branchLimitExponent<2||branchLimitExponent>4096)) fail('分叉门槛指数需为 2 至 4096，或 null 表示不限制');
  if(![9,13,19].includes(size)||!Number.isFinite(komi)||Math.abs(komi)>100) fail('Use size 9, 13 or 19 and komi between -100 and 100');
  return {format:'infinite-go',version:1,size,komi,branchLimitExponent,nextId:2,round:1,queue:[1],lines:[{id:1,parent:null,forkAt:null,weight:fraction(),history:[],status:'playing',dead:[],approvals:[]}]};
}
export function canBranch(game,line) { return game.branchLimitExponent==null||BigInt(line.weight.n)*(2n**BigInt(game.branchLimitExponent))>BigInt(line.weight.d); }
export const lineById = (game,id) => game.lines.find(l=>l.id===id) || fail('Unknown timeline');
export function ensureRound(game) { if(!game.queue.length) { const ids=game.lines.filter(l=>l.status==='playing').map(l=>l.id).sort((a,b)=>a-b); if(ids.length) { game.round++;game.queue=ids; } } }
function consume(game,id) { if(game.queue[0]!==id) fail('Play the highlighted timeline first');game.queue.shift();ensureRound(game); }
export function play(game,id,index,at=null) {
  const line=lineById(game,id); if(line.status!=='playing'||game.queue[0]!==id) fail('This timeline is not the current turn');
  if(!Number.isInteger(index)||index<0||index>line.history.length) fail('Invalid history position');
  const current=replay(line.history,game.size),prefix=line.history.slice(0,index),state=replay(prefix,game.size);
  if(state.toPlay!==current.toPlay) fail('Choose a historical turn for the current player');
  const move=at===null?{type:'pass',color:state.toPlay}:{type:'play',color:state.toPlay,at};
  const next=apply(state,move,game.size),target=[...prefix,move],key=historyKey(target);
  // Every existing outgoing edge counts, including ordinary play on any timeline.
  if(game.lines.some(l=>l.history.length>=target.length&&historyKey(l.history.slice(0,target.length))===key)) fail('That continuation already exists; choose a different move');
  let result=line;
  if(index<line.history.length) { if(!canBranch(game,line))fail('分叉权重已达到门槛；此时间线只能继续落子，不能再分叉');line.weight=half(line.weight); result={id:game.nextId++,parent:id,forkAt:index,weight:{...line.weight},history:target,status:'playing',dead:[],approvals:[]};game.lines.push(result); }
  else line.history.push(move);
  if(next.passes===2) result.status='scoring';
  consume(game,id);return result.id;
}
export function toggleDead(game,id,at) { const line=lineById(game,id);if(line.status!=='scoring') fail('Not in scoring'); const s=replay(line.history,game.size);if(!s.board[at]) return;const stones=group(s.board,at,game.size).stones,set=new Set(line.dead),remove=set.has(at);for(const p of stones) remove?set.delete(p):set.add(p);line.dead=[...set].sort((a,b)=>a-b);line.approvals=[]; }
export function score(game,id) {
  const l=lineById(game,id),board=[...replay(l.history,game.size).board];for(const p of l.dead) board[p]=null;
  let B=board.filter(x=>x==='B').length,W=board.filter(x=>x==='W').length+game.komi; const visited=new Set();
  for(let i=0;i<board.length;i++) if(!board[i]&&!visited.has(i)) { const area=[],border=new Set(),todo=[i];visited.add(i);while(todo.length) {const p=todo.pop();area.push(p);for(const n of neighbors(p,game.size)) if(board[n]) border.add(board[n]);else if(!visited.has(n)) {visited.add(n);todo.push(n);} }if(border.size===1) {if(border.has('B'))B+=area.length;else W+=area.length;} }
  return {B,W,winner:B>W?'B':W>B?'W':'draw'};
}
export function approveScore(game,id,color) { const l=lineById(game,id);if(l.status!=='scoring'||!['B','W'].includes(color)) fail('Invalid scoring approval');if(!l.approvals.includes(color))l.approvals.push(color);if(l.approvals.length===2) {l.result=score(game,id);l.status='settled';} }
export function resume(game,id) {const l=lineById(game,id);if(l.status!=='scoring')fail('Only unsettled scoring can resume');l.history.push({type:'resume'});l.status='playing';l.dead=[];l.approvals=[];ensureRound(game);}
export function totals(game) {const t={B:fraction(0),W:fraction(0),draw:fraction(0),unsettled:fraction(0)};for(const l of game.lines){const k=l.status==='settled'?l.result.winner:'unsettled';t[k]=add(t[k],l.weight);}return t;}
export const exportGame = game => JSON.stringify(game,null,2);
export function importGame(text) {
  const g=JSON.parse(text);if(g.format!=='infinite-go'||g.version!==1)fail('Unsupported save');if(g.branchLimitExponent===undefined)g.branchLimitExponent=null;createGame(g.size,g.komi,g.branchLimitExponent);
  if(!Array.isArray(g.lines)||!g.lines.length||!Array.isArray(g.queue))fail('Invalid save');
  const ids=new Set();let sum=fraction(0);
  for(const l of g.lines) {if(!Number.isSafeInteger(l.id)||l.id<1||ids.has(l.id))fail('Invalid timeline ID');ids.add(l.id);if(!Array.isArray(l.history)||!['playing','scoring','settled'].includes(l.status))fail('Invalid timeline');const s=replay(l.history,g.size);if((l.status==='playing')!==(s.passes<2))fail('Invalid status');if(!l.weight||!/^\d+$/.test(l.weight.n)||!/^\d+$/.test(l.weight.d)||l.weight.n==='0')fail('Invalid weight');l.weight=fraction(l.weight.n,l.weight.d);sum=add(sum,l.weight);if(!Array.isArray(l.dead)||new Set(l.dead).size!==l.dead.length||l.dead.some(p=>!Number.isInteger(p)||!s.board[p]))fail('Invalid dead stones');for(const p of l.dead)if(group(s.board,p,g.size).stones.some(n=>!l.dead.includes(n)))fail('Partial dead group');if(!Array.isArray(l.approvals)||l.approvals.some(c=>!['B','W'].includes(c))||new Set(l.approvals).size!==l.approvals.length)fail('Invalid approvals');if(l.status==='settled'){if(l.approvals.length!==2)fail('Missing score approval');l.result=score(g,l.id);}else if(l.approvals.length===2)fail('Invalid approvals'); }
  if(sum.n!==sum.d||!Number.isSafeInteger(g.nextId)||g.nextId<=Math.max(...ids)||!Number.isSafeInteger(g.round)||g.round<1||new Set(g.queue).size!==g.queue.length||g.queue.some(id=>!ids.has(id)||lineById(g,id).status!=='playing'))fail('Invalid round or weights');
  if(!g.queue.length&&g.lines.some(l=>l.status==='playing'))fail('Missing round queue');return g;
}
