import test from 'node:test';import assert from 'node:assert/strict';import * as E from '../engine.js';
function two(whiteSecond=false,mode='none'){
 const g=E.createGame(9,7.5,null,{pruningMode:mode,compensationC:'8'});
 const hist=points=>points.map((at,i)=>({type:'play',color:i%2?'W':'B',at}));
 g.lines=[{...g.lines[0],weight:E.fraction(1,2),history:hist([0,1])},{...structuredClone(g.lines[0]),id:2,parent:1,forkAt:0,weight:E.fraction(1,2),history:hist(whiteSecond?[2]:[2,3])}];g.nextId=3;
 g.turns={B:{epoch:1,pending:[1,2]},W:{epoch:1,pending:[1,2]}};E.ensureRound(g);return g;
}
test('each side freely selects a pending board; immediate reply cannot skip own other board',()=>{
 const g=two();assert.ok(E.canActOn(g,2,'B'));assert.ok(!E.canActOn(g,2,'W'));
 E.play(g,1,2,4);assert.ok(E.canActOn(g,1,'W'));E.play(g,1,3,5);
 const before=E.exportGame(g);assert.throws(()=>E.play(g,1,4,6),/current turn/);assert.equal(E.exportGame(g),before);assert.equal(E.turnInfo(g,1).waiting,true);
 E.play(g,2,2,7);assert.equal(g.turns.B.epoch,2);assert.ok(E.canActOn(g,1,'B'));assert.equal(g.turns.W.epoch,1);E.play(g,1,4,6);
 assert.equal(E.turnInfo(g,1).waiting,true);E.play(g,2,3,8);assert.equal(g.turns.W.epoch,2);assert.ok(E.canActOn(g,1,'W'));assert.deepEqual(E.importGame(E.exportGame(g)),g);
});
test('frozen pending sets include boards waiting for the other color',()=>{const g=two(true);E.play(g,1,2,4);assert.deepEqual(g.turns.B.pending,[2]);assert.equal(g.turns.B.epoch,1);E.play(g,1,3,5);assert.ok(!E.canActOn(g,1,'B'));assert.ok(E.canActOn(g,2,'W'));E.play(g,2,1,6);assert.ok(E.canActOn(g,2,'B'));});
test('new branch waits for each next epoch and defers only unused opponent source opportunity',()=>{
 const g=two();const id=E.play(g,1,0,4);assert.equal(id,3);assert.deepEqual(g.turns.B.pending,[2]);assert.deepEqual(g.turns.W.pending,[2]);assert.ok(!g.turns.B.pending.includes(3));assert.ok(!g.turns.W.pending.includes(3));assert.ok(!E.canActOn(g,1,'W'));assert.equal(E.turnInfo(g,1).waiting,true);
 E.play(g,2,2,5);assert.equal(g.turns.B.epoch,2);assert.ok(g.turns.B.pending.includes(3));assert.ok(!g.turns.W.pending.includes(3));E.play(g,2,3,6);assert.equal(g.turns.W.epoch,2);assert.ok(E.canActOn(g,3,'W'));
});
test('opposite-color double branching cannot permanently deadlock',()=>{const g=two(true);E.play(g,1,0,4);assert.deepEqual(g.turns.B.pending,[2]);assert.deepEqual(g.turns.W.pending,[2]);const newborn=E.play(g,2,1,5);assert.equal(newborn,2); // normal reply gives Black its pending board
 assert.ok(E.canActOn(g,2,'B'));
 const h=two(true);h.lines[1].history=[{type:'play',color:'B',at:2},{type:'play',color:'W',at:3},{type:'play',color:'B',at:6}];E.ensureRound(h);E.play(h,1,0,4);
 E.play(h,2,1,5);assert.ok(h.queue.length>0);assert.equal(h.turns.B.epoch,2);assert.equal(h.turns.W.epoch,2);assert.ok(E.canActOn(h,1,'B'));assert.ok(E.canActOn(h,2,'W'));assert.deepEqual(E.importGame(E.exportGame(h)),h);
});
test('scoring and pruning remove both pending sets; resume joins next epochs without spinning',()=>{
 const g=two(false,'komi');E.play(g,1,2,null);E.play(g,1,3,null);assert.ok(!g.turns.B.pending.includes(1));assert.ok(!g.turns.W.pending.includes(1));E.resume(g,1);assert.ok(!g.turns.B.pending.includes(1));assert.ok(!g.turns.W.pending.includes(1));E.play(g,2,2,4);assert.ok(g.turns.B.pending.includes(1));E.play(g,2,3,5);assert.ok(g.turns.W.pending.includes(1));
 const h=two(false,'resign');E.prune(h,2,1,'B');assert.ok(!h.turns.B.pending.includes(2));assert.ok(!h.turns.W.pending.includes(2));assert.ok(E.canActOn(h,1,'B'));
 const end=E.createGame();E.play(end,1,0,null);E.play(end,1,1,null);const epochs=structuredClone(end.turns);for(let i=0;i<10;i++)E.ensureRound(end);assert.deepEqual(end.turns,epochs);assert.deepEqual(end.queue,[]);
});
test('version 1 migrates to fresh independent snapshots; version 2 rejects invalid progress',()=>{const g=two();const old=structuredClone(g);old.version=1;delete old.turns;old.queue=[2];const migrated=E.importGame(JSON.stringify(old));assert.equal(migrated.version,2);assert.deepEqual(migrated.turns.B.pending,[1,2]);assert.deepEqual(migrated.lines,g.lines);
 for(const mutate of [x=>delete x.turns,x=>x.turns.B.pending=[1,1],x=>x.turns.W.pending=[99],x=>x.turns.B.epoch=0,x=>x.turns.B.pending=[],x=>x.queue=[1]]){const bad=structuredClone(g);mutate(bad);assert.throws(()=>E.importGame(JSON.stringify(bad)));}
});
test('bounded deterministic mixed play never leaves active boards with no legal turn owner',()=>{let seed=12345;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};const g=E.createGame(9,7.5,4,{pruningMode:'resign'});for(let step=0;step<160;step++){const active=g.lines.filter(l=>l.status==='playing');if(!active.length)break;assert.ok(g.queue.length,'active boards must have an eligible owner');const id=g.queue[rand()%g.queue.length],line=E.lineById(g,id),toPlay=E.replay(line.history,9).toPlay;let moved=false;if(step%9===0&&line.history.length>0){try{E.prune(g,id,Math.max(1,line.history.length-1),toPlay);moved=true;}catch{}}
 for(let attempt=0;attempt<15&&!moved;attempt++){const l=E.lineById(g,id);const branch=attempt<3&&l.history.length>1&&step%4===0;const index=branch?rand()%l.history.length:l.history.length;try{E.play(g,id,index,attempt===14?null:rand()%81);moved=true;}catch{}}
 assert.ok(moved);assert.deepEqual(E.importGame(E.exportGame(g)),g);}
});
test('import rejects a fabricated independent-turn deadlock',()=>{const g=two(true);g.turns.B.pending=[2];g.turns.W.pending=[1];g.queue=[];assert.throws(()=>E.importGame(E.exportGame(g)),/eligible/);});
