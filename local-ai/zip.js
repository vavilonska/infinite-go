import { inflateRawSync } from 'node:zlib';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// A deliberately small, dependency-free ZIP reader for the pinned upstream ZIPs.
// Reject ZIP64, encryption, symlinks, ambiguous paths, duplicates and zip bombs.
export function readZip(data, { maxBytes = 160 * 1024 * 1024, maxFiles = 1024 } = {}) {
  if (!Buffer.isBuffer(data) || data.length < 22) throw new Error('Invalid ZIP');
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP directory');
  const count = data.readUInt16LE(end + 10), centralBytes = data.readUInt32LE(end + 12), offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || count > maxFiles || count !== data.readUInt16LE(end + 8) || offset + centralBytes !== end) throw new Error('Unsupported ZIP size');
  const files = [], names = new Set(); let total = 0, at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLen = data.readUInt16LE(at + 28), extraLen = data.readUInt16LE(at + 30), commentLen = data.readUInt16LE(at + 32), external = data.readUInt32LE(at + 38), local = data.readUInt32LE(at + 42);
    if (at + 46 + nameLen + extraLen + commentLen > end) throw new Error('Invalid ZIP entry bounds');
    const name = data.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const components = name.replace(/\/$/, '').split('/');
    if (!name || name.length > 240 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || components.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)) || names.has(name.toLowerCase())) throw new Error('Unsafe ZIP path');
    names.add(name.toLowerCase());
    const type = (external >>> 16) & 0xf000;
    if (type && type !== 0x8000 && type !== 0x4000) throw new Error('ZIP links are not allowed');
    total += size;
    if ((flags & 1) || ![0, 8].includes(method) || total > maxBytes || size === 0xffffffff || compressed === 0xffffffff) throw new Error('Unsupported ZIP contents');
    if (local + 30 > offset || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 8) !== method || data.readUInt16LE(local + 6) !== flags) throw new Error('Invalid local ZIP header');
    const localNameLen = data.readUInt16LE(local + 26), start = local + 30 + localNameLen + data.readUInt16LE(local + 28);
    if (data.subarray(local + 30, local + 30 + localNameLen).toString('utf8') !== name || start + compressed > offset) throw new Error('Invalid local ZIP bounds');
    const packed = data.subarray(start, start + compressed);
    const contents = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    if (contents.length !== size || (name.endsWith('/') && size)) throw new Error('Invalid ZIP expanded size');
    files.push({ name, data: contents, directory: name.endsWith('/'), executable: !!((external >>> 16) & 0o111) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (at !== end) throw new Error('Invalid ZIP directory size');
  return files;
}
export async function extractZip(data, destination) {
  const files = readZip(data); // Validate every entry before writing any file.
  for (const file of files) {
    const path = join(destination, file.name);
    if (file.directory) { await mkdir(path, { recursive: true }); continue; }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.data, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
    if (file.executable) await chmod(path, 0o700);
  }
  return files;
}
