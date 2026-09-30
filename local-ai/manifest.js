// Fixed, reviewed download catalog. Never accept asset URLs/hashes from an HTTP client.
// Engine SHA256 and sizes: official GitHub v1.18.1 release asset metadata, 2026-09-30.
export const RELEASE = '1.18.1';
export const MODEL = Object.freeze({
  name: 'kata1-b6c96-s175395328-d26788732.txt.gz',
  url: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b6c96-s175395328-d26788732.txt.gz',
  bytes: 4967720,
  sha256: '48d6754de3c4754f95bf6a5ca40957a49e5e915aaaeede133a17b9ccf8fa5fcb',
  verification: 'SHA256 pinned by Infinite Go from the official HTTPS download; no separately published upstream model checksum was found.',
});
const engine = (platform, bytes, sha256) => Object.freeze({
  name: `katago-v${RELEASE}-eigen-${platform}-x64.zip`,
  url: `https://github.com/lightvector/KataGo/releases/download/v${RELEASE}/katago-v${RELEASE}-eigen-${platform}-x64.zip`,
  bytes, sha256, verification: 'SHA256 published in the official GitHub release asset metadata.',
});
export const TARGETS = Object.freeze({
  'win32-x64': Object.freeze({ label: 'Windows x64 · CPU', engine: engine('windows', 5903072, '074485cf150c38aa3bb14ac9f54f2952ffefbceb44673709bbb8a83650bf95d6'), bin: 'engine/katago.exe' }),
  'linux-x64': Object.freeze({ label: 'Linux x64 · CPU', engine: engine('linux', 41780528, '993b642601e806037003d11e43775e7b4fc65281aed9b9469b7122f18fc16811'), bin: 'engine/squashfs-root/AppRun' }),
});
export function installationPlan(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`, entry = TARGETS[target];
  if (!entry) return {
    supported: false, target,
    reason: platform === 'darwin' ? 'Upstream does not publish a portable macOS binary. Set up KataGo separately using the upstream macOS instructions, then connect its bridge.' : 'Automatic local AI setup supports Windows x64 and Linux x64 only. Use a separately installed engine and bridge on this platform.',
    helpUrl: 'https://github.com/lightvector/KataGo#macos',
  };
  return {
    supported: true, target, manifestId: `katago-${RELEASE}-eigen-${target}-b6c96-v1`,
    label: entry.label, version: RELEASE, backend: 'Eigen CPU (no AVX2 requirement)',
    engine: entry.engine, model: MODEL,
    downloadBytes: entry.engine.bytes + MODEL.bytes, recommendedFreeBytes: 300 * 1024 * 1024,
    engineLicenseUrl: `https://github.com/lightvector/KataGo/blob/v${RELEASE}/LICENSE`,
    modelLicenseUrl: 'https://katagotraining.org/network_license/',
    note: 'Optional download. Installs only inside this portable app’s local AI data folder, without administrator rights, GPU drivers, a package manager, or a background service. CPU analysis is slower than GPU analysis. A small older model favors size and speed over playing strength. Download once; start again offline.',
    ...(platform === 'linux' ? { requirements: 'Linux x64 with glibc compatible with Ubuntu 22.04+, bash and readlink. The verified upstream AppImage is extracted locally to avoid requiring FUSE.' } : { requirements: 'Windows x64. Operating-system security warnings must be respected.' }),
  };
}
