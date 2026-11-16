import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from '../test-support/plugin-harness.mjs';
import { enumerateHistory } from '../src/core.mjs';
import { noteName } from '../src/article-format.mjs';

const account = { biz: 'TESTBIZ==', nickname: '测试公众号', title: '目录入口' };
const articles = ['目录入口', '目标文章', '目标文章', '其他文章'].map((title, i) => ({
  id: `TESTBIZ==:${100 + i}:1`, title, publishedAt: '2026-11-01T00:00:00Z',
  url: `https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=${100 + i}&idx=1`,
}));
const source = articles[0].url;
const base = '公众号归档/测试公众号';
const manifest = `${base}/归档记录.json`; const index = `${base}/公众号归档索引.md`;
const settings = { articleUrl: source, outputFolder: '公众号归档', downloadImages: false };
const html = '<h1 id="activity-name">目录入口</h1><a id="js_name">测试公众号</a><div id="js_content"><p>正文</p></div>';
const page = (offset, items, end = false) => ({ articles: items, offset, nextOffset: end ? null : offset + 10,
  canContinue: !end, messageCount: items.length, unresolved: 0 });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function setup(options = {}) {
  const h = await pluginHarness({ settings, ...options }); h.requests = [];
  h.plugin.createHttp = () => ({ get: async url => { h.requests.push(url); return { body: html }; } });
  await h.plugin.open(); h.view = h.leaves[0].view;
  h.gates = [0, 1].map(() => ({ entered: deferred(), response: deferred() })); h.cursors = [];
  h.plugin.readHistory = async (found, http, onPage) => enumerateHistory({ firstPage: page(0, articles.slice(0, 2)), onPage,
    fetchPage: async cursor => {
      const gate = h.gates[h.cursors.length]; assert(gate, 'unexpected extra page');
      h.cursors.push(cursor); gate.entered.resolve(); return gate.response.promise;
    },
  });
  return h;
}
async function select(h, id) {
  const checkbox = h.view.rowControls.find(row => row.article.id === id).checkbox;
  checkbox.checked = true; await checkbox.onchange(); return checkbox;
}

test('pages appear immediately; filtering, checkbox nodes and selected IDs survive later pages and completion', { timeout: 5000 }, async () => {
  const h = await setup(); const task = h.plugin.fetchCatalog();
  await h.gates[0].entered.promise;
  assert.equal(h.plugin.running, true); assert.equal(h.view.catalogEl.hidden, false);
  assert.equal(h.view.rowControls.length, 2); assert.equal(h.view.search.disabled, false);
  assert.match(h.view.catalogProgress.textContent, /正在拉取/);
  h.view.search.value = '目标'; h.view.search.oninput();
  await h.view.selectAll.onclick();
  const checkbox = h.view.rowControls[0].checkbox;
  h.gates[0].response.resolve(page(10, articles.slice(2)));
  await h.gates[1].entered.promise;
  assert.equal(h.plugin.catalog.job.articles.length, 4);
  assert.equal(h.view.rowControls.length, 2); assert.equal(h.view.search.value, '目标');
  assert.equal(h.view.rowControls[0].checkbox, checkbox); assert(checkbox.checked);
  assert.equal(h.view.rowControls[1].checkbox.checked, false);
  assert.deepEqual([...h.plugin.selected], [articles[1].id]);
  assert.equal(h.requests.length, 1, 'enumeration must not download bodies');
  assert.match(h.files.get(index), /正在拉取目录/);
  h.gates[1].response.resolve(page(20, [], true)); await task;
  assert.equal(h.plugin.catalog.job.endpointExhausted, true);
  assert.deepEqual([...h.plugin.selected], [articles[1].id]);
  assert.equal(h.view.rowControls[0].checkbox, checkbox);
  assert.match(h.view.catalogProgress.textContent, /目录已遍历/);
  assert.deepEqual(JSON.parse(h.files.get(manifest)).selection.ids, [articles[1].id]);
});

