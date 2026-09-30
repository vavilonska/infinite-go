import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationPlan } from './manifest.js';
import { allowedDownloadURL, sha256, verifyAsset } from './download.js';
import { readZip } from './zip.js';
import { LocalAIInstaller } from './installer.js';
import { zipFixture } from './fixtures.js';

test('fixed CPU plans are explicit; macOS and ARM never fall through to downloads', () => {
  const windows = installationPlan('win32', 'x64'), linux = installationPlan('linux', 'x64');
  assert.equal(windows.downloadBytes, 10870792); assert.equal(linux.downloadBytes, 46748248);
  assert.match(windows.engine.url, /lightvector\/KataGo/); assert.match(windows.backend, /no AVX2/);
  for (const target of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['android', 'arm64']]) assert.equal(installationPlan(...target).supported, false);
});
test('asset integrity rejects truncation and same-size tampering', () => {
  const data = Buffer.from('fixture'), asset = { name: 'fixture', bytes: data.length, sha256: sha256(data) };
  assert.equal(verifyAsset(data, asset), data);
  assert.throws(() => verifyAsset(Buffer.from('fixturE'), asset), /SHA256/);
  assert.throws(() => verifyAsset(Buffer.from('fixture!'), asset), /size/);
});
test('HTTPS redirects are restricted to official asset hosts', () => {
  const original = installationPlan('win32', 'x64').engine.url;
  assert(allowedDownloadURL(original, original)); assert(allowedDownloadURL('https://release-assets.githubusercontent.com/path?token=test', original));
  for (const bad of ['http://release-assets.githubusercontent.com/path', 'https://github.com/other/repo', 'https://github.com.evil.test/a', 'http://127.0.0.1:8000', 'https://user@release-assets.githubusercontent.com/path', 'https://release-assets.githubusercontent.com:444/path']) assert(!allowedDownloadURL(bad, original));
  assert(!allowedDownloadURL('https://release-assets.githubusercontent.com/path', 'https://media.katagotraining.org/a'));
});
test('ZIP extracts stored and deflated files in memory', () => {
  const zip = zipFixture([{ name: 'katago.exe', data: 'fixture', method: 8 }, { name: 'folder/' }, { name: 'folder/config.txt', data: 'config' }]);
  const files = readZip(zip); assert.equal(files.length, 3); assert.equal(files[0].data.toString(), 'fixture');
});
test('ZIP rejects traversal, links, Windows ambiguity, duplication and expansion limits', () => {
  for (const name of ['../escape', '/abs', 'a\\b', 'C:evil', 'a//b', './foo', 'a/../b', 'NUL', 'file.']) assert.throws(() => readZip(zipFixture([{ name, data: 'a' }])), /Unsafe/);
  assert.throws(() => readZip(zipFixture([{ name: 'a', mode: 0o120777, data: 'outside' }])), /links/);
  assert.throws(() => readZip(zipFixture([{ name: 'a', data: 'a' }, { name: 'A', data: 'b' }])), /Unsafe/);
  assert.throws(() => readZip(zipFixture([{ name: 'a', data: '123456789', method: 8 }]), { maxBytes: 8 }), /contents/);
  assert.throws(() => readZip(zipFixture([{ name: 'a', data: 'a', method: 99 }])), /contents/);
});
async function fakeInstaller(t, downloadOverride) {
  const root = await mkdtemp(join(tmpdir(), 'infinite-go-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const archive = zipFixture([{ name: 'katago.exe', data: 'fake non-executable binary' }, { name: 'README.txt', data: 'Fixture only' }]), model = Buffer.from('small fake model');
  const asset = (name, bytes) => ({ name, bytes: bytes.length, sha256: sha256(bytes), url: 'https://example.test/fixture' });
  let calls = 0;
  const installer = new LocalAIInstaller({ dataDir: root, platform: 'win32', arch: 'x64', download: downloadOverride || (async (item, { onProgress }) => { calls++; const data = item.name === 'engine.zip' ? archive : model; onProgress(data.length); return data; }) });
  installer.plan = { ...installer.plan, engine: asset('engine.zip', archive), model: asset('model.txt.gz', model), downloadBytes: archive.length + model.length };
  return { installer, root, calls: () => calls };
}
test('fake installation requires consent, verifies payloads, installs atomically, and reuses offline', async t => {
  const { installer, calls } = await fakeInstaller(t);
  await assert.rejects(installer.install({ manifestId: installer.plan.manifestId, consent: false }), /approve/); assert.equal(calls(), 0);
  await installer.install({ manifestId: installer.plan.manifestId, consent: true });
  const result = await installer.ready({ verify: true }); assert.match(result.bin, /katago.exe$/); assert.equal(calls(), 2);
  assert.match(await readFile(result.config, 'utf8'), /maxVisits = 32/);
  await installer.install({ manifestId: installer.plan.manifestId, consent: true }); assert.equal(calls(), 2);
  await writeFile(result.bin, 'tampered'); await assert.rejects(installer.ready({ verify: true }), /changed/);
});
test('bad download cleans staging and never produces an enabled installation', async t => {
  const { installer, root } = await fakeInstaller(t, async () => Buffer.from('wrong'));
  await assert.rejects(installer.install({ manifestId: installer.plan.manifestId, consent: true }), /mismatch/);
  assert.equal(await installer.ready(), null); assert.deepEqual(await readdir(root), []);
});
test('cancellation cleans staging and leaves retry possible', async t => {
  const controller = new AbortController();
  const { installer, root } = await fakeInstaller(t, async () => { controller.abort(); throw new Error('Aborted'); });
  await assert.rejects(installer.install({ manifestId: installer.plan.manifestId, consent: true, signal: controller.signal }), /Aborted/);
  assert.deepEqual(await readdir(root), []);
});

test('AppImage abort waits for child close before allowing staging cleanup', async () => {
  const { EventEmitter } = await import('node:events');
  const { extractAppImage } = await import('./installer.js');
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
  let settled = false;
  const outcome = extractAppImage('/fake/verified-image', '/fake/stage', { spawnProcess: () => child }).then(() => { settled = true; }, () => { settled = true; });
  child.emit('error', new Error('AbortError'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  child.emit('close', null, 'SIGTERM'); await outcome; assert.equal(settled, true);
});
