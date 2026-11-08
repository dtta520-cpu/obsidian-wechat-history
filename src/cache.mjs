import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { candidatesFromBytes, ProbeError } from './core.mjs';

const SKIP = /^(?:Network|Cookies|Login Data|Local Storage|Session Storage|Sessions|IndexedDB|File System|db_storage|Msg|Message|FileStorage|Attachment|Video|Image|login|log|net|net_1|crashpad|GPUCache|Code Cache|Dawn.*Cache)$/i;

export function cacheBases({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') {
    // WeChat 4.x uses Chromium Simple Cache below its own app_data directory.
    // Do not search the container root, chat storage, or other applications.
    const radium = path.join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'app_data', 'radium');
    return [path.join(radium, 'web'), path.join(radium, 'cache')];
  }
  if (platform !== 'win32') return [];
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(roaming, 'Tencent', 'xwechat', 'radium', 'web'),
    path.join(roaming, 'Tencent', 'xwechat', 'radium', 'cache'),
    path.join(roaming, 'Tencent', 'WeChat', 'XPlugin', 'Plugins', 'Radium'),
    path.join(roaming, 'Tencent', 'WeChat', 'XPlugin', 'Plugins', 'XWeb'),
    path.join(roaming, 'Tencent', 'WeChat', 'Cache'),
  ];
}

export async function discoverCaches(env = process.env, { platform = process.platform, home = os.homedir(), io = fs } = {}) {
  const roots = []; let directoriesVisited = 0; let accessDenied = false;
  async function walk(directory, depth) {
    if (depth > 8 || directoriesVisited++ > 4000) return;
    let entries;
    try { entries = await io.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) accessDenied = true; return; }
    if (/^(?:cache|cache_data|cachestorage)$/i.test(path.basename(directory))) { roots.push(directory); return; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.test(entry.name)) await walk(path.join(directory, entry.name), depth + 1);
    }
  }
  for (const base of cacheBases({ platform, home, env })) await walk(base, 0);
  if (!roots.length && accessDenied) throw new ProbeError('CACHE_ACCESS_DENIED', '系统未允许读取微信网页缓存。');
  return [...new Set(roots)];
}

// Only read the URL key, never the response body or a Cookie database.
// Layout: chromium/src/net/disk_cache/simple/simple_entry_format.h.
async function readSimpleKey(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const header = Buffer.alloc(24);
    const first = await handle.read(header, 0, header.length, 0);
    if (first.bytesRead !== 24 || header.readBigUInt64LE(0) !== 0xfcfb6d1ba7725c30n || header.readUInt32LE(8) !== 5) return { key: null, bytesRead: first.bytesRead };
    const length = header.readUInt32LE(12);
    if (!length || length > 65536) return { key: null, bytesRead: first.bytesRead };
    const key = Buffer.alloc(length);
    const result = await handle.read(key, 0, length, 24);
    return { key: result.bytesRead === length ? key : null, bytesRead: first.bytesRead + result.bytesRead };
  } finally { await handle?.close(); }
}

export async function scanCaches({ biz, roots, simpleKeysOnly = false, sinceMinutes = 120, maxBytes = 512 * 1024 * 1024, maxFiles = 10000, maxMs = 45000, seenFiles = new Set() }) {
  const started = Date.now(); const deadline = started + maxMs;
  const stats = { cacheRoots: roots.length, filesFound: 0, filesRead: 0, bytesRead: 0, candidatesFound: 0, unreadableFiles: 0, unreadableDirectories: 0, unsupportedEntries: 0, limitReasons: [] };
  const recent = []; const candidates = new Map(); const cutoff = started - sinceMinutes * 60000;
  let dirs = 0;
  async function enumerate(directory) {
    if (Date.now() > deadline || dirs++ > 4000) { stats.limitReasons.push('enumeration_budget'); return; }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { stats.unreadableDirectories++; return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SKIP.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await enumerate(file); continue; }
      if (!entry.isFile()) continue;
      if (simpleKeysOnly && !/^[0-9a-f]{16}_0$/i.test(entry.name)) continue;
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      if (!stat.size || stat.mtimeMs < cutoff) continue;
      if (!simpleKeysOnly && stat.size > 64 * 1024 * 1024) { stats.limitReasons.push('oversized_cache_file'); continue; }
      const version = `${file}:${stat.size}:${stat.mtimeMs}`;
      if (!seenFiles.has(version)) recent.push({ file, size: stat.size, mtime: stat.mtimeMs, version });
    }
  }
  for (const root of roots) await enumerate(root);
  recent.sort((a, b) => b.mtime - a.mtime);
  stats.filesFound = recent.length;
  for (const file of recent) {
    if (Date.now() > deadline) { stats.limitReasons.push('scan_time'); break; }
    if (stats.filesRead >= maxFiles) { stats.limitReasons.push('file_count'); break; }
    if (stats.bytesRead + (simpleKeysOnly ? Math.min(file.size, 65560) : file.size) > maxBytes) { stats.limitReasons.push('byte_count'); break; }
    let overlap = Buffer.alloc(0); let readOk = false;
    try {
      if (simpleKeysOnly) {
        const { key, bytesRead } = await readSimpleKey(file.file);
        stats.bytesRead += bytesRead;
        if (key) {
          for (const candidate of candidatesFromBytes(key, biz)) candidates.set(candidate.identity, { ...candidate, modifiedAt: file.mtime });
          readOk = true;
        } else stats.unsupportedEntries++;
      } else {
        for await (const chunk of createReadStream(file.file, { highWaterMark: 1024 * 1024 })) {
          stats.bytesRead += chunk.length;
          const bytes = Buffer.concat([overlap, chunk]);
          for (const candidate of candidatesFromBytes(bytes, biz)) {
            candidates.set(candidate.identity, { ...candidate, modifiedAt: file.mtime });
          }
          overlap = bytes.subarray(Math.max(0, bytes.length - 32768));
          if (Date.now() > deadline) { stats.limitReasons.push('scan_time'); break; }
        }
        readOk = Date.now() <= deadline;
      }
    } catch { stats.unreadableFiles++; }
    stats.filesRead++;
    if (readOk) seenFiles.add(file.version);
  }
  stats.candidatesFound = candidates.size;
  stats.limitReasons = [...new Set(stats.limitReasons)];
  stats.durationMs = Date.now() - started;
  return { candidates: [...candidates.values()].sort((a, b) => b.modifiedAt - a.modifiedAt), stats };
}
