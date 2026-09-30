import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../engine.js';

const moves = points => points.map((at,i)=>at===null?{type:'pass',color:i%2?'W':'B'}:{type:'play',color:i%2?'W':'B',at});
function fixture(mode='komi',C='32',specs=[{points:[0,1,2,3],weight:[1,4]},{points:[0,1,4,5],weight:[1,4]},{points:[2,3,0,1],weight:[1,2]}]) {
  const game=E.createGame(9,7.5,2,{pruningMode:mode,compensationC:C});
  game.lines=specs.map(({points,weight},i)=>({id:i+1,parent:i?1:null,forkAt:i?0:null,weight:E.fraction(...weight),history:moves(points),status:points.slice(-2).every(p=>p===null)?'scoring':'playing',dead:[],approvals:[]}));
  game.nextId=game.lines.length+1;const ids=game.lines.filter(l=>l.status==='playing').map(l=>l.id);game.turns={B:{epoch:1,pending:[...ids]},W:{epoch:1,pending:[...ids]}};E.ensureRound(game);return game;
}
const settle = (game,id) => {E.approveScore(game,id,'B');E.approveScore(game,id,'W');};
const roundtrip = game => assert.deepEqual(E.importGame(E.exportGame(game)),game);

test('exact decimal C and dyadic thresholds, including the upward C=20 bucket',()=>{
  for(const [C,denominator] of [['8',16],['32',64],['256',512],['20',32],['1',2],['1.5',2]]){
    const info=E.compensationInfo(C);assert.deepEqual(info.actualMin,E.fraction(1,denominator));
    assert.ok(E.compare(info.actualMin,info.theoreticalMin)>=0);
  }
  const info=E.compensationInfo('020.000');assert.equal(info.C,'20');assert.deepEqual(info.theoreticalMin,E.fraction(1,40));assert.deepEqual(info.rawMinimumCompensation,E.fraction(5,8));assert.deepEqual(info.roundedMinimumCompensation,E.fraction(1));
  assert.deepEqual(E.compensationInfo('15.999999999999').actualMin,E.fraction(1,16));
  assert.deepEqual(E.compensationInfo('16').actualMin,E.fraction(1,32));
  assert.deepEqual(E.compensationInfo('31.999999999999').actualMin,E.fraction(1,32));
  assert.deepEqual(E.compensationInfo('32.000000000001').actualMin,E.fraction(1,64));
  for(const C of [null,'0.9','-2','Infinity','1/2','2e2','1.0000000000001','1000000000001'])assert.throws(()=>E.compensationInfo(C));
  assert.throws(()=>E.createGame(9,7.5,9,{compensationC:null}));
  assert.throws(()=>E.createGame(9,7.5,9,{pruningMode:null}));
});

test('komi branch uses exact newborn dyadic minimum and ignores old manual threshold',()=>{
  const g=E.createGame(9,7.5,4096,{pruningMode:'komi',compensationC:'20'}),l=g.lines[0];
  for(const [weight,allowed] of [[[1,16],true],[[1,32],false],[[3,50],false],[[1,15],true]]){l.weight=E.fraction(...weight);assert.equal(E.canBranch(g,l),allowed);}
  g.branchLimitExponent=null;l.weight=E.fraction(1,32);assert.equal(E.canBranch(g,l),false);
  const none=E.createGame(9,7.5,null);none.lines[0].weight=E.fraction(1,2n**100n);assert.equal(E.canBranch(none,none.lines[0]),true);
});

test('subtree means full-history prefix, not same board or parent-ID descendants',()=>{
  const g=fixture();assert.deepEqual(E.replay(g.lines[0].history,9).board,E.replay(g.lines[2].history,9).board);
  const before=E.exportGame(g),preview=E.pruningInfo(g,1,1,'B');assert.equal(E.exportGame(g),before);
  assert.deepEqual(preview.affectedIds,[1,2]);assert.deepEqual(preview.subtreeWeight,E.fraction(1,2));assert.deepEqual(preview.komiDelta,E.fraction(16));
  assert.deepEqual(E.prune(g,1,1,'B'),preview);assert.deepEqual(g.lines.map(l=>l.id),[3]);assert.deepEqual(g.lines[0].weight,E.fraction());
  assert.equal(E.effectiveKomi(g,3),23.5);assert.deepEqual(g.queue,[3]);assert.equal(g.round,1);assert.deepEqual(g.archives[0].lines.map(l=>l.id),[1,2]);assert.deepEqual(E.totals(g).unsettled,E.fraction());roundtrip(g);
});

