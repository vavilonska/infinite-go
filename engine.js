// Infinite Go: deterministic local rules, no engine evaluations in match scoring.
export const other = color => color === 'B' ? 'W' : 'B';
const fail = message => { throw new Error(message); };
const gcd = (a,b) => b ? gcd(b,a%b) : a;
const abs = n => n<0n?-n:n;
// Signed rational arithmetic is also used for komi: never compare rule thresholds as floats.
export function rational(n=0n,d=1n) { n=BigInt(n);d=BigInt(d);if(d<=0n)fail('Invalid denominator');const g=gcd(abs(n),d);return {n:String(n/g),d:String(d/g)}; }
export function fraction(n=1n,d=1n) { n=BigInt(n); d=BigInt(d); if(d<=0n||n<0n) fail('Invalid weight');return rational(n,d); }
export const half = w => fraction(w.n,BigInt(w.d)*2n);
export const add = (a,b) => rational(BigInt(a.n)*BigInt(b.d)+BigInt(b.n)*BigInt(a.d),BigInt(a.d)*BigInt(b.d));
export const subtract = (a,b) => rational(BigInt(a.n)*BigInt(b.d)-BigInt(b.n)*BigInt(a.d),BigInt(a.d)*BigInt(b.d));
export const multiply = (a,b) => rational(BigInt(a.n)*BigInt(b.n),BigInt(a.d)*BigInt(b.d));
export const divide = (a,b) => {if(BigInt(b.n)<=0n)fail('Invalid divisor');return rational(BigInt(a.n)*BigInt(b.d),BigInt(a.d)*BigInt(b.n));};
export const compare = (a,b) => {const v=BigInt(a.n)*BigInt(b.d)-BigInt(b.n)*BigInt(a.d);return v<0n?-1:v>0n?1:0;};
export const weightText = w => `${w.n}/${w.d}`;
export const majority = w => BigInt(w.n)*2n>BigInt(w.d);
const zero = () => rational();
const numeric = q => Number(q.n)/Number(q.d);
function decimalRational(value) {
  const m=String(value).match(/^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);if(!m)fail('Invalid decimal');
  const digits=BigInt(m[2]+(m[3]||''))*(m[1]?-1n:1n),places=(m[3]||'').length-Number(m[4]||0);
  return places>=0?rational(digits,10n**BigInt(places)):rational(digits*10n**BigInt(-places));
}
// C is a plain decimal, 1..1e12 inclusive, with up to twelve fractional places.
function parseC(value='32') {
  const s=String(value);if(!/^\d+(?:\.\d{1,12})?$/.test(s)||s.length>40)fail('C must be a decimal from 1 to 1000000000000, with at most 12 decimal places');
  const q=decimalRational(s);if(compare(q,fraction())<0||compare(q,fraction(1000000000000n))>0)fail('C must be between 1 and 1000000000000');
  const [whole,decimals='']=s.split('.'),tail=decimals.replace(/0+$/,'');return {C:whole.replace(/^0+(?=\d)/,'')+(tail?'.'+tail:''),q};
}
const roundUpHalf = q => fraction((2n*BigInt(q.n)+BigInt(q.d)-1n)/BigInt(q.d),2n);
export function compensationInfo(C='32') {
  const parsed=parseC(C),twice=multiply(parsed.q,fraction(2));let exponent=0,denominator=1n;
  while(compare(fraction(denominator*2n),twice)<=0){denominator*=2n;exponent++;}
  const theoreticalMin=divide(fraction(1,2),parsed.q),actualMin=fraction(1,denominator),rawMinimumCompensation=multiply(parsed.q,actualMin);
  return {C:parsed.C,theoreticalMin,actualMin,exponent,rawMinimumCompensation,roundedMinimumCompensation:roundUpHalf(rawMinimumCompensation)};
}
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
const hasPrefix = (history,prefix) => history.length>=prefix.length&&historyKey(history.slice(0,prefix.length))===historyKey(prefix);
export function createGame(size=9,komi=7.5,branchLimitExponent=9,options={}) {
  if(branchLimitExponent!==null&&(!Number.isSafeInteger(branchLimitExponent)||branchLimitExponent<2||branchLimitExponent>4096)) fail('分叉门槛指数需为 2 至 4096，或 null 表示不限制');
  if(![9,13,19].includes(size)||!Number.isFinite(komi)||Math.abs(komi)>100) fail('Use size 9, 13 or 19 and komi between -100 and 100');
  const pruningMode=options.pruningMode===undefined?'none':options.pruningMode,compensationC=parseC(options.compensationC===undefined?'32':options.compensationC).C;
  if(!['none','resign','komi'].includes(pruningMode))fail('Invalid pruning mode');
  return {format:'infinite-go',version:1,size,komi,branchLimitExponent,pruningMode,compensationC,komiCompensation:zero(),archives:[],nextId:2,round:1,queue:[1],lines:[{id:1,parent:null,forkAt:null,weight:fraction(),history:[],status:'playing',dead:[],approvals:[]}]};
}
export function canBranch(game,line) {
  if(game.pruningMode==='komi')return compare(half(line.weight),compensationInfo(game.compensationC).actualMin)>=0;
  return game.branchLimitExponent==null||BigInt(line.weight.n)*(2n**BigInt(game.branchLimitExponent))>BigInt(line.weight.d);
}
export const lineById = (game,id) => game.lines.find(l=>l.id===id) || fail('Unknown timeline');
function exactKomi(game,line) {return line?.status==='settled'&&line.frozenKomi?line.frozenKomi:add(decimalRational(game.komi),game.komiCompensation??zero());}
export function effectiveKomi(game,lineOrId) {const line=typeof lineOrId==='number'?lineById(game,lineOrId):lineOrId;return numeric(exactKomi(game,line));}
export function ensureRound(game) { if(!game.queue.length) { const ids=game.lines.filter(l=>l.status==='playing').map(l=>l.id).sort((a,b)=>a-b); if(ids.length) { game.round++;game.queue=ids; } } }
function consume(game,id) { if(game.queue[0]!==id) fail('Play the highlighted timeline first');game.queue.shift();ensureRound(game); }
function continuationExists(game,target) {
  return game.lines.some(l=>hasPrefix(l.history,target))||(game.archives??[]).some(a=>a.lines.some(l=>hasPrefix(l.history,target)));
}
export function play(game,id,index,at=null) {
  const line=lineById(game,id); if(line.status!=='playing'||game.queue[0]!==id) fail('This timeline is not the current turn');
  if(!Number.isInteger(index)||index<0||index>line.history.length) fail('Invalid history position');
  const current=replay(line.history,game.size),prefix=line.history.slice(0,index),state=replay(prefix,game.size);
  if(state.toPlay!==current.toPlay) fail('Choose a historical turn for the current player');
  const move=at===null?{type:'pass',color:state.toPlay}:{type:'play',color:state.toPlay,at};
  const next=apply(state,move,game.size),target=[...prefix,move];
  // Every complete-history edge counts forever, including archived ordinary play.
  if(continuationExists(game,target)) fail('That continuation already exists or is archived; choose a different move');
  let result=line;
  if(index<line.history.length) { if(!canBranch(game,line))fail('分叉权重已达到门槛；此时间线只能继续落子，不能再分叉');line.weight=half(line.weight); result={id:game.nextId++,parent:id,forkAt:index,weight:{...line.weight},history:target,status:'playing',dead:[],approvals:[]};game.lines.push(result); }
  else line.history.push(move);
  if(next.passes===2) result.status='scoring';
  consume(game,id);return result.id;
}
export function toggleDead(game,id,at) { const line=lineById(game,id);if(line.status!=='scoring') fail('Not in scoring'); const s=replay(line.history,game.size);if(!s.board[at]) return;const stones=group(s.board,at,game.size).stones,set=new Set(line.dead),remove=set.has(at);for(const p of stones) remove?set.delete(p):set.add(p);line.dead=[...set].sort((a,b)=>a-b);line.approvals=[]; }
export function score(game,id) {
  const l=lineById(game,id);if(l.status==='settled'&&l.result?.reason==='resignation')return {...l.result};
  const board=[...replay(l.history,game.size).board];for(const p of l.dead) board[p]=null;
  let B=board.filter(x=>x==='B').length,W=board.filter(x=>x==='W').length; const visited=new Set();
  for(let i=0;i<board.length;i++) if(!board[i]&&!visited.has(i)) { const area=[],border=new Set(),todo=[i];visited.add(i);while(todo.length) {const p=todo.pop();area.push(p);for(const n of neighbors(p,game.size)) if(board[n]) border.add(board[n]);else if(!visited.has(n)) {visited.add(n);todo.push(n);} }if(border.size===1) {if(border.has('B'))B+=area.length;else W+=area.length;} }
  const exactW=add(fraction(W),exactKomi(game,l)),comparison=compare(fraction(B),exactW);
  return {B,W:numeric(exactW),winner:comparison>0?'B':comparison<0?'W':'draw'};
}
function freezeKomi(game,line) {line.frozenKomi={...exactKomi(game,line)};line.settledAtArchiveCount=(game.archives??[]).length;}
export function approveScore(game,id,color) { const l=lineById(game,id);if(l.status!=='scoring'||!['B','W'].includes(color)) fail('Invalid scoring approval');if(!l.approvals.includes(color))l.approvals.push(color);if(l.approvals.length===2) {freezeKomi(game,l);l.result=score(game,id);l.status='settled';} }
export function resume(game,id) {const l=lineById(game,id);if(l.status!=='scoring')fail('Only unsettled scoring can resume');const target=[...l.history,{type:'resume'}];if(continuationExists(game,target))fail('That continuation already exists or is archived');l.history=target;l.status='playing';l.dead=[];l.approvals=[];ensureRound(game);}
export function totals(game) {const t={B:fraction(0),W:fraction(0),draw:fraction(0),unsettled:fraction(0)};for(const l of game.lines){const k=l.status==='settled'?l.result.winner:'unsettled';t[k]=add(t[k],l.weight);}return t;}
export function pruningInfo(game,sourceId,index,actor) {
  if(!['resign','komi'].includes(game.pruningMode))fail('Pruning is disabled');
  const source=lineById(game,sourceId);if(source.status!=='playing'||game.queue[0]!==sourceId)fail('Only the current timeline can prune');
  if(!['B','W'].includes(actor)||actor!==replay(source.history,game.size).toPlay)fail('Only the current player can prune');
  if(!Number.isInteger(index)||index<1||index>source.history.length)fail('Choose a non-root history node to prune');
  const prefix=source.history.slice(0,index),affected=game.lines.filter(l=>hasPrefix(l.history,prefix));
  if(affected.some(l=>l.status==='settled'))fail('Cannot prune a subtree containing a settled timeline');
  const subtreeWeight=affected.reduce((w,l)=>add(w,l.weight),fraction(0)),unsettledWeight=totals(game).unsettled,remainingUnsettledWeight=subtract(unsettledWeight,subtreeWeight);
  if(compare(remainingUnsettledWeight,zero())<=0)fail('Cannot prune every unsettled timeline');
  let komiDelta=zero();
  if(game.pruningMode==='komi') {const raw=multiply(parseC(game.compensationC).q,subtreeWeight);if(compare(raw,fraction(1,2))<0)fail('Subtree compensation is below the 0.5 point minimum');komiDelta=roundUpHalf(raw);if(actor==='W')komiDelta=rational(-BigInt(komiDelta.n),komiDelta.d);}
  return {mode:game.pruningMode,actor,sourceId,index,prefix:structuredClone(prefix),affectedIds:affected.map(l=>l.id),subtreeWeight,unsettledWeight,remainingUnsettledWeight,komiDelta};
}
export function prune(game,sourceId,index,actor) {
  const info=pruningInfo(game,sourceId,index,actor),ids=new Set(info.affectedIds),affected=game.lines.filter(l=>ids.has(l.id)),before={...(game.komiCompensation??zero())};
  if(info.mode==='resign') {for(const line of affected){freezeKomi(game,line);line.status='settled';line.result={winner:other(actor),reason:'resignation',resignedBy:actor};line.archived=true;line.approvals=[];}}
  const archived=affected.map(line=>({...structuredClone(line),archived:true,archivedKomi:{...exactKomi(game,line)}}));
  if(info.mode==='komi') {
    game.lines=game.lines.filter(l=>!ids.has(l.id));
    for(const line of game.lines)if(line.status!=='settled'){line.weight=multiply(line.weight,divide(info.unsettledWeight,info.remainingUnsettledWeight));line.approvals=[];}
    game.komiCompensation=add(before,info.komiDelta);
  }
  game.archives.push({mode:info.mode,actor,prefix:info.prefix,sourceId,index,lines:archived,subtreeWeight:info.subtreeWeight,komiDelta:info.komiDelta,compensationBefore:before,compensationAfter:{...game.komiCompensation},round:game.round});
  // The source's action is consumed; only now may a fresh round include surviving leaves.
  game.queue=game.queue.filter(id=>!ids.has(id));ensureRound(game);return info;
}
export const exportGame = game => JSON.stringify(game,null,2);
function readRational(q,signed=false) {
  if(!q||typeof q.n!=='string'||typeof q.d!=='string'||!(signed?/^-?\d+$/:/^\d+$/).test(q.n)||!/^\d+$/.test(q.d))fail('Invalid rational');
  return signed?rational(q.n,q.d):fraction(q.n,q.d);
}
export function importGame(text) {
  const g=JSON.parse(text);if(!g||g.format!=='infinite-go'||g.version!==1)fail('Unsupported save');
  const legacy=g.pruningMode===undefined&&g.compensationC===undefined&&g.komiCompensation===undefined&&g.archives===undefined;
  if(g.branchLimitExponent===undefined)g.branchLimitExponent=null;
  if(legacy){g.pruningMode='none';g.compensationC='32';g.komiCompensation=zero();g.archives=[];}
  const validated=createGame(g.size,g.komi,g.branchLimitExponent,{pruningMode:g.pruningMode,compensationC:g.compensationC});
  if(g.pruningMode!==validated.pruningMode||g.compensationC===undefined)fail('Invalid pruning settings');g.compensationC=validated.compensationC;
  g.komiCompensation=readRational(g.komiCompensation,true);
  if(!Array.isArray(g.lines)||!g.lines.length||!Array.isArray(g.queue)||!Array.isArray(g.archives))fail('Invalid save');
  if(g.pruningMode==='none'&&(g.archives.length||compare(g.komiCompensation,zero())))fail('Unexpected pruning ledger');
  const ledger=[zero()],archiveIds=new Set(),archivedResign=new Map(),priorPrefixes=[];let archiveRound=0;
  for(const a of g.archives) {
    if(!a||a.mode!==g.pruningMode||!['resign','komi'].includes(a.mode)||!['B','W'].includes(a.actor)||!Array.isArray(a.prefix)||!a.prefix.length||!Array.isArray(a.lines)||!a.lines.length||!Number.isSafeInteger(a.round)||a.round<1||a.round>g.round||!Number.isSafeInteger(a.sourceId)||!Number.isInteger(a.index)||a.index!==a.prefix.length)fail('Invalid archive');
    if(a.round<archiveRound)fail('Archive rounds are out of order');archiveRound=a.round;replay(a.prefix,g.size);a.subtreeWeight=readRational(a.subtreeWeight);a.komiDelta=readRational(a.komiDelta,true);a.compensationBefore=readRational(a.compensationBefore,true);a.compensationAfter=readRational(a.compensationAfter,true);
    if(compare(a.compensationBefore,ledger.at(-1)))fail('Invalid compensation ledger');
    let sum=fraction(0);for(const l of a.lines){if(!Number.isSafeInteger(l.id)||l.id<1||archiveIds.has(l.id)||!Array.isArray(l.history)||!hasPrefix(l.history,a.prefix)||l.archived!==true)fail('Invalid archived timeline');if(priorPrefixes.some(prefix=>hasPrefix(l.history,prefix)))fail('Archived route was recreated');archiveIds.add(l.id);validateLine(l,true);sum=add(sum,l.weight);if(a.mode==='resign'){if(l.status!=='settled'||l.result?.reason!=='resignation'||l.result.winner!==other(a.actor)||l.result.resignedBy!==a.actor)fail('Invalid resignation');archivedResign.set(l.id,l);}else if(l.status==='settled')fail('Cannot discard a settled timeline');}
    const source=a.lines.find(l=>l.id===a.sourceId);if(!source||replay(source.history,g.size).passes===2||replay(source.history,g.size).toPlay!==a.actor||compare(sum,a.subtreeWeight)||compare(sum,fraction())>=0)fail('Invalid archived subtree weight or actor');
    let expected=zero();if(a.mode==='komi'){const raw=multiply(parseC(g.compensationC).q,sum);if(compare(raw,fraction(1,2))<0)fail('Invalid minimum compensation');expected=roundUpHalf(raw);if(a.actor==='W')expected=rational(-BigInt(expected.n),expected.d);}
    if(compare(expected,a.komiDelta)||compare(add(ledger.at(-1),expected),a.compensationAfter))fail('Invalid compensation delta');ledger.push(a.compensationAfter);priorPrefixes.push(a.prefix);
  }
  if(compare(ledger.at(-1),g.komiCompensation))fail('Invalid compensation total');
  const ids=new Set();let sum=fraction(0);
  for(const l of g.lines) {
    if(!Number.isSafeInteger(l.id)||l.id<1||ids.has(l.id))fail('Invalid timeline ID');ids.add(l.id);validateLine(l,false);sum=add(sum,l.weight);
    if(l.archived===true){const archived=archivedResign.get(l.id);if(!archived||JSON.stringify(l.history)!==JSON.stringify(archived.history)||compare(l.weight,archived.weight)||compare(l.frozenKomi,archived.frozenKomi)||l.result.winner!==archived.result.winner||l.result.resignedBy!==archived.result.resignedBy)fail('Invalid archived resignation');}
    else if(archiveIds.has(l.id)||g.archives.some(a=>hasPrefix(l.history,a.prefix)||a.lines.some(archived=>hasPrefix(archived.history,l.history))))fail('Archived subtree has been recreated');
  }
  for(const id of archivedResign.keys())if(!ids.has(id))fail('Missing resignation settlement');
  for(let i=0;i<g.lines.length;i++)for(let j=i+1;j<g.lines.length;j++)if(hasPrefix(g.lines[i].history,g.lines[j].history)||hasPrefix(g.lines[j].history,g.lines[i].history))fail('Overlapping timeline histories');
  const allIds=[...ids,...archiveIds];
  if(sum.n!==sum.d||!Number.isSafeInteger(g.nextId)||g.nextId<=Math.max(...allIds)||!Number.isSafeInteger(g.round)||g.round<1||new Set(g.queue).size!==g.queue.length||g.queue.some(id=>!ids.has(id)||lineById(g,id).status!=='playing'))fail('Invalid round or weights');
  if(!g.queue.length&&g.lines.some(l=>l.status==='playing'))fail('Missing round queue');return g;
  function validateLine(l,inArchive) {
    if(!Array.isArray(l.history)||!['playing','scoring','settled'].includes(l.status))fail('Invalid timeline');
    const s=replay(l.history,g.size),resignation=l.result?.reason==='resignation';
    if(resignation){if(g.pruningMode!=='resign'||l.status!=='settled'||l.archived!==true||!['B','W'].includes(l.result.winner)||l.result.winner!==other(l.result.resignedBy))fail('Invalid resignation');}
    else if((l.status==='playing')!==(s.passes<2))fail('Invalid status');
    l.weight=readRational(l.weight);if(BigInt(l.weight.n)<=0n)fail('Invalid weight');
    if(!Array.isArray(l.dead)||new Set(l.dead).size!==l.dead.length||l.dead.some(p=>!Number.isInteger(p)||!s.board[p]))fail('Invalid dead stones');for(const p of l.dead)if(group(s.board,p,g.size).stones.some(n=>!l.dead.includes(n)))fail('Partial dead group');
    if(!Array.isArray(l.approvals)||l.approvals.some(c=>!['B','W'].includes(c))||new Set(l.approvals).size!==l.approvals.length)fail('Invalid approvals');
    if(l.status==='settled') {
      if(!resignation&&l.approvals.length!==2)fail('Missing score approval');if(resignation&&l.approvals.length)fail('Invalid resignation approvals');
      if(legacy){l.frozenKomi=decimalRational(g.komi);l.settledAtArchiveCount=0;}
      l.frozenKomi=readRational(l.frozenKomi,true);const count=l.settledAtArchiveCount;
      if(!Number.isSafeInteger(count)||count<0||count>=ledger.length||compare(l.frozenKomi,add(decimalRational(g.komi),ledger[count])))fail('Invalid frozen komi');
      if(!resignation&&!inArchive)l.result=score(g,l.id);
    }else if(l.approvals.length===2||l.frozenKomi!==undefined||l.result!==undefined||l.archived===true&&!inArchive)fail('Invalid unsettled timeline');
    if(inArchive){l.archivedKomi=readRational(l.archivedKomi,true);if(compare(l.archivedKomi,l.status==='settled'?l.frozenKomi:add(decimalRational(g.komi),ledger.at(-1))))fail('Invalid archived komi');}
  }
}
