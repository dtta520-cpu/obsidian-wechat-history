import test from 'node:test';
import assert from 'node:assert/strict';
import { singleArticle } from '../src/single-article.mjs';
import { noteName } from '../src/article-format.mjs';
import { pluginHarness } from '../test-support/plugin-harness.mjs';

const short = 'https://mp.weixin.qq.com/s/synthetic-single-article';
const long = 'https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=123&idx=2&sn=public-signature';
const image = 'https://mmbiz.qpic.cn/synthetic-single-image/0';
const base = '公众号归档/测试公众号';
const singleRecord = `${base}/单篇归档记录.json`;
const singleIndex = `${base}/单篇归档索引.md`;
const historyRecord = `${base}/归档记录.json`;
const historyIndex = `${base}/公众号归档索引.md`;
const page = ({ title = '单篇测试', canonical = long, body = `<div id="js_content"><p>正文内容保留，仅保存当前选择的单篇文章。</p><img data-src="${image}"></div>`, ct = '1792969200' } = {}) =>
  `<html><head><meta property="og:url" content="${canonical.replaceAll('&', '&amp;')}"></head><body><h1 id="activity-name">${title}</h1><a id="js_name">测试公众号</a><script>var biz = 'TESTBIZ=='; var ct = '${ct}'; throw new Error('Never execute remote script');</script>${body}</body></html>`;
const article = singleArticle(page(), short).article;
const note = `${base}/${noteName(article)}`;
const settings = { articleUrl: short, outputFolder: '公众号归档', downloadImages: true };
function responses(harness, html = page()) {
  const requests = []; const images = [];
  harness.plugin.createHttp = () => ({ get: async url => { requests.push(url); return { body: html }; } });
  harness.plugin.createImages = () => ({ get: async url => { images.push(url); return { data: Buffer.from('synthetic image'), extension: 'png' }; } });
  return { requests, images };
}
const record = harness => JSON.parse(harness.files.get(singleRecord));

test('single metadata unifies short and long links, strips sessions, and rejects another article', () => {
  assert.equal(article.id, 'TESTBIZ==:123:2');
  assert.equal(singleArticle(page(), long).article.id, article.id);
  assert.equal(singleArticle(page(), `${short}?key=FAKE_SECRET`).article.url, short);
  assert.throws(() => singleArticle(page({ canonical: long.replace('mid=123', 'mid=124') }), long), { code: 'ARTICLE_MISMATCH' });
  assert.throws(() => singleArticle(page({ canonical: long.replace('TESTBIZ', 'OTHERBIZ') }), short), { code: 'ACCOUNT_MISMATCH' });
  const fields = '<h1 id="activity-name">字面量元数据</h1><script>var biz="TESTBIZ=="; var appmsgid = 0 || "90071992547409931"; var itemidx="2"; var ct="invalid";</script>';
  const result = singleArticle(fields, short);
  assert.equal(result.article.id, 'TESTBIZ==:90071992547409931:2');
  assert.equal(result.article.publishedAt, null);
  const dynamic = fields.replace('0 || "90071992547409931"', '(()=>{throw new Error("Do not execute")})()');
  assert.equal(singleArticle(dynamic, short).article.id, short);
});

