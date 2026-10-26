import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from '../test-support/plugin-harness.mjs';
import { noteName } from '../src/article-format.mjs';

const account = { biz: 'TESTBIZ==', nickname: '测试公众号', title: '目录入口' };
const articles = ['目录入口', '选择这篇', '选择这篇', '其他文章'].map((title, index) => ({
  id: `TESTBIZ==:${100 + index}:1`, title, publishedAt: '2026-10-25T23:00:00Z',
  url: `https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=${100 + index}&idx=1`,
}));
const base = '公众号归档/测试公众号';
const manifest = `${base}/归档记录.json`; const indexPath = `${base}/公众号归档索引.md`;
const settings = { articleUrl: articles[0].url, outputFolder: '公众号归档', downloadImages: false, lastIndex: indexPath };
const job = () => ({ account, source: articles[0].url, articles: structuredClone(articles), results: [], pages: [], endpointExhausted: true, status: 'AWAITING_SELECTION' });
const notePath = index => `${base}/${noteName(articles[index])}`;
const filesFor = value => new Map([['公众号归档', null], [base, null], [manifest, JSON.stringify(value)]]);
const body = '<div id="js_content"><p>选中的文章正文</p></div>';

test('fetching a directory stops before saving any article and restores without network', async () => {
  const harness = await pluginHarness({ settings }); const { plugin, files } = harness;
  const requested = [];
  plugin.createHttp = () => ({ get: async url => {
    requested.push(url); assert.equal(url, articles[0].url);
    return { body: '<h1 id="activity-name">目录入口</h1><a id="js_name">测试公众号</a>' };
  } });
  plugin.readHistory = async (found, http, onPage) => {
    assert.equal(found.biz, account.biz);
    const history = { articles: structuredClone(articles), pages: [{ offset: 0 }], unresolved: 0, coverage: 'ENDPOINT_EXHAUSTED_UNVERIFIED', endReason: 'explicit_empty_end' };
    await onPage(history); return history;
  };
  await plugin.fetchCatalog();
  assert.deepEqual(requested, [articles[0].url]);
  assert.equal(plugin.catalog.job.status, 'AWAITING_SELECTION'); assert.equal(plugin.selected.size, 0);
  assert(articles.every((_, i) => !files.has(notePath(i)))); assert(!files.has(`${base}/附件`));
  assert.match(files.get(indexPath), /未保存 \*\*4 条\*\*/);
  const restored = await pluginHarness({ settings: harness.settings, initialFiles: files });
  assert.equal(restored.plugin.catalog.job.articles.length, 4); assert.equal(restored.plugin.selected.size, 0);
  assert.equal(restored.writes.length, 0);
});

test('an incomplete directory is checkpointed but cannot be selected as a complete catalog', async () => {
  const harness = await pluginHarness({ settings }); const { plugin } = harness;
  plugin.createHttp = () => ({ get: async () => ({ body: '<h1 id="activity-name">目录入口</h1><a id="js_name">测试公众号</a>' }) });
  plugin.readHistory = async (found, http, onPage) => {
    await onPage({ articles: [articles[0]], pages: [{ offset: 0 }], unresolved: 0 });
    const error = new Error('Interrupted'); error.code = 'NETWORK_ERROR'; throw error;
  };
  await plugin.fetchCatalog();
  assert.equal(plugin.catalog, null); assert.equal(plugin.running, false);
  const partial = JSON.parse(harness.files.get(manifest));
  assert.equal(partial.status, 'INCOMPLETE'); assert.equal(partial.articles.length, 1);
  assert(!partial.endpointExhausted);
  const restored = await pluginHarness({ settings, initialFiles: harness.files });
  assert.equal(restored.plugin.catalog, null);
});

test('only checked IDs are fetched, including same-title entries, and unselected records remain intact', async () => {
  const initial = job(); initial.results.push({ id: articles[3].id, status: 'unavailable', code: 'ARTICLE_PRIVATE' });
  const { plugin, files } = await pluginHarness({ settings, initialFiles: filesFor(initial) });
  const requested = []; plugin.selected.add(articles[1].id); plugin.selected.add(articles[2].id);
  plugin.createHttp = () => ({ get: async url => {
    requested.push(url); plugin.selected.add(articles[0].id); // A later UI change cannot expand this run.
    return { body };
  } });
  await plugin.saveSelected();
  assert.deepEqual(requested, [articles[1].url, articles[2].url]);
  assert(!files.has(notePath(0))); assert(!files.has(notePath(3)));
  assert(files.has(notePath(1))); assert(files.has(notePath(2)));
  const saved = JSON.parse(files.get(manifest));
  assert.equal(saved.articles.length, 4); assert.equal(saved.selection.total, 2);
  assert.deepEqual(saved.results.find(item => item.id === articles[3].id), initial.results[0]);
  assert.match(files.get(indexPath), /未保存 \*\*1 条\*\*/);
  assert.match(files.get(indexPath), /其他待补齐 \*\*0 条\*\*/);
});

