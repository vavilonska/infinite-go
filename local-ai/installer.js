import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, readlink, realpath, rm, rename, chmod, statfs } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installationPlan, TARGETS } from './manifest.js';
import { downloadAsset, sha256 } from './download.js';
import { extractZip } from './zip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG = `# Infinite Go local CPU baseline. No remote services or training uploads.\nnumAnalysisThreads = 1\nnumSearchThreadsPerAnalysisThread = 1\nnumEigenThreadsPerModel = 2\nmaxVisits = 32\nnnMaxBatchSize = 2\nnnCacheSizePowerOfTwo = 16\nnnMutexPoolSizePowerOfTwo = 12\nreportAnalysisWinratesAs = BLACK\nignorePreRootHistory = false\nlogToStderr = true\n`;
const inside = (root, path) => { const p = relative(root, path); return p === '' || (!p.startsWith('..') && !isAbsolute(p)); };
export async function inventory(root, at = root) {
  const records = [];
  for (const entry of await readdir(at, { withFileTypes: true })) {
    if (at === root && entry.name === 'receipt.json') continue;
    const path = join(at, entry.name), name = relative(root, path).split('\\').join('/');
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      const target = await readlink(path);
      if (!inside(root, resolve(dirname(path), target)) || !inside(root, await realpath(path))) throw new Error('Installed symbolic link leaves its private folder');
      records.push({ name, link: target });
    } else if (stats.isDirectory()) records.push(...await inventory(root, path));
    else if (stats.isFile()) records.push({ name, bytes: stats.size, sha256: sha256(await readFile(path)) });
    else throw new Error('Unsupported installed file type');
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}
export function extractAppImage(bin, cwd, { signal, spawnProcess = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    // Only called after the containing fixed official archive passes SHA256.
    // Extracts its own payload; does not start analysis, install FUSE or change the OS.
    const child = spawnProcess(bin, ['--appimage-extract'], { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, signal });
    let errorText = '', spawnError = null, killTimer = null;
    const hardStop = () => { if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); hardStop(); }, 90000);
    signal?.addEventListener('abort', hardStop, { once: true });
    child.stderr.on('data', data => { if (errorText.length < 2000) errorText += data.toString().slice(0, 2000 - errorText.length); });
    // Wait for close even after abort/error, so cleanup cannot race a still-writing child.
    child.on('error', error => { spawnError = error; hardStop(); });
    child.on('close', (code, terminated) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', hardStop);
      if (spawnError) { reject(spawnError); return; }
      code === 0 ? resolvePromise() : reject(new Error(`Verified AppImage extraction failed (${terminated || code}). Check Linux compatibility. ${errorText.trim()}`));
    });
  });
}
export class LocalAIInstaller {
  constructor({ dataDir, platform = process.platform, arch = process.arch, download = downloadAsset, unpackAppImage = extractAppImage } = {}) {
    if (!dataDir || !isAbsolute(dataDir)) throw new Error('Local AI needs an absolute private data directory');
    this.dataDir = dataDir; this.plan = installationPlan(platform, arch);
    this.destination = this.plan.supported ? join(dataDir, this.plan.manifestId) : null;
    this.download = download; this.unpackAppImage = unpackAppImage;
  }
  async ready({ verify = false } = {}) {
    if (!this.destination) return null;
    let receipt;
    try { receipt = JSON.parse(await readFile(join(this.destination, 'receipt.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Local AI receipt is damaged; move this installation folder aside before retrying'); }
    if (receipt.manifestId !== this.plan.manifestId || receipt.modelSHA256 !== this.plan.model.sha256 || receipt.engineSHA256 !== this.plan.engine.sha256) throw new Error('Local AI manifest mismatch; move this installation folder aside before retrying');
    if (verify && JSON.stringify(await inventory(this.destination)) !== JSON.stringify(receipt.files)) throw new Error('Local AI files changed or are incomplete; move this installation folder aside and reinstall');
    const bin = join(this.destination, TARGETS[this.plan.target].bin), model = join(this.destination, this.plan.model.name), config = join(this.destination, 'analysis.cfg');
    // Always check basic files, even on the inexpensive status path.
    for (const path of [bin, model, config]) if (!(await lstat(path)).isFile()) throw new Error('Local AI installation is incomplete');
    return { bin, model, config };
  }
  async install({ manifestId, consent, signal, onProgress = () => {} } = {}) {
    if (!this.plan.supported) throw new Error(this.plan.reason);
    if (consent !== true || manifestId !== this.plan.manifestId) throw new Error('Review and approve the current download plan before installing');
    if (await this.ready({ verify: true })) return;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.dataDir)).isDirectory()) throw new Error('Local AI data directory must be a regular directory');
    const free = await statfs(this.dataDir).catch(() => null);
    if (free && free.bavail * free.bsize < this.plan.recommendedFreeBytes) throw new Error('Local AI setup needs at least 300 MiB of free disk space');
    const stage = await mkdtemp(join(this.dataDir, '.install-'));
    try {
      let downloaded = 0;
      const progress = (phase, complete = downloaded) => onProgress({ phase, downloadedBytes: complete, totalBytes: this.plan.downloadBytes });
      const get = async (asset, phase) => {
        progress(phase);
        const data = await this.download(asset, { signal, onProgress: bytes => progress(phase, downloaded + bytes) });
        // Defense in depth for injected transports too: download output must match the catalog.
        const { verifyAsset } = await import('./download.js'); verifyAsset(data, asset);
        downloaded += data.length; return data;
      };
      const archive = await get(this.plan.engine, 'Downloading official CPU engine');
      const model = await get(this.plan.model, 'Downloading small model');
      signal?.throwIfAborted(); progress('Verifying and extracting');
      const engineDir = join(stage, 'engine'); await mkdir(engineDir);
      await extractZip(archive, engineDir);
      if (this.plan.target === 'linux-x64') {
        const imagePath = join(engineDir, 'katago');
        await chmod(imagePath, 0o700);
        await this.unpackAppImage(imagePath, engineDir, { signal });
      }
      signal?.throwIfAborted();
      await writeFile(join(stage, this.plan.model.name), model, { flag: 'wx', mode: 0o600 });
      await writeFile(join(stage, 'analysis.cfg'), CONFIG, { flag: 'wx', mode: 0o600 });
      await writeFile(join(stage, 'THIRD-PARTY-LICENSES.txt'), await readFile(join(HERE, 'THIRD-PARTY-LICENSES.txt')), { flag: 'wx', mode: 0o600 });
      const bin = join(stage, TARGETS[this.plan.target].bin);
      if (!(await lstat(bin)).isFile()) throw new Error('The official archive layout changed; install was stopped');
      if (this.plan.target === 'linux-x64') await chmod(bin, 0o700);
      const files = await inventory(stage);
      await writeFile(join(stage, 'receipt.json'), JSON.stringify({ manifestId: this.plan.manifestId, engineSHA256: this.plan.engine.sha256, modelSHA256: this.plan.model.sha256, installedAt: new Date().toISOString(), files }, null, 2), { flag: 'wx', mode: 0o600 });
      signal?.throwIfAborted();
      // Never replace a previous or user-created directory. Successful install is atomic.
      try { await lstat(this.destination); throw new Error('An installation already exists; move it aside before reinstalling'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(stage, this.destination);
      progress('Installed; ready to start', this.plan.downloadBytes);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