test('single save fetches one page, localizes images, and never discovers history or stores session values', async () => {
  const harness = await pluginHarness({ settings: { ...settings, articleUrl: `${short}?key=FAKE_SECRET&pass_ticket=FAKE_TICKET` } });
  const calls = responses(harness);
  await harness.plugin.saveSingleArticle();
  assert.deepEqual(calls.requests, [short]); assert.deepEqual(calls.images, [image]);
  assert(harness.files.has(note)); assert.match(harness.files.get(note), /附件\/.+\.png/);
  const saved = record(harness);
  assert.equal(saved.scope.type, 'single'); assert.equal(saved.endpointExhausted, false); assert.equal(saved.fullHistoryVerified, false);
  assert.equal(saved.results[0].imagesSaved, 1); assert.equal(saved.articles.length, 1);
  assert.match(harness.files.get(singleIndex), /不代表公众号完整历史目录/);
  assert(!harness.files.has(historyRecord)); assert(!harness.files.has(historyIndex));
  assert.equal(harness.plugin.lastSingleFile, note); assert.equal(harness.plugin.completed, 1);
  assert(!JSON.stringify([...harness.files]).includes('FAKE_')); assert(!JSON.stringify(harness.settings).includes('FAKE_'));
  assert.equal(harness.settings.lastCatalog, undefined);
  const restored = await pluginHarness({ settings: harness.settings, initialFiles: harness.files });
  assert.equal(restored.plugin.catalog, null, 'Single ledger must not become a full history catalog');
});

test('a long-link repeat preserves an edited short-link note even when metadata changes its filename', async () => {
  const harness = await pluginHarness({ settings }); responses(harness);
  await harness.plugin.saveSingleArticle();
  const edited = harness.files.get(note) + '\n用户的补充笔记'; harness.files.set(note, edited);
  harness.plugin.settings.articleUrl = long;
  const calls = responses(harness, page({ title: '改过的标题', ct: '1793055600' }));
  await harness.plugin.saveSingleArticle();
  assert.deepEqual(calls.requests, [long]); assert.deepEqual(calls.images, []);
  assert.equal(harness.files.get(note), edited);
  assert.equal(record(harness).articles.length, 1);
  assert.equal(harness.plugin.lastSingleFile, note);
  assert.equal([...harness.files.keys()].filter(path => path.endsWith('.md') && path !== singleIndex).length, 1);
});

test('single save preserves full-history files and unrelated selected articles', async () => {
  const other = { ...article, id: 'TESTBIZ==:124:1', title: '另一篇', url: long.replace('mid=123', 'mid=124') };
  const history = JSON.stringify({ account: { biz: 'TESTBIZ==', nickname: '测试公众号' }, source: short,
    scope: { type: 'history' }, articles: [article, other], results: [], endpointExhausted: true });
  const initialFiles = new Map([['公众号归档', null], [base, null], [historyRecord, history], [historyIndex, '已有完整历史索引']]);
  const harness = await pluginHarness({ settings: { ...settings, lastCatalog: historyRecord, lastIndex: historyIndex }, initialFiles });
  harness.plugin.selected.add(other.id); responses(harness);
  await harness.plugin.saveSingleArticle();
  assert.equal(harness.files.get(historyRecord), history); assert.equal(harness.files.get(historyIndex), '已有完整历史索引');
  assert.equal(harness.settings.lastCatalog, historyRecord);
  assert(harness.plugin.savedIds.has(article.id)); assert.deepEqual([...harness.plugin.selected], [other.id]);
  const modified = { ...article, title: '目录里的不同标题', publishedAt: null };
  const later = await pluginHarness({ settings: { ...harness.settings, articleUrl: short }, initialFiles: new Map([...harness.files, [historyRecord,
    JSON.stringify({ account: { biz: 'TESTBIZ==', nickname: '测试公众号' }, source: short, articles: [modified], results: [], endpointExhausted: true })]]) });
  assert(later.plugin.savedIds.has(article.id)); later.plugin.selected.add(article.id);
  later.plugin.createHttp = () => ({ get: async () => assert.fail('Existing single note must not be downloaded again') });
  await later.plugin.saveSelected();
  assert.equal(later.plugin.completed, 1); assert.equal(later.plugin.catalog.job.results[0].file, noteName(article));
});