test('existing edited notes are preserved; only the selected unavailable article is attempted', async () => {
  const original = `---\narticle_id: ${JSON.stringify(articles[1].id)}\n---\n用户修改后的正文`;
  const initial = filesFor(job()); initial.set(notePath(1), original);
  const { plugin, files, writes } = await pluginHarness({ settings, initialFiles: initial });
  const requested = []; plugin.selected.add(articles[1].id); plugin.selected.add(articles[2].id);
  plugin.createHttp = () => ({ get: async url => { requested.push(url); return { body: '<script src="/assets/private-legacy.abc.js"></script>' }; } });
  await plugin.saveSelected();
  assert.deepEqual(requested, [articles[2].url]); assert.equal(files.get(notePath(1)), original);
  assert(!writes.includes(notePath(1))); assert(!files.has(notePath(2)));
  assert.equal(plugin.articleState(articles[1]), '已保存'); assert.equal(plugin.articleState(articles[2]), '访问受限');
  assert.equal(plugin.catalog.job.status, 'SELECTED_ARTICLES_WITH_UNAVAILABLE');
});

test('stop checkpoints the chosen scope and restart resumes only the remaining checked articles', async () => {
  const harness = await pluginHarness({ settings, initialFiles: filesFor(job()) });
  const { plugin, vault } = harness; plugin.selected.add(articles[1].id); plugin.selected.add(articles[2].id);
  const requested = []; plugin.createHttp = () => ({ get: async url => { requested.push(url); return { body }; } });
  const create = vault.create;
  vault.create = async (path, text) => { await create(path, text); if (path === notePath(1)) plugin.stopping = true; };
  await plugin.saveSelected();
  assert.deepEqual(requested, [articles[1].url]); assert.equal(plugin.catalog.job.status, 'PAUSED');
  assert.match(harness.files.get(indexPath), /已保存文字 \*\*1 条\*\*/);
  const resumed = await pluginHarness({ settings: harness.settings, initialFiles: harness.files });
  assert.deepEqual([...resumed.plugin.selected], [articles[2].id]);
  const remaining = []; resumed.plugin.createHttp = () => ({ get: async url => { remaining.push(url); return { body }; } });
  await resumed.plugin.saveSelected();
  assert.deepEqual(remaining, [articles[2].url]); assert.equal(resumed.plugin.selected.size, 0);
  assert.equal(resumed.plugin.catalog.job.status, 'SELECTED_ARTICLES_SAVED');
});

test('empty selection and changed target cannot start a save; conflicting notes are never overwritten', async () => {
  const harness = await pluginHarness({ settings, initialFiles: filesFor(job()) }); const { plugin } = harness;
  await plugin.saveSelected(); assert.equal(harness.writes.length, 0);
  plugin.selected.add(articles[1].id); plugin.settings.articleUrl = articles[3].url;
  await plugin.saveSelected(); assert.equal(harness.writes.length, 0);
  plugin.settings.articleUrl = settings.articleUrl; plugin.settings.outputFolder = '另一目录';
  await plugin.saveSelected(); assert.equal(harness.writes.length, 0);
  plugin.settings.outputFolder = settings.outputFolder;
  harness.files.set(notePath(1), '另一篇文章的笔记');
  plugin.createHttp = () => ({ get: async () => assert.fail('Conflict must stop before requesting article') });
  await plugin.saveSelected();
  assert.equal(plugin.catalog.job.error.code, 'FILE_CONFLICT');
  assert.equal(harness.files.get(notePath(1)), '另一篇文章的笔记'); assert(!harness.writes.includes(notePath(1)));
});

test('a previously saved note missing from disk is offered for saving again', async () => {
  const initial = job(); initial.results.push({ id: articles[1].id, status: 'saved', file: noteName(articles[1]) });
  const harness = await pluginHarness({ settings, initialFiles: filesFor(initial) });
  assert.equal(harness.plugin.articleState(articles[1]), '未保存');
  assert.equal(harness.plugin.catalog.job.results[0].status, 'missing');
  assert.equal(harness.writes.length, 0);
  harness.plugin.selected.add(articles[1].id);
  harness.plugin.createHttp = () => ({ get: async url => { assert.equal(url, articles[1].url); return { body }; } });
  await harness.plugin.saveSelected(); assert(harness.files.has(notePath(1)));
});

test('selection UI supports search, checked IDs, bulk selection, and locks controls while saving', async () => {
  const initial = filesFor(job()); initial.set(notePath(1), `article_id: ${JSON.stringify(articles[1].id)}`);
  const harness = await pluginHarness({ settings, initialFiles: initial }); const { plugin } = harness;
  await plugin.open(); const view = harness.leaves[0].view;
  assert.equal(view.rowControls.length, 4); assert.equal(view.saveButton.disabled, true);
  view.search.value = '选择'; view.search.oninput();
  assert.equal(view.rowControls.length, 2);
  view.selectUnsaved.onclick(); assert.deepEqual([...plugin.selected], [articles[2].id]);
  view.selectAll.onclick(); assert.equal(plugin.selected.size, 2);
  assert.equal(view.saveButton.disabled, false);
  const checkbox = view.rowControls[0].checkbox; checkbox.checked = false; checkbox.onchange();
  assert.deepEqual([...plugin.selected], [articles[2].id]); assert.equal(view.rowControls[0].checkbox, checkbox);
  view.search.value = '不存在'; view.search.oninput();
  assert.equal(view.rowControls.length, 0); assert.equal(plugin.selected.size, 1);
  assert.equal(view.selectAll.disabled, true); assert.match(view.selectionSummary.textContent, /已勾选 1 篇/);
  plugin.running = true; plugin.refreshViews();
  assert.equal(view.saveButton.disabled, true); assert.equal(view.search.disabled, true); assert.equal(view.stopButton.disabled, false);
  plugin.running = false; plugin.refreshViews(); view.clearSelection.onclick();
  assert.equal(plugin.selected.size, 0); assert.equal(view.saveButton.disabled, true);
});
