import {test} from 'node:test';import assert from 'node:assert/strict';import {BrowserGoProvider,BROWSER_MODELS} from '../browser-provider.js';import {browserSettings} from '../browser-ai/settings.js';
class FakeWorker{constructor(){this.messages=[];}postMessage(m){this.messages.push(m);}terminate(){this.terminated=true;}}
test('browser settings whitelist/ranges exclude game rules and silent invalid values',()=>{
 assert.equal(browserSettings().maxTimeMs,3000);for(const opts of [{visits:NaN},{visits:17},{maxTimeMs:0},{batchSize:9},{threads:3},{backend:'gpu'},{komi:0},{boardSize:19},{backend:'webgpu',threads:2}])assert.throws(()=>browserSettings(opts));assert.equal(browserSettings({batchSize:4}).batchSize,4);
});
test('browser provider echoes identity, cancels old jobs and preserves actual progress',async()=>{
 const p=new BrowserGoProvider({WorkerImpl:FakeWorker});p.receive({type:'ready',generation:1,backend:'wasm',modelName:'test',threads:1,maxVisits:32,modelBytes:3827339});await p.capabilities();const request={requestId:'r',nodeId:'hash'};const job=p.analyze(request);await Promise.resolve();const message=p.worker.messages.at(-1);assert.equal(message.kind,'analysis');p.receive({type:'result',id:message.id,value:{...request,blackWinrate:.5}});assert.equal((await job).blackWinrate,.5);
 const old=p.generateMove(request);const rejected=assert.rejects(old,{name:'AbortError'});p.cancelAll();await rejected;p.close();assert.equal(p.worker.terminated,true);
});
test('model manifest has fixed bounded sizes and hashes; large models require explicit file',()=>{assert.equal(BROWSER_MODELS.length,3);for(const m of BROWSER_MODELS){assert.match(m.sha256,/^[0-9a-f]{64}$/);assert.ok(m.bytes>0&&m.bytes<100_000_000);}assert.equal(BROWSER_MODELS.find(m=>m.id==='b18').requiresFile,true);});