test('pruning permissions, roots, whole game and settled descendants are rejected atomically',()=>{
  for(const [mode,source,index,actor] of [['none',1,1,'B'],['komi',99,1,'B'],['komi',1,0,'B'],['komi',1,1,'W'],['komi',1,99,'B']]){
    const g=fixture(mode),before=E.exportGame(g);assert.throws(()=>E.prune(g,source,index,actor));assert.equal(E.exportGame(g),before);
  }
  const only=E.createGame(9,7.5,9,{pruningMode:'komi'});E.play(only,1,0,0);const before=E.exportGame(only);assert.throws(()=>E.prune(only,1,1,'W'),/every unsettled/);assert.equal(E.exportGame(only),before);
  const g=fixture('komi','32',[{points:[0,1,2,3],weight:[1,4]},{points:[0,1,4,5,null,null],weight:[1,4]},{points:[2,3,0,1],weight:[1,2]}]);settle(g,2);const beforeSettled=E.exportGame(g);assert.throws(()=>E.prune(g,1,1,'B'),/settled/);assert.equal(E.exportGame(g),beforeSettled);
});

test('komi renormalizes only unsettled weights and freezes existing settlements forever',()=>{
  const g=fixture('komi','32',[{points:[0,1,2,3],weight:[1,4]},{points:[0,1,4,5,null,null],weight:[1,4]},{points:[2,3,0,1],weight:[1,2]}]);settle(g,2);
  const settledBefore=structuredClone(E.lineById(g,2));E.prune(g,1,3,'B');assert.deepEqual(E.lineById(g,2),settledBefore);assert.deepEqual(E.lineById(g,3).weight,E.fraction(3,4));
  assert.equal(E.effectiveKomi(g,2),7.5);assert.equal(E.effectiveKomi(g,3),15.5);assert.deepEqual(E.score(g,2),settledBefore.result);assert.deepEqual(E.totals(g).unsettled,E.fraction(3,4));roundtrip(g);
});

test('global compensation is inherited by branches and reverses sign for White pruning',()=>{
  const g=fixture();E.prune(g,1,1,'B');const newborn=E.play(g,3,0,6);assert.equal(E.effectiveKomi(g,newborn),23.5);assert.equal(E.effectiveKomi(g,3),23.5);
  E.play(g,3,4,8);assert.ok(E.canActOn(g,newborn,'W'));const preview=E.pruningInfo(g,newborn,1,'W');assert.deepEqual(preview.komiDelta,E.rational(-16));E.prune(g,newborn,1,'W');assert.equal(E.effectiveKomi(g,3),7.5);assert.deepEqual(g.komiCompensation,E.rational());assert.deepEqual(g.queue,[3]);assert.equal(g.round,3);roundtrip(g);
});

test('raw compensation boundary is exact and rounds upward to half-points',()=>{
  const exact=fixture('komi','20',[{points:[0,1],weight:[1,40]},{points:[2,3],weight:[39,40]}]);assert.deepEqual(E.pruningInfo(exact,1,1,'B').komiDelta,E.fraction(1,2));
  const below=fixture('komi','20',[{points:[0,1],weight:[1,41]},{points:[2,3],weight:[40,41]}]);const before=E.exportGame(below);assert.throws(()=>E.prune(below,1,1,'B'),/minimum/);assert.equal(E.exportGame(below),before);
  const bucket=fixture('komi','20',[{points:[0,1],weight:[1,32]},{points:[2,3],weight:[31,32]}]);assert.deepEqual(E.pruningInfo(bucket,1,1,'B').komiDelta,E.fraction(1));
  const close=fixture('komi','20.000000000001',[{points:[0,1],weight:[1,40]},{points:[2,3],weight:[39,40]}]);assert.deepEqual(E.pruningInfo(close,1,1,'B').komiDelta,E.fraction(1));
});

test('archived full-history edges cannot be replayed through branching or ordinary play',()=>{
  const g=fixture();E.prune(g,1,1,'B');const before=E.exportGame(g);assert.throws(()=>E.play(g,3,0,0),/archived/);assert.equal(E.exportGame(g),before);
  // Build an otherwise valid leaf that tries to replay an archived ordinary first edge.
  const ordinary=structuredClone(g);ordinary.lines[0].history=[];ordinary.queue=[3];const ordinaryBefore=E.exportGame(ordinary);assert.throws(()=>E.play(ordinary,3,0,0),/archived/);assert.equal(E.exportGame(ordinary),ordinaryBefore);
  assert.doesNotThrow(()=>E.play(g,3,0,9));assert.equal(g.archives[0].lines[0].history.length,4);roundtrip(g);
});

