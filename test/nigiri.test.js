import test from 'node:test';import assert from 'node:assert/strict';
import {randomStoneCount,revealNigiri,chooseNigiri,publicNigiri} from '../nigiri.js';
test('rejection sampling produces uniform 1..20 counts over accepted bytes',()=>{
 const counts=Array(20).fill(0);for(let b=0;b<240;b++)counts[randomStoneCount(a=>a[0]=b)-1]++;assert.deepEqual(counts,Array(20).fill(12));
 const bytes=[255,240,239];assert.equal(randomStoneCount(a=>a[0]=bytes.shift()),20);assert.equal(bytes.length,0);
});
test('parity winner chooses either color; hidden count and repeated actions are protected',()=>{
 const hidden={phase:'guess',count:7};assert.deepEqual(publicNigiri(hidden),{phase:'guess'});
 const win=revealNigiri(hidden,'odd');assert.equal(win.winner,'B');assert.equal(publicNigiri(win).count,7);
 assert.throws(()=>revealNigiri(win,'even'));assert.throws(()=>chooseNigiri(win,'A','W'));
 assert.deepEqual(chooseNigiri(win,'B','W').roles,{B:'W',A:'B'});
 assert.equal(revealNigiri(hidden,'even').winner,'A');assert.equal(revealNigiri({phase:'guess',count:8},'even').winner,'B');
 assert.throws(()=>chooseNigiri(chooseNigiri(win,'B','B'),'B','W'));
});
