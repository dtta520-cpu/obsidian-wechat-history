import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from '../test-support/plugin-harness.mjs';

const source = 'https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=100&idx=1';
const settings = { articleUrl: source, outputFolder: '公众号归档', downloadImages: false };
const account = { biz: 'TESTBIZ==', nickname: '测试公众号', title: '目录入口' };
const article = { id: 'TESTBIZ==:100:1', title: '目录入口', url: source, publishedAt: '2026-10-25T00:00:00Z' };
const base = '公众号归档/测试公众号';
const manifest = `${base}/归档记录.json`;
const index = `${base}/公众号归档索引.md`;
const failure = code => Object.assign(new Error(code), { code });
const history = () => ({ articles: [article], pages: [{ offset: 0 }], unresolved: 0,
  coverage: 'ENDPOINT_EXHAUSTED_UNVERIFIED', endReason: 'explicit_empty_end' });

async function setup(options = {}) {
  const harness = await pluginHarness({ settings, ...options });
  harness.pageRequests = [];
  harness.plugin.createHttp = () => ({ get: async url => {
    harness.pageRequests.push(url);
    return { body: '<h1 id="activity-name">目录入口</h1><a id="js_name">测试公众号</a>' };
  } });
  await harness.plugin.open();
  harness.view = harness.leaves[0].view;
  harness.focus = harness.domEvents.find(event => event.type === 'focus');
  assert(harness.focus);
  return harness;
}

test('existing WeChat context goes straight to selection without copying or connection prompts', async () => {
  const harness = await setup();
  let attempts = 0;
  harness.plugin.readHistory = async () => { attempts++; return history(); };
  assert.equal(harness.view.connectionHelp.hidden, true);
  assert(!harness.view.startButton.parentElement.contains(harness.view.copy));
  await harness.view.startButton.onclick();
  assert.equal(harness.plugin.catalog.job.status, 'AWAITING_SELECTION');
  assert.equal(harness.plugin.selected.size, 0);
  assert.equal(harness.view.connectionHelp.hidden, true);
  assert.equal(harness.clipboardWrites.length, 0);
  await harness.focus.callback();
  assert.equal(attempts, 1);
});

test('missing or expired context shows guidance and preserves the existing catalog, index and notes', async () => {
  for (const code of ['AUTH_REQUIRED', 'CACHE_ROOT_MISSING']) {
    const prior = JSON.stringify({ account, source, ...history(), results: [], endpointExhausted: true });
    const note = `${base}/用户笔记.md`;
    const files = new Map([['公众号归档', null], [base, null], [manifest, prior], [index, '已有索引'], [note, '使用者修改']]);
    const harness = await setup({ initialFiles: files });
    harness.plugin.readHistory = async () => { throw failure(code); };
    await harness.plugin.fetchCatalog();
    assert.equal(harness.plugin.running, false);
    assert.equal(harness.plugin.historyConnection.account.biz, account.biz);
    assert.equal(harness.view.connectionHelp.hidden, false);
    assert.match(harness.view.connectionTitle.textContent, /测试公众号/);
    assert.match(harness.view.connectionHint.textContent, /自动重试一次/);
    assert.equal(harness.files.get(manifest), prior);
    assert.equal(harness.files.get(index), '已有索引');
    assert.equal(harness.files.get(note), '使用者修改');
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.clipboardWrites.length, 0);
    assert(!('historyConnection' in harness.settings));
  }
});

test('returning to the window retries once, reuses resolved metadata, and rejects concurrent focus events', async () => {
  const harness = await setup();
  let attempts = 0; let release;
  harness.plugin.readHistory = async () => {
    attempts++;
    if (attempts === 1) throw failure('AUTH_REQUIRED');
    await new Promise(resolve => { release = resolve; });
    return history();
  };
  await harness.plugin.fetchCatalog();
  const retry = harness.focus.callback();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.plugin.running, true);
  await harness.focus.callback();
  await harness.plugin.retryHistoryConnection();
  assert.equal(attempts, 2);
  release(); await retry;
  assert.equal(harness.pageRequests.length, 1);
  assert.equal(harness.plugin.historyConnection, null);
  assert.equal(harness.plugin.catalog.job.articles.length, 1);
  assert.equal(harness.view.connectionHelp.hidden, true);
  assert(![...harness.files.keys()].some(path => path.endsWith('.md') && path !== index));
});

