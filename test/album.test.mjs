import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogSource, parseAlbumPage, AlbumProvider, enumerateAlbum } from '../src/album.mjs';
import { pluginHarness } from '../test-support/plugin-harness.mjs';
import { noteName } from '../src/article-format.mjs';

const biz = 'TESTBIZ==';
const link = 'https://mp.weixin.qq.com/mp/appmsgalbum?__biz=TESTBIZ%3D%3D&album_id=9000000000000000001&scene=126&sessionid=FAKE_SESSION';
const target = catalogSource(link);
const entry = (mid, title = '同名文章') => ({ msgid: String(mid), itemidx: '1', title, create_time: '1770000000',
  url: `http://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=${mid}&idx=1&sn=public-signature&key=FAKE_SECRET` });
const payload = (items, more = '0', total = 3) => ({ base_resp: { ret: 0 }, getalbum_resp: {
  base_info: { title: '测试合集', nickname: '测试公众号', article_count: String(total), username: 'gh_test' }, article_list: items, continue_flag: more,
} });

test('album links preserve large string IDs while removing session parameters', () => {
  assert.equal(target.albumId, '9000000000000000001'); assert.equal(target.type, 'album');
  assert(!target.source.includes('FAKE_')); assert(!target.source.includes('scene='));
  assert.equal(catalogSource(target.source).source, target.source);
  assert.equal(catalogSource('https://mp.weixin.qq.com/s/public').type, 'history');
  for (const value of ['https://evil.invalid/mp/appmsgalbum?__biz=TEST&album_id=12345',
    'https://mp.weixin.qq.com/mp/appmsgalbum?__biz=TEST&album_id=123x',
    'https://mp.weixin.qq.com/mp/appmsgalbum?album_id=12345',
    'https://mp.weixin.qq.com/mp/publictag?action=get&tag_id=12345']) assert.throws(() => catalogSource(value));
});

test('album pagination follows both cursor fields, preserves group order and verifies total', async () => {
  const requests = [];
  const provider = new AlbumProvider({ get: async (input, headers) => {
    const url = new URL(input); requests.push(url);
    assert.equal(headers['X-Requested-With'], 'XMLHttpRequest');
    const data = requests.length === 1 ? payload([entry(9), entry(3)], '1') : payload([entry(6)]);
    if (requests.length > 1) data.getalbum_resp.base_info = { is_first_screen: '0', service_type: '0' };
    return { body: JSON.stringify(data) };
  } });
  const firstPage = await provider.page(target);
  const history = await enumerateAlbum({ provider, target, firstPage });
  assert.equal(requests.length, 2); assert.equal(requests[1].searchParams.get('begin_msgid'), '3');
  assert.equal(requests[1].searchParams.get('begin_itemidx'), '1');
  assert.deepEqual(history.articles.map(item => item.id), [`${biz}:9:1`, `${biz}:3:1`, `${biz}:6:1`]);
  assert.equal(history.countVerified, true); assert.equal(history.coverage, 'ALBUM_ENDPOINT_EXHAUSTED');
  assert(!JSON.stringify(history).includes('FAKE_SECRET'));
});

test('malformed pages, unknown continuation, missing entries and another account fail closed', () => {
  assert.throws(() => parseAlbumPage({ ret: 0, base_resp: { ret: -3 } }, target), { code: 'ALBUM_ACCESS_REQUIRED' });
  assert.throws(() => parseAlbumPage({ base_resp: { ret: 200013 } }, target), { code: 'RATE_LIMITED' });
  assert.throws(() => parseAlbumPage(payload([], 'maybe'), target), { code: 'PAGINATION_UNCERTAIN' });
  assert.throws(() => parseAlbumPage(payload([], '1'), target), { code: 'PAGINATION_UNCERTAIN' });
  const missing = payload([]); delete missing.getalbum_resp.article_list;
  assert.throws(() => parseAlbumPage(missing, target), { code: 'INVALID_ALBUM' });
  const foreign = entry(1); foreign.url = foreign.url.replace('TESTBIZ', 'OTHERBIZ');
  assert.throws(() => parseAlbumPage(payload([foreign]), target), { code: 'ACCOUNT_MISMATCH' });
  const mismatch = entry(1); mismatch.msgid = '2';
  assert.throws(() => parseAlbumPage(payload([mismatch]), target), { code: 'INVALID_ALBUM' });
});

