import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cacheBases, discoverCaches, scanCaches } from '../src/cache.mjs';

const biz = 'TESTBIZ==';
const url = `https://mp.weixin.qq.com/mp/profile_ext?__biz=${encodeURIComponent(biz)}&uin=FAKE_UIN&key=FAKE_KEY&pass_ticket=FAKE_TICKET`;
function simpleEntry(key, { version = 5, body = '' } = {}) {
  const bytes = Buffer.from(key); const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(version, 8); header.writeUInt32LE(bytes.length, 12);
  return Buffer.concat([header, bytes, Buffer.from(body)]);
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-macos-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test('Mac discovery only visits WeChat web/cache roots and excludes private stores and symlinks', async t => {
  const home = await temporary(t);
  const [web, cache] = cacheBases({ platform: 'darwin', home });
  const root = path.join(web, 'profiles', 'multitab_test', 'Cache');
  for (const directory of [path.join(root, 'Cache_Data'), cache, path.join(web, 'db_storage', 'Cache'), path.join(web, 'Cookies', 'Cache')]) await fs.mkdir(directory, { recursive: true });
  const outside = path.join(home, 'unrelated', 'Cache'); await fs.mkdir(outside, { recursive: true });
  await fs.symlink(path.dirname(outside), path.join(web, 'linked-profile'), 'junction');
  assert.deepEqual((await discoverCaches({}, { platform: 'darwin', home })).sort(), [root, cache].sort());
  assert.deepEqual(cacheBases({ platform: 'linux', home }), []);
  const roaming = path.join(home, 'test-roaming');
  assert(cacheBases({ platform: 'win32', home, env: { APPDATA: roaming } }).every(p => p.startsWith(path.join(roaming, 'Tencent') + path.sep)));
});

test('permission denial differs from a missing cache and does not leak local paths', async () => {
  for (const code of ['EPERM', 'EACCES']) {
    await assert.rejects(discoverCaches({}, { platform: 'darwin', home: '/private-home', io: { readdir: async () => { throw Object.assign(new Error('/private-home/secret'), { code }); } } }), error => {
      assert.equal(error.code, 'CACHE_ACCESS_DENIED'); assert(!error.message.includes('private-home')); return true;
    });
  }
  assert.deepEqual(await discoverCaches({}, { platform: 'darwin', io: { readdir: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } }), []);
});

test('Mac cache reads only valid Simple v5 URL keys for the requested account', async t => {
  const root = await temporary(t);
  const key = `1/0/${url}`;
  await fs.writeFile(path.join(root, '0123456789abcdef_0'), simpleEntry(key, { body: `\0${url.replace('FAKE_KEY', 'BODY_KEY')}\0` }));
  await fs.writeFile(path.join(root, '0123456789abcdee_0'), simpleEntry(key.replace('TESTBIZ', 'OTHERBIZ')));
  await fs.writeFile(path.join(root, 'Cookies'), url);
  await fs.writeFile(path.join(root, '0123456789abcdea_1'), simpleEntry(key));
  const { candidates, stats } = await scanCaches({ biz, roots: [root], simpleKeysOnly: true });
  assert.equal(candidates.length, 1); assert.equal(candidates[0].fields.key, 'FAKE_KEY');
  assert.equal(stats.filesRead, 2);
  assert.equal(stats.bytesRead, 48 + Buffer.byteLength(key) + Buffer.byteLength(key.replace('TESTBIZ', 'OTHERBIZ')));
  assert.equal(stats.unsupportedEntries, 0);
});

test('unsupported, corrupt and incomplete Simple entries never fall back to body scanning', async t => {
  const root = await temporary(t);
  const entries = [Buffer.from(url), simpleEntry(url, { version: 99 }), simpleEntry(url).subarray(0, 30), simpleEntry(url)];
  entries[3].writeUInt32LE(0xffffffff, 12);
  for (const [i, entry] of entries.entries()) await fs.writeFile(path.join(root, `${String(i).padStart(16, '0')}_0`), entry);
  const { candidates, stats } = await scanCaches({ biz, roots: [root], simpleKeysOnly: true });
  assert.equal(candidates.length, 0); assert.equal(stats.unsupportedEntries, 4);
});

test('Mac key scanning obeys time, file, byte budgets and skips already-read versions', async t => {
  const root = await temporary(t); const seenFiles = new Set();
  await fs.writeFile(path.join(root, '0123456789abcdef_0'), simpleEntry(url));
  for (const options of [{ maxBytes: 10 }, { maxFiles: 0 }, { maxMs: -1 }]) {
    const result = await scanCaches({ biz, roots: [root], simpleKeysOnly: true, ...options });
    assert.equal(result.candidates.length, 0); assert(result.stats.limitReasons.length);
  }
  assert.equal((await scanCaches({ biz, roots: [root], simpleKeysOnly: true, seenFiles })).candidates.length, 1);
  assert.equal((await scanCaches({ biz, roots: [root], simpleKeysOnly: true, seenFiles })).stats.filesRead, 0);
});
