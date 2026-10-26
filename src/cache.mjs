import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { candidatesFromBytes } from './core.mjs';

const SKIP = /^(?:Network|Cookies|Login Data|Local Storage|Session Storage|Sessions|IndexedDB|File System|db_storage|Msg|Message|FileStorage|Attachment|Video|Image|login|log|net|net_1|crashpad|GPUCache|Code Cache|Dawn.*Cache)$/i;

export async function discoverCaches(env = process.env) {
  const roaming = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const bases = [
    path.join(roaming, 'Tencent', 'xwechat', 'radium', 'web'),
    path.join(roaming, 'Tencent', 'xwechat', 'radium', 'cache'),
    path.join(roaming, 'Tencent', 'WeChat', 'XPlugin', 'Plugins', 'Radium'),
    path.join(roaming, 'Tencent', 'WeChat', 'XPlugin', 'Plugins', 'XWeb'),
    path.join(roaming, 'Tencent', 'WeChat', 'Cache'),
  ];
  const roots = []; let directoriesVisited = 0;
  async function walk(directory, depth) {
    if (depth > 8 || directoriesVisited++ > 4000) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    if (/^(?:cache|cache_data|cachestorage)$/i.test(path.basename(directory))) { roots.push(directory); return; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.test(entry.name)) await walk(path.join(directory, entry.name), depth + 1);
    }
  }
  for (const base of bases) await walk(base, 0);
  return [...new Set(roots)];
}

export async function scanCaches({ biz, roots, sinceMinutes = 120, maxBytes = 512 * 1024 * 1024, maxFiles = 10000, maxMs = 45000, seenFiles = new Set() }) {
  const started = Date.now(); const deadline = started + maxMs;
  const stats = { cacheRoots: roots.length, filesFound: 0, filesRead: 0, bytesRead: 0, candidatesFound: 0, unreadableFiles: 0, limitReasons: [] };
  const recent = []; const candidates = new Map(); const cutoff = started - sinceMinutes * 60000;
  let dirs = 0;
  async function enumerate(directory) {
    if (Date.now() > deadline || dirs++ > 4000) { stats.limitReasons.push('enumeration_budget'); return; }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SKIP.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await enumerate(file); continue; }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      if (!stat.size || stat.mtimeMs < cutoff) continue;
      if (stat.size > 64 * 1024 * 1024) { stats.limitReasons.push('oversized_cache_file'); continue; }
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
    if (stats.bytesRead + file.size > maxBytes) { stats.limitReasons.push('byte_count'); break; }
    let overlap = Buffer.alloc(0); let readOk = false;
    try {
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
    } catch { stats.unreadableFiles++; }
    stats.filesRead++;
    if (readOk) seenFiles.add(file.version);
  }
  stats.candidatesFound = candidates.size;
  stats.limitReasons = [...new Set(stats.limitReasons)];
  stats.durationMs = Date.now() - started;
  return { candidates: [...candidates.values()].sort((a, b) => b.modifiedAt - a.modifiedAt), stats };
}
