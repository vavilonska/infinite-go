import test from 'node:test';import assert from 'node:assert/strict';import * as E from '../engine.js';
const settle=(g,id)=>{E.approveScore(g,id,'B');E.approveScore(g,id,'W');};
function branches(mode='none'){
 const g=E.createGame(9,7.5,9,{resultMode:'weighted-margin',pruningMode:mode,resignationMargin:20});E.play(g,1,0,0);E.play(g,1,1,1);E.play(g,1,0,2);return g;
}
test('margin is exact white-positive including komi; legacy saves retain win-weight mode',()=>{
 const g=E.createGame(9,7.5,9,{resultMode:'weighted-margin'});E.play(g,1,0,null);E.play(g,1,1,null);settle(g,1);assert.deepEqual(E.resultSummary(g).whiteMargin,E.fraction(15,2));assert.equal(E.resultSummary(g).winner,'W');assert.equal(E.importGame(E.exportGame(g)).resultMode,'weighted-margin');
 const old=E.createGame();old.version=2;delete old.resultMode;delete old.resignationMargin;const restored=E.importGame(JSON.stringify(old));assert.equal(restored.resultMode,'weighted-wins');assert.equal(restored.version,3);
 for(const x of [0,-1,.3,Infinity,null,1000.5])assert.throws(()=>E.createGame(9,7.5,9,{resultMode:'weighted-margin',resignationMargin:x}));
});
test('resignation uses configured signed margin once per leaf, never archive duplicates',()=>{
 const g=branches('resign');const id=g.lines.find(l=>E.canActOn(g,l.id)).id,actor=E.replay(E.lineById(g,id).history,9).toPlay,w=E.lineById(g,id).weight;E.prune(g,id,1,actor);
 const expected=E.multiply(w,E.rational(actor==='B'?20:-20));assert.deepEqual(E.resultSummary(g).whiteMargin,expected);assert.equal(E.resultSummary(g).winner,null);assert.deepEqual(E.importGame(E.exportGame(g)),g);
 const bad=structuredClone(g);bad.lines.find(l=>l.archived).result.whiteMargin=E.rational(999);assert.throws(()=>E.importGame(JSON.stringify(bad)),/margin/);
});
test('komi pruning compensation counted only through effective frozen komi',()=>{
 const g=branches('komi');const id=g.lines.find(l=>E.canActOn(g,l.id)).id,actor=E.replay(E.lineById(g,id).history,9).toPlay;E.prune(g,id,1,actor);
 let guard=0;while(g.lines.some(l=>l.status==='playing')&&guard++<10){const id=g.queue[0],l=E.lineById(g,id);E.play(g,id,l.history.length,null);}for(const l of g.lines)settle(g,l.id);
 const expected=g.lines.reduce((q,l)=>E.add(q,E.multiply(l.weight,E.score(g,l.id).whiteMargin)),E.rational());assert.deepEqual(E.resultSummary(g).whiteMargin,expected);assert.equal(E.resultSummary(g).complete,true);assert.deepEqual(E.importGame(E.exportGame(g)),g);
});
test('opposite actual scores combine with exact non-dyadic weights and can still draw',()=>{
 const g=E.createGame(9,7.5,9,{resultMode:'weighted-margin'});
 const histories=[[{type:'play',color:'B',at:0},{type:'pass',color:'W'},{type:'pass',color:'B'}],[{type:'pass',color:'B'},{type:'play',color:'W',at:1},{type:'pass',color:'B'},{type:'pass',color:'W'}]];
 g.lines=histories.map((history,i)=>({id:i+1,parent:i?1:null,forkAt:i?0:null,weight:E.fraction(i?2:1,3),history,status:'scoring',dead:[],approvals:[]}));g.nextId=3;E.ensureRound(g);settle(g,1);assert.equal(E.resultSummary(g).winner,null);settle(g,2);assert.deepEqual(E.resultSummary(g).whiteMargin,E.fraction(69,2));assert.equal(E.resultSummary(g).winner,'W');assert.deepEqual(E.importGame(E.exportGame(g)),g);
});
