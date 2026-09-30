import test from 'node:test';import assert from 'node:assert/strict';
import {boardAnnotations,branchDescription,moveCoordinate} from '../annotations.js';
const moves=ats=>ats.map((at,i)=>at==null?{type:'pass',color:i%2?'W':'B'}:{type:'play',color:i%2?'W':'B',at});
test('surviving numbers track captures, reoccupation, passes and historical previews',()=>{
 const line={parent:1,forkAt:1,history:moves([1,0,9,null,0])};
 assert.equal(boardAnnotations(line,2,9).numbers[0],2);assert.equal(boardAnnotations(line,2,9).branchAt,0);
 const captured=boardAnnotations(line,3,9);assert.equal(captured.numbers[0],null);assert.equal(captured.branchAt,null);assert.equal(captured.branchMove,2);
 const latest=boardAnnotations(line,5,9);assert.equal(latest.numbers[0],5);assert.equal(latest.branchAt,null);assert.equal(latest.numbers[1],1);assert.equal(latest.numbers[9],3);
});
test('resume is not numbered, branch description includes inherited passes and original coordinates',()=>{
 const history=[...moves([null,null]),{type:'resume'},{type:'play',color:'B',at:8}];
 const root={id:1,parent:null,forkAt:null,history},child={id:2,parent:1,forkAt:3,history:[...history.slice(0,3),{type:'play',color:'B',at:9}]};
 assert.equal(boardAnnotations(child,4,19).numbers[9],3);assert.equal(boardAnnotations(child,3,19).branchAt,null);
 assert.equal(branchDescription({size:19,lines:[root,child]},root),'');
 assert.match(branchDescription({size:19,lines:[root,child]},child),/第 3 手分叉：黑K19（原着 J19）/);
 const grandchild={id:3,parent:2,forkAt:3,history:[...history.slice(0,3),{type:'play',color:'B',at:10}]};
 assert.match(branchDescription({size:19,lines:[root,grandchild],archives:[{lines:[child]}]},grandchild),/黑L19（原着 K19）· 来源 #2/);
 assert.equal(moveCoordinate({type:'pass'},19),'停一手');
});