test('resignation settles subtree for opponent, retains weights, and archives actual outcomes',()=>{
  const g=fixture('resign'),survivor=structuredClone(g.lines[2]);E.prune(g,1,1,'B');assert.deepEqual(g.lines[2],survivor);assert.deepEqual(E.totals(g).W,E.fraction(1,2));assert.deepEqual(E.totals(g).unsettled,E.fraction(1,2));assert.deepEqual(g.komiCompensation,E.rational());
  for(const id of [1,2]){const l=E.lineById(g,id);assert.equal(l.status,'settled');assert.equal(l.archived,true);assert.deepEqual(l.result,{winner:'W',reason:'resignation',resignedBy:'B'});assert.deepEqual(E.score(g,id),l.result);assert.equal(E.effectiveKomi(g,id),7.5);}
  assert.deepEqual(g.queue,[3]);assert.throws(()=>E.play(g,3,0,0),/exists|archived/);roundtrip(g);
});

test('White resignation credits Black and removes descendants from current snapshot only',()=>{
  const g=fixture('resign','32',[{points:[0,1,2],weight:[1,4]},{points:[0,1,4],weight:[1,4]},{points:[2],weight:[1,2]}]);g.queue=[1,3];E.prune(g,1,1,'W');assert.deepEqual(g.queue,[3]);assert.equal(g.round,1);assert.deepEqual(E.totals(g).B,E.fraction(1,2));roundtrip(g);
});

test('empty snapshot starts next round only after pruning; newly created leaves wait',()=>{
  const g=fixture();g.turns.B.pending=[1,2];g.turns.W.pending=[1,2];E.ensureRound(g);E.prune(g,1,1,'B');assert.deepEqual(g.queue,[3]);assert.equal(g.round,2);
  const h=fixture();h.turns.B.pending=[1,3];h.turns.W.pending=[1,3];E.ensureRound(h);E.prune(h,1,1,'B');assert.deepEqual(h.queue,[3]);assert.equal(h.round,1);
});

test('komi compensation invalidates remaining scoring approvals and supports no playing leaves',()=>{
  const g=fixture('komi','32',[{points:[0,1],weight:[1,2]},{points:[2,3,null,null],weight:[1,2]}]);E.approveScore(g,2,'B');E.prune(g,1,1,'B');assert.deepEqual(g.queue,[]);assert.deepEqual(g.lines[0].approvals,[]);assert.equal(E.effectiveKomi(g,2),23.5);assert.deepEqual(g.lines[0].weight,E.fraction());roundtrip(g);settle(g,2);assert.equal(g.lines[0].frozenKomi.n,'47');roundtrip(g);
});

test('expanded import validates ledger, archive routes, freezing, and resignation records',()=>{
  const g=fixture();E.prune(g,1,1,'B');
  for(const mutate of [x=>x.komiCompensation.n='17',x=>x.archives[0].komiDelta.n='17',x=>x.archives[0].subtreeWeight.n='2',x=>x.archives[0].lines[0].history=moves([9,1]),x=>x.lines[0].history=moves([0,1,7,8]),x=>x.nextId=2,x=>x.archives[0].sourceId=99,x=>x.archives[0].actor='W',x=>x.compensationC='0.5']){const corrupt=structuredClone(g);mutate(corrupt);assert.throws(()=>E.importGame(JSON.stringify(corrupt)));}
  const r=fixture('resign');E.prune(r,1,1,'B');for(const mutate of [x=>x.lines[0].result.winner='B',x=>delete x.lines[0].frozenKomi,x=>x.lines[0].frozenKomi.n='99',x=>x.lines=x.lines.filter(l=>l.id!==1),x=>x.archives[0].lines[0].result.resignedBy='W']){const corrupt=structuredClone(r);mutate(corrupt);assert.throws(()=>E.importGame(JSON.stringify(corrupt)));}
});

test('legacy settled saves get base frozen komi and preserve original no-pruning semantics',()=>{
  const g=E.createGame();E.play(g,1,0,null);E.play(g,1,1,null);settle(g,1);
  for(const key of ['pruningMode','compensationC','komiCompensation','archives','branchLimitExponent'])delete g[key];delete g.lines[0].frozenKomi;delete g.lines[0].settledAtArchiveCount;
  const loaded=E.importGame(E.exportGame(g));assert.equal(loaded.pruningMode,'none');assert.equal(loaded.branchLimitExponent,null);assert.equal(E.effectiveKomi(loaded,1),7.5);assert.deepEqual(loaded.lines[0].frozenKomi,E.fraction(15,2));assert.throws(()=>E.prune(loaded,1,1,'B'),/disabled/);roundtrip(loaded);
});
