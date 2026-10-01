import {test} from 'node:test';import assert from 'node:assert/strict';
import {AnalysisQueue,analysisCapabilities} from '../ai-analysis.js';import {createGame} from '../engine.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('HTTP analysis worker hashes history, strips human move advice and reports real visits',async()=>{
 const requests=[];const provider={cancelAll(){},async analyze(r){requests.push(r);return {blackWinrate:.6,visits:64,move:{type:'play',at:3},pv:[3,4]};}};
 const q=new AnalysisQueue({endpoint:'https://example.test',WorkerImpl:null,fallbackProvider:()=>provider});q.setState(createGame(),1);const out=await q.request(1);assert.match(out.nodeId,/^[a-f0-9]{64}$/);assert.equal(out.visits,64);assert.equal(out.blackWinrate,.6);assert.equal(out.move,undefined);assert.equal(out.pv,undefined);assert.equal(requests[0].history.length,0);q.close();
});
test('state changes cancel pending jobs and late results cannot overwrite new analysis',async()=>{
 let finish;const p={cancelAll(){},analyze:()=>new Promise(resolve=>{finish=resolve;})};const q=new AnalysisQueue({endpoint:'https://example.test',WorkerImpl:null,fallbackProvider:()=>p});q.setState(createGame(),1);const job=q.request(1);const rejected=assert.rejects(job,{name:'AbortError'});while(!finish)await tick();q.setState(createGame(13),2);finish({blackWinrate:.8});await rejected;await tick();assert.equal(q.pending.size,0);q.close();
});
test('move jobs can return moves only when explicitly requested',async()=>{
 const p={cancelAll(){},async generateMove(){return {blackWinrate:.5,move:{type:'pass'}};}};const q=new AnalysisQueue({endpoint:'https://example.test',WorkerImpl:null,fallbackProvider:()=>p});q.setState(createGame(),1);assert.equal((await q.request(1,'move')).move.type,'pass');q.close();
});
test('capability defaults are conservative and never invent model size or threads',()=>{
 assert.deepEqual(analysisCapabilities().maxConcurrent,1);assert.equal(analysisCapabilities().downloadBytes,null);assert.equal(analysisCapabilities().threads,null);assert.equal(analysisCapabilities({maxConcurrentAnalyses:99}).maxConcurrent,2);assert.equal(analysisCapabilities({threads:4,modelBytes:1048576}).threads,4);
});