test('single save rejects non-article inputs and conflicting account folders without changing existing files', async () => {
  for (const url of ['https://example.com/article', 'https://mp.weixin.qq.com/mp/appmsgalbum?__biz=TESTBIZ%3D%3D&album_id=9000000001']) {
    const harness = await pluginHarness({ settings: { ...settings, articleUrl: url } });
    await harness.plugin.saveSingleArticle(); assert.equal(harness.writes.length, 0);
  }
  const conflictRecord = `${base}/合集-9000000001-归档记录.json`;
  const initialFiles = new Map([['公众号归档', null], [base, null], [conflictRecord, JSON.stringify({ account: { biz: 'OTHERBIZ==' } })]]);
  const harness = await pluginHarness({ settings, initialFiles }); responses(harness);
  await harness.plugin.saveSingleArticle();
  assert.equal(harness.writes.length, 0); assert.match(harness.plugin.status, /另一个同名公众号/);
});

test('private, missing, and verification pages never produce successful article notes', async () => {
  for (const [body, code] of [
    ['<script src="/assets/private-legacy.abc.js"></script>', 'ARTICLE_PRIVATE'],
    ['<p>没有正文</p>', 'BODY_UNAVAILABLE'],
    ['<div id="js_verify">环境异常</div>', 'VERIFICATION_REQUIRED'],
  ]) {
    const harness = await pluginHarness({ settings }); responses(harness, page({ body }));
    await harness.plugin.saveSingleArticle();
    assert(!harness.files.has(note)); assert.equal(harness.plugin.completed, 0); assert.equal(harness.plugin.lastSingleFile, '');
    if (code !== 'VERIFICATION_REQUIRED') assert.equal(record(harness).results[0].code, code);
    else assert.equal(harness.files.size, 0);
  }
});

test('single save respects disabled images, cancellation, and filename conflicts', async () => {
  const noImages = await pluginHarness({ settings: { ...settings, downloadImages: false } }); const calls = responses(noImages);
  await noImages.plugin.saveSingleArticle(); assert.equal(calls.images.length, 0); assert.match(noImages.files.get(note), /mmbiz\.qpic\.cn/);
  const cancelled = await pluginHarness({ settings }); responses(cancelled);
  cancelled.plugin.createImages = () => ({ get: async () => { cancelled.plugin.stopping = true; return { data: Buffer.from('image'), extension: 'png' }; } });
  await cancelled.plugin.saveSingleArticle();
  assert.equal(record(cancelled).status, 'PAUSED'); assert(!cancelled.files.has(note));
  const conflict = await pluginHarness({ settings, initialFiles: new Map([['公众号归档', null], [base, null], [note, '使用者的其他文档']]) }); responses(conflict);
  await conflict.plugin.saveSingleArticle();
  assert.equal(conflict.files.get(note), '使用者的其他文档'); assert.equal(record(conflict).error.code, 'FILE_CONFLICT');
});

test('single button runs directly, locks during downloads, disables for albums, and opens the saved note', async () => {
  const harness = await pluginHarness({ settings }); responses(harness);
  await harness.plugin.open(); const view = harness.leaves[0].view;
  assert.equal(view.singleButton.disabled, false); assert.equal(view.openSingleButton.hidden, true);
  let releasePage;
  harness.plugin.createHttp = () => ({ get: async () => new Promise(resolve => { releasePage = resolve; }) });
  const saving = view.singleButton.onclick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(view.singleButton.disabled, true); assert.equal(view.urlInput.inputEl.disabled, true);
  assert.equal(view.startButton.disabled, true); assert.equal(view.stopButton.disabled, false);
  releasePage({ body: page() }); await saving;
  assert.equal(view.singleButton.disabled, false); assert.equal(view.openSingleButton.hidden, false);
  let opened;
  harness.app.workspace.openLinkText = async path => { opened = path; };
  await view.openSingleButton.onclick(); assert.equal(opened, note);
  await view.urlInput.change('https://mp.weixin.qq.com/mp/appmsgalbum?__biz=TESTBIZ%3D%3D&album_id=9000000001');
  assert.equal(view.singleButton.disabled, true); assert.equal(view.startButton.disabled, false);
});