test('album count mismatch, repeated cursors and changing totals do not become complete directories', async () => {
  const short = parseAlbumPage(payload([entry(1)], '0', 2), target);
  await assert.rejects(enumerateAlbum({ provider: {}, target, firstPage: short }), { code: 'ALBUM_COUNT_MISMATCH' });
  const firstPage = parseAlbumPage(payload([entry(1)], '1', 2), target);
  await assert.rejects(enumerateAlbum({ target, firstPage, provider: { page: async (_, cursor) => parseAlbumPage(payload([entry(1)], '1', 2), target, cursor) } }), { code: 'PAGINATION_LOOP' });
  await assert.rejects(enumerateAlbum({ target, firstPage, provider: { page: async (_, cursor) => parseAlbumPage(payload([entry(2)], '0', 3), target, cursor) } }), { code: 'ALBUM_CHANGED' });
  const empty = parseAlbumPage(payload([], '0', 0), target);
  const result = await enumerateAlbum({ provider: {}, target, firstPage: empty }); assert.equal(result.articles.length, 0);
});

test('group directory uses no history cache, keeps the full-history ledger, and reuses saved notes', async () => {
  const base = '公众号归档/测试公众号'; const historyManifest = `${base}/归档记录.json`;
  const outside = parseAlbumPage(payload([entry(999)], '0', 1), target).articles[0];
  const member = parseAlbumPage(payload([entry(9)], '0', 1), target).articles[0];
  const existingNote = `---\narticle_id: ${JSON.stringify(member.id)}\n---\n用户改过的笔记`;
  const historyJob = JSON.stringify({ account: { biz }, articles: [outside], results: [], endpointExhausted: true });
  const files = new Map([['公众号归档', null], [base, null], [historyManifest, historyJob], [`${base}/${noteName(member)}`, existingNote]]);
  const harness = await pluginHarness({ settings: { articleUrl: link, downloadImages: false }, initialFiles: files });
  let requests = 0;
  harness.plugin.createHttp = () => ({ get: async url => {
    requests++; assert.equal(new URL(url).pathname, '/mp/appmsgalbum');
    return { body: JSON.stringify(requests === 1 ? payload([entry(9), entry(3)], '1') : payload([entry(6)])) };
  } });
  await harness.plugin.fetchCatalog();
  assert.equal(requests, 2); assert.equal(harness.plugin.catalog.job.articles.length, 3);
  assert.equal(harness.plugin.catalog.job.scope.title, '测试合集'); assert.equal(harness.plugin.selected.size, 0);
  assert.equal(harness.files.get(historyManifest), historyJob); assert(!harness.writes.includes(historyManifest));
  assert.equal(harness.plugin.articleState(member), '已保存');
  assert.match(harness.files.get(harness.plugin.lastIndex), /仅包含本合集/);
  assert.match(harness.files.get(harness.plugin.lastIndex), /已保存文字 \*\*1 条\*\*/);
  assert(!harness.plugin.catalog.job.articles.some(item => item.id === outside.id));
  const restored = await pluginHarness({ settings: harness.settings, initialFiles: harness.files });
  assert.equal(restored.plugin.catalog.job.scope.id, target.albumId);
  assert.equal(restored.writes.length, 0);
  restored.plugin.selected.add(member.id);
  restored.plugin.createHttp = () => ({ get: async () => assert.fail('Existing note must not be requested') });
  await restored.plugin.saveSelected();
  assert.equal(restored.files.get(`${base}/${noteName(member)}`), existingNote);
  assert.equal(restored.files.get(historyManifest), historyJob);
});
