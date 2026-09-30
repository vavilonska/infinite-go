import { get } from 'node:https';
import { createHash } from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function verifyAsset(data, asset) {
  if (data.length !== asset.bytes) throw new Error(`Download size mismatch for ${asset.name}`);
  if (sha256(data) !== asset.sha256) throw new Error(`SHA256 mismatch for ${asset.name}; nothing was installed`);
  return data;
}
export function allowedDownloadURL(value, original) {
  let url; try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (url.href === original) return true;
  // These are GitHub's official release-asset redirect destinations, not arbitrary mirrors.
  return new URL(original).hostname === 'github.com' && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
}
/** Bounded HTTPS download, fixed catalog URL, exact size, SHA256 before extraction. */
export async function downloadAsset(asset, { signal, onProgress = () => {}, request = get } = {}) {
  if (!/^https:\/\//.test(asset.url) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid download manifest');
  const deadline = AbortSignal.timeout(10 * 60 * 1000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  async function fetchAt(url, redirects = 0) {
    if (!allowedDownloadURL(url, asset.url)) throw new Error('Download redirect is not an approved HTTPS asset host');
    combined.throwIfAborted();
    return new Promise((resolve, reject) => {
      const req = request(url, { headers: { 'User-Agent': 'Infinite-Go-Local-AI', 'Accept-Encoding': 'identity' }, signal: combined }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirects >= 5 || !res.headers.location) { reject(new Error('Too many download redirects')); return; }
          let next; try { next = new URL(res.headers.location, url).href; } catch { reject(new Error('Invalid download redirect')); return; }
          fetchAt(next, redirects + 1).then(resolve, reject); return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download returned HTTP ${res.statusCode}`)); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new Error('Unexpected download encoding')); return; }
        if (res.headers['content-length'] && Number(res.headers['content-length']) !== asset.bytes) { res.destroy(); reject(new Error(`Download size mismatch for ${asset.name}`)); return; }
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > asset.bytes) { res.destroy(new Error('Download exceeded the approved size')); return; }
          chunks.push(chunk); onProgress(bytes, asset.bytes);
        });
        res.on('error', reject);
        res.on('end', () => { try { resolve(verifyAsset(Buffer.concat(chunks), asset)); } catch (error) { reject(error); } });
      });
      req.setTimeout(30000, () => req.destroy(new Error('Download stalled; retry when your connection is ready')));
      req.on('error', reject);
    });
  }
  return fetchAt(asset.url);
}