test('stopping retains the in-flight page, selection, partial index and restartable catalog; selected bodies can then be saved', { timeout: 5000 }, async () => {
  const h = await setup(); const task = h.plugin.fetchCatalog();
  await h.gates[0].entered.promise; await select(h, articles[1].id);
  h.view.stopButton.onclick(); h.gates[0].response.resolve(page(10, articles.slice(2))); await task;
  assert.equal(h.cursors.length, 1); assert.equal(h.plugin.running, false);
  assert.equal(h.view.catalogEl.hidden, false); assert.equal(h.view.rowControls.length, 4);
  assert.equal(h.view.saveButton.disabled, false);
  assert.match(h.view.catalogProgress.textContent, /部分目录/);
  const record = JSON.parse(h.files.get(manifest));
  assert.equal(record.endpointExhausted, false); assert.equal(record.directoryStatus, 'PAUSED');
  assert.deepEqual(record.selection.ids, [articles[1].id]); assert.match(h.files.get(index), /部分目录/);
  const reopened = await pluginHarness({ settings: h.settings, initialFiles: h.files });
  assert.equal(reopened.plugin.catalog.job.articles.length, 4); assert.match(reopened.plugin.status, /部分目录/);
  assert.deepEqual([...reopened.plugin.selected], [articles[1].id]);
  const requested = []; reopened.plugin.createHttp = () => ({ get: async url => { requested.push(url); return { body: html }; } });
  await reopened.plugin.saveSelected();
  assert.deepEqual(requested, [articles[1].url]); assert(reopened.files.has(`${base}/${noteName(articles[1])}`));
  const saved = JSON.parse(reopened.files.get(manifest));
  assert.equal(saved.status, 'SELECTED_ARTICLES_SAVED'); assert.equal(saved.endpointExhausted, false);
  assert.equal(saved.directoryStatus, 'PAUSED'); assert.match(reopened.files.get(index), /部分目录/);
});

test('save while fetching stops pagination and saves exactly the IDs selected at the click', { timeout: 5000 }, async () => {
  const h = await setup(); const task = h.plugin.fetchCatalog();
  await h.gates[0].entered.promise; await select(h, articles[1].id);
  assert.match(h.view.saveButton.textContent, /停止拉取并保存所选/);
  await h.view.saveButton.onclick(); assert.equal(h.plugin.stopping, true);
  assert.equal(h.view.rowControls[0].checkbox.disabled, true);
  h.plugin.selected.add(articles[2].id); // A later mutation cannot expand the queued request.
  h.gates[0].response.resolve(page(10, articles.slice(2))); await task;
  assert.equal(h.cursors.length, 1); assert.deepEqual(h.requests, [source, articles[1].url]);
  assert(h.files.has(`${base}/${noteName(articles[1])}`)); assert(!h.files.has(`${base}/${noteName(articles[2])}`));
  assert.equal(h.plugin.catalog.job.articles.length, 4); assert.equal(h.plugin.catalog.job.endpointExhausted, false);
  assert.equal(h.plugin.catalog.job.status, 'SELECTED_ARTICLES_SAVED'); assert.equal(h.plugin.running, false);
});

test('explicit stop, unload or a rate-limit response cancels the queued save', { timeout: 5000 }, async () => {
  for (const reason of ['stop', 'unload', 'rate']) {
    const h = await setup(); const task = h.plugin.fetchCatalog();
    await h.gates[0].entered.promise; await select(h, articles[1].id); await h.view.saveButton.onclick();
    if (reason === 'stop') h.view.stopButton.onclick();
    if (reason === 'unload') h.plugin.onunload();
    if (reason === 'rate') h.gates[0].response.reject(Object.assign(new Error('limited'), { code: 'RATE_LIMITED' }));
    else h.gates[0].response.resolve(page(10, articles.slice(2)));
    await task;
    assert.deepEqual(h.requests, [source]); assert.equal(h.plugin.saveAfterFetch, null);
    assert(h.plugin.catalog.job.articles.length >= 2);
    assert.equal(h.plugin.catalog.job.endpointExhausted, false);
  }
});

test('slow selection writes cannot overwrite newer pages or subsequent selections', { timeout: 5000 }, async () => {
  const h = await setup(); const task = h.plugin.fetchCatalog(); await h.gates[0].entered.promise;
  const entered = deferred(); const release = deferred(); let hold = true;
  const modify = h.vault.modify;
  h.vault.modify = async (file, text) => {
    if (file.path === manifest && hold) { hold = false; entered.resolve(); await release.promise; }
    await modify(file, text);
  };
  const first = select(h, articles[0].id); await entered.promise;
  const second = select(h, articles[1].id);
  h.gates[0].response.resolve(page(10, articles.slice(2)));
  release.resolve(); await first; await second; await h.gates[1].entered.promise;
  h.gates[1].response.resolve(page(20, [], true)); await task;
  const record = JSON.parse(h.files.get(manifest));
  assert.equal(record.articles.length, 4); assert.equal(record.endpointExhausted, true);
  assert.deepEqual(record.selection.ids.sort(), articles.slice(0, 2).map(item => item.id).sort());
});