test('a failed automatic retry cannot loop on focus and offers a manual retry', async () => {
  const harness = await setup(); let attempts = 0;
  harness.plugin.readHistory = async () => {
    if (++attempts < 3) throw failure('AUTH_REQUIRED');
    return history();
  };
  await harness.plugin.fetchCatalog();
  await harness.focus.callback();
  assert.equal(harness.plugin.historyConnection.autoRetry, false);
  assert.match(harness.view.connectionHint.textContent, /本次自动重试已结束/);
  await harness.focus.callback(); await harness.focus.callback();
  assert.equal(attempts, 2);
  await harness.view.retryConnection.onclick();
  assert.equal(attempts, 3);
  assert.equal(harness.plugin.catalog.job.status, 'AWAITING_SELECTION');
});

test('expiry, cancellation, unload and changed inputs prevent stale automatic requests', async () => {
  for (const action of ['expire', 'cancel', 'unload', 'source', 'folder']) {
    const harness = await setup(); let attempts = 0;
    harness.plugin.readHistory = async () => { attempts++; throw failure('AUTH_REQUIRED'); };
    await harness.plugin.fetchCatalog();
    if (action === 'expire') harness.plugin.historyConnection.expiresAt = Date.now() - 1;
    if (action === 'cancel') harness.view.cancelConnection.onclick();
    if (action === 'unload') harness.plugin.onunload();
    if (action === 'source') await harness.view.urlInput.change('https://mp.weixin.qq.com/s/another-public-article');
    if (action === 'folder') { harness.plugin.settings.outputFolder = '另一目录'; await harness.plugin.saveSettings(); }
    await harness.focus.callback();
    assert.equal(attempts, 1);
    if (action === 'expire') {
      assert.equal(harness.plugin.historyConnection.autoRetry, false);
      await harness.view.retryConnection.onclick();
      assert.equal(attempts, 2);
    } else assert.equal(harness.plugin.historyConnection, null);
  }
});

test('verification, rate limits, network errors and partially fetched catalogs never auto-retry', async () => {
  for (const code of ['VERIFICATION_REQUIRED', 'RATE_LIMITED', 'NETWORK_ERROR', 'AUTH_REQUIRED', 'CACHE_ACCESS_DENIED', 'CACHE_FORMAT_UNSUPPORTED']) {
    const harness = await setup({ platform: code.startsWith('CACHE_') ? 'darwin' : 'win32' }); let attempts = 0;
    harness.plugin.readHistory = async (found, http, onPage) => {
      attempts++;
      if (code === 'AUTH_REQUIRED') await onPage(history());
      throw failure(code);
    };
    await harness.plugin.fetchCatalog();
    assert.equal(harness.plugin.historyConnection, null);
    await harness.focus.callback(); assert.equal(attempts, 1);
    const partial = JSON.parse(harness.files.get(manifest));
    assert.equal(partial.status, 'INCOMPLETE');
    assert(!partial.endpointExhausted);
    if (code === 'AUTH_REQUIRED') assert.equal(partial.articles.length, 1);
  }
});

test('backup copy uses the known public homepage without another page request or session data', async () => {
  const harness = await setup({ settings: { ...settings, articleUrl: `${source}&key=FAKE_SECRET&pass_ticket=FAKE_TICKET` } });
  harness.plugin.readHistory = async () => { throw failure('AUTH_REQUIRED'); };
  await harness.plugin.fetchCatalog();
  await harness.view.copy.onclick();
  assert.equal(harness.pageRequests.length, 1);
  assert.equal(harness.clipboardWrites.length, 1);
  const copied = new URL(harness.clipboardWrites[0]);
  assert.equal(copied.pathname, '/mp/profile_ext');
  assert.equal(copied.searchParams.get('__biz'), account.biz);
  assert(!JSON.stringify([harness.clipboardWrites, harness.settings, harness.plugin.historyConnection]).includes('FAKE_'));
});

test('single-article requests clear a pending history connection before doing any work', async () => {
  const harness = await setup(); let attempts = 0;
  harness.plugin.readHistory = async () => { attempts++; throw failure('AUTH_REQUIRED'); };
  await harness.plugin.fetchCatalog();
  assert(harness.plugin.historyConnection);
  // The short synthetic page lacks a body; this request must fail without
  // leaving an unrelated history retry armed.
  await harness.plugin.saveSingleArticle();
  assert.equal(harness.plugin.historyConnection, null);
  await harness.focus.callback(); assert.equal(attempts, 1);
});
