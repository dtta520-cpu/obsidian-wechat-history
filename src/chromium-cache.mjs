import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { candidateFromUrl, wechatUrl, entities, parseHistoryPage } from './core.mjs';

// Read-only Chromium blockfile layout, verified against upstream disk_format.h/addr.h.
// Cache response metadata is linked to its own URL; cookies are never pooled across entries.
export function cacheAddress(value) {
  if (!(value & 0x80000000)) return null;
  const type = (value >>> 28) & 7;
  if (type === 0) return { file: `f_${(value & 0x0fffffff).toString(16).padStart(6, '0')}`, offset: 0 };
  const size = [0, 36, 256, 1024, 4096, 8, 104, 48][type];
  return { file: `data_${(value >>> 16) & 255}`, offset: 8192 + (value & 0xffff) * size };
}

async function readAddress(directory, address, length, budget) {
  const location = cacheAddress(address);
  if (!location || length <= 0 || length > 16 * 1024 * 1024 || budget.bytes + length > 128 * 1024 * 1024) return null;
  let handle;
  try {
    handle = await fs.open(path.join(directory, location.file), 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, location.offset);
    budget.bytes += bytesRead;
    return bytesRead === length ? buffer : null;
  } catch { return null; } finally { await handle?.close(); }
}

export async function inspectTargetCache({ roots, biz, authorId }) {
  const records = []; const candidates = new Map(); const budget = { bytes: 0 };
  const deadline = Date.now() + 30000;
  for (const root of roots) {
    const directory = path.join(root, 'Cache_Data');
    let entries;
    try { entries = await fs.readdir(directory); } catch { continue; }
    for (const name of entries.filter(name => /^data_\d+$/.test(name))) {
      if (Date.now() > deadline) break;
      const filename = path.join(directory, name);
      let data;
      try {
        const handle = await fs.open(filename, 'r');
        try {
          const header = Buffer.alloc(24); await handle.read(header, 0, 24, 0);
          // BlockFileHeader.entry_size is at byte 12, after magic/version/file numbers.
          if (header.readUInt32LE(0) !== 0xc104cac3 || header.readInt32LE(12) !== 256) continue;
          const stat = await handle.stat();
          if (stat.size > 32 * 1024 * 1024) continue;
          data = await handle.readFile(); budget.bytes += data.length;
        } finally { await handle.close(); }
      } catch { continue; }
      // readFile starts after the explicit-position reads at position zero.
      for (let offset = 8192; offset + 256 <= data.length; offset += 256) {
        if (Date.now() > deadline || budget.bytes > 128 * 1024 * 1024) break;
        const length = data.readInt32LE(offset + 32);
        if (data.readInt32LE(offset + 20) !== 0 || length < 20 || length > 65536) continue;
        const keyAddress = data.readUInt32LE(offset + 36);
        const keyBytes = keyAddress ? await readAddress(directory, keyAddress, length, budget)
          : data.subarray(offset + 96, offset + 96 + Math.min(length, 927));
        if (!keyBytes || keyBytes.length !== length) continue;
        const key = keyBytes.toString('utf8');
        const start = key.indexOf('https://mp.weixin.qq.com/');
        if (start < 0) continue;
        let url;
        try { url = wechatUrl(key.slice(start)); } catch { continue; }
        if (url.searchParams.get('__biz') !== biz && !(authorId && url.searchParams.get('author_id') === authorId)) continue;
        const meta = await readAddress(directory, data.readUInt32LE(offset + 56), data.readInt32LE(offset + 40), budget);
        const headers = meta?.toString('latin1') || '';
        const cookieJar = {};
        for (const match of headers.matchAll(/(?:^|\x00|\r\n)set-cookie:\s*([^=;\s]+)=([^;\x00\r\n]*)/gi)) cookieJar[match[1]] = match[2];
        const candidate = candidateFromUrl(url.href, biz);
        if (candidate) {
          candidate.fields.cookieJar = cookieJar;
          candidates.set(candidate.identity, candidate);
        }
        let body = await readAddress(directory, data.readUInt32LE(offset + 60), data.readInt32LE(offset + 44), budget);
        const encoding = headers.match(/content-encoding:\s*([^\x00\r\n]+)/i)?.[1].trim();
        if (body && encoding) {
          try {
            const decompress = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
            if (decompress) body = decompress(body, { maxOutputLength: 16 * 1024 * 1024 });
          } catch { body = null; }
        }
        const record = { path: url.pathname, action: url.searchParams.get('action'), queryFields: [...url.searchParams.keys()].sort(),
          cookieNames: Object.keys(cookieJar), bodyBytes: body?.length || 0,
          contentType: headers.match(/content-type:\s*([^\x00\r\n]+)/i)?.[1] || null };
        if (body) {
          if (url.pathname === '/mp/profile_ext' && url.searchParams.get('action') === 'home') {
            const html = body.toString('utf8');
            record.pageTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '';
            record.inlineVariableNames = [...new Set([...html.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]))];
            record.referencedMpPaths = [...new Set([...html.matchAll(/\/mp\/[a-z_]+/g)].map(match => match[0]))];
            record.pocTokenMentioned = /poc_token/.test(html);
            record.clientRequired = /请在微信|微信客户端/.test(html);
            record.verificationPage = /环境异常|完成验证|js_verify/.test(html);
            record.hasMessageList = /general_msg_list|msgList/.test(html);
            record.scriptSources = [...html.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map(match => entities(match[1])).filter(value => /^https:\/\/res\.wx\.qq\.com\//.test(value)).map(value => value.split('?')[0]);
            record.publicScriptReferences = [...new Set([...html.matchAll(/(?:https?:)?\/\/res\.wx\.qq\.com[^\s"'<>\\]+\.js/g)].map(match => match[0]))];
            const getmsgAt = html.indexOf('getmsg');
            if (getmsgAt >= 0) {
              record.paginationCodeShape = html.slice(Math.max(0, getmsgAt - 500), getmsgAt + 1500)
                .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '<string>')
                .replace(/\b\d{6,}\b/g, '<number>');
            }
            record.visibleText = entities(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 500);
            const quotedList = html.match(/var\s+msgList\s*=\s*'([^\n]*)';/);
            if (quotedList) { try { record.embeddedMessageCount = JSON.parse(entities(quotedList[1])).list?.length; } catch { record.embeddedListParseable = false; } }
            for (const name of ['can_msg_continue', 'next_offset', 'is_ok', 'is_banned']) {
              const match = html.match(new RegExp('var\\s+' + name + '\\s*=\\s*["\\\']?(-?\\d+)'));
              if (match) record[name] = Number(match[1]);
            }
            if (candidate && quotedList) {
              try {
                const cachedList = JSON.parse(entities(quotedList[1]));
                const first = cachedList.list?.[0];
                record.messageShape = { messageKeys: Object.keys(first || {}), extKeys: Object.keys(first?.app_msg_ext_info || {}),
                  linkPrefix: first?.app_msg_ext_info?.content_url?.slice(0, 35), msgType: first?.comm_msg_info?.type };
                candidate.cachedPage = parseHistoryPage({ ret: 0, general_msg_list: entities(quotedList[1]),
                  can_msg_continue: record.can_msg_continue, next_offset: record.next_offset }, biz, 0);
              } catch {}
            }
            const list = html.match(/var\s+msgList\s*=\s*([\s\S]*?);\s*(?:var|function|\n)/);
            if (list) { try { record.embeddedMessageCount = JSON.parse(list[1]).list?.length; } catch {} }
          }
          try {
            const json = JSON.parse(body.toString('utf8'));
            record.responseFields = Object.keys(json).sort();
            record.ret = typeof json.ret === 'number' ? json.ret : null;
            if (Array.isArray(json.articles)) record.articleCount = json.articles.length;
            if (typeof json.general_msg_list === 'string') record.historyMessageCount = JSON.parse(json.general_msg_list).list?.length;
          } catch { /* Cached HTML is intentionally never printed or persisted. */ }
        }
        records.push(record);
      }
    }
  }
  return { candidates: [...candidates.values()], evidence: { records, bytesRead: budget.bytes, timeLimitReached: Date.now() > deadline } };
}