test('a refresh stopped before its first page preserves the previous catalog and edited files', { timeout: 5000 }, async () => {
  const prior = JSON.stringify({ account, source, articles: articles.slice(0, 2), results: [], pages: [{ offset: 0 }], endpointExhausted: false,
    status: 'PAUSED', selection: { ids: [articles[1].id] } });
  const initialFiles = new Map([['公众号归档', null], [base, null], [manifest, prior], [index, '旧索引'], [`${base}/用户笔记.md`, '用户编辑']]);
  const h = await setup({ settings: { ...settings, lastCatalog: manifest }, initialFiles });
  const entered = deferred(); const release = deferred();
  h.plugin.readHistory = async () => { entered.resolve(); await release.promise; h.plugin.checkStop(); };
  const task = h.plugin.fetchCatalog(); await entered.promise; h.plugin.stopTask(); release.resolve(); await task;
  assert.equal(h.plugin.catalog.job.articles.length, 2); assert.deepEqual([...h.plugin.selected], [articles[1].id]);
  assert.equal(h.files.get(manifest), prior); assert.equal(h.files.get(index), '旧索引');
  assert.equal(h.files.get(`${base}/用户笔记.md`), '用户编辑');
});

test('failed completeness checks retain valid entries but never label the catalog complete', async () => {
  const h = await setup();
  h.plugin.readHistory = async (found, http, onPage) => enumerateHistory({ firstPage: page(0, [articles[1]], true), onPage });
  await h.plugin.fetchCatalog();
  assert.equal(h.plugin.catalog.job.articles.length, 1);
  assert.equal(h.plugin.catalog.job.directoryError.code, 'KNOWN_ARTICLE_MISSING');
  assert.equal(h.plugin.catalog.job.endpointExhausted, false); assert.match(h.files.get(index), /部分目录/);
  const restored = await pluginHarness({ settings: h.settings, initialFiles: h.files });
  assert.equal(restored.plugin.catalog.job.articles.length, 1); assert.match(restored.plugin.status, /部分目录/);
});

test('an interrupted album is selectable without overwriting the account-history ledger', { timeout: 5000 }, async () => {
  const albumUrl = 'https://mp.weixin.qq.com/mp/appmsgalbum?__biz=TESTBIZ%3D%3D&album_id=900000001';
  const initialFiles = new Map([['公众号归档', null], [base, null], [manifest, JSON.stringify({ account, articles: [], results: [] })]]);
  const original = initialFiles.get(manifest);
  const h = await setup({ settings: { ...settings, articleUrl: albumUrl }, initialFiles });
  const entered = deferred(); const release = deferred(); let pages = 0;
  h.plugin.createHttp = () => ({ get: async input => {
    if (new URL(input).pathname !== '/mp/appmsgalbum') return { body: html };
    const first = ++pages === 1;
    if (!first) { entered.resolve(); await release.promise; }
    const items = first ? articles.slice(0, 2) : articles.slice(2);
    return { body: JSON.stringify({ base_resp: { ret: 0 }, getalbum_resp: {
      base_info: { title: '测试合集', nickname: account.nickname, article_count: '4' }, continue_flag: first ? '1' : '0',
      article_list: items.map(item => ({ msgid: item.id.split(':')[1], itemidx: '1', title: item.title, create_time: '1793491200', url: item.url })),
    } }) };
  } });
  const task = h.plugin.fetchCatalog(); await entered.promise; await select(h, articles[1].id);
  h.plugin.stopTask(); release.resolve(); await task;
  assert.equal(h.view.rowControls.length, 4); assert.equal(h.plugin.catalog.job.scope.countVerified, false);
  assert.equal(h.plugin.catalog.job.endpointExhausted, false); assert.equal(h.files.get(manifest), original);
  await h.plugin.saveSelected(); assert.equal(h.plugin.completed, 1);
  assert.equal(h.files.get(manifest), original); assert.match(h.files.get(h.plugin.lastIndex), /部分目录/);
});
