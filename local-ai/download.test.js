import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { downloadAsset, sha256 } from './download.js';
const data = Buffer.from('verified fixture download');
const asset = { name: 'fixture', url: 'https://github.com/lightvector/KataGo/releases/download/fixed/fixture.zip', bytes: data.length, sha256: sha256(data) };
function transport(replies, observed = []) {
  return (url, options, onResponse) => {
    observed.push(url); const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = error => req.emit('error', error);
    queueMicrotask(() => {
      if (options.signal.aborted) { req.emit('error', new Error('aborted')); return; }
      const next = replies.shift();
      if (!next) { req.emit('error', new Error('No fixture response')); return; }
      const res = Readable.from(next.chunks || [next.data || data]); res.statusCode = next.statusCode ?? 200; res.headers = next.headers || {};
      onResponse(res);
    });
    return req;
  };
}
test('bounded download validates a successful fake HTTPS stream and progress', async () => {
  const progress = []; const result = await downloadAsset(asset, { request: transport([{ chunks: [data.subarray(0, 6), data.subarray(6)] }]), onProgress: n => progress.push(n) });
  assert.deepEqual(result, data); assert.deepEqual(progress, [6, data.length]);
});
test('download follows official CDN redirect, but refuses arbitrary redirect before requesting it', async () => {
  const observed = []; assert.deepEqual(await downloadAsset(asset, { request: transport([{ statusCode: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }, {}], observed) }), data); assert.equal(observed.length, 2);
  const denied = []; await assert.rejects(downloadAsset(asset, { request: transport([{ statusCode: 302, headers: { location: 'https://evil.test/payload' } }], denied) }), /approved/); assert.equal(denied.length, 1);
});
test('download fails closed on size mismatch, excess data, digest mismatch and HTTP errors', async () => {
  for (const [response, error] of [[{ headers: { 'content-length': '1' } }, /size/], [{ data: Buffer.concat([data, data]) }, /exceeded/], [{ data: Buffer.alloc(data.length) }, /SHA256/], [{ data: data.subarray(1) }, /size/], [{ statusCode: 404 }, /HTTP 404/]]) await assert.rejects(downloadAsset(asset, { request: transport([response]) }), error);
});
test('already cancelled download makes no request', async () => {
  const controller = new AbortController(); controller.abort(); const observed = [];
  await assert.rejects(downloadAsset(asset, { signal: controller.signal, request: transport([], observed) })); assert.equal(observed.length, 0);
});
