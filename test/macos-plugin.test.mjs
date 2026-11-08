import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from '../test-support/plugin-harness.mjs';

const source = 'https://mp.weixin.qq.com/s/mac-test';
const page = '<h1 id="activity-name">Mac 测试文章</h1><a id="js_name">测试公众号</a><script>var biz="TESTBIZ==";var ct="1792969200";</script><div id="js_content"><p>在 Mac 保存的正文。</p><img data-src="https://mmbiz.qpic.cn/test/0"></div>';

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: single save localizes images and preserves edits on repeat without history access`, async () => {
    const h = await pluginHarness({ platform, settings: { articleUrl: source } });
    h.plugin.createHttp = () => ({ get: async () => ({ body: page }) });
    h.plugin.createImages = () => ({ get: async () => ({ data: Buffer.from('fixture-image'), extension: 'png' }) });
    await h.plugin.saveSingleArticle();
    assert.equal(h.plugin.completed, 1); assert(h.plugin.lastSingleFile);
    assert.match(h.files.get(h.plugin.lastSingleFile), /附件\/[^\n]+\.png/);
    const edited = h.files.get(h.plugin.lastSingleFile) + '\n我自己的笔记';
    h.files.set(h.plugin.lastSingleFile, edited);
    await h.plugin.saveSingleArticle();
    assert.equal(h.files.get(h.plugin.lastSingleFile), edited);
    assert(![...h.files.keys()].some(p => p.endsWith('/归档记录.json')));
  });

  test(`${platform}: public album catalog and selected save work without WeChat cache access`, async () => {
    const h = await pluginHarness({ platform, settings: { articleUrl: 'https://mp.weixin.qq.com/mp/appmsgalbum?__biz=TESTBIZ%3D%3D&album_id=900000001', downloadImages: false } });
    h.plugin.createHttp = () => ({ get: async input => ({ body: new URL(input).pathname === '/mp/appmsgalbum'
      ? JSON.stringify({ base_resp: { ret: 0 }, getalbum_resp: { base_info: { title: 'Mac 合集', nickname: '测试公众号', article_count: '1' }, article_list: [{ msgid: '123', itemidx: '1', title: 'Mac 测试文章', create_time: '1792969200', url: 'https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=123&idx=1' }], continue_flag: '0' } })
      : page }) });
    await h.plugin.fetchCatalog();
    assert.equal(h.plugin.catalog?.job.articles.length, 1);
    assert.equal(h.plugin.selected.size, 0);
    h.plugin.selected.add(h.plugin.catalog.job.articles[0].id);
    await h.plugin.saveSelected(); assert.equal(h.plugin.completed, 1);
    assert.equal(h.plugin.catalog.job.status, 'SELECTED_ARTICLES_SAVED');
  });
}

test('Mac shows experimental history status and distinct missing/denied/format messages', async () => {
  const h = await pluginHarness({ platform: 'darwin' });
  assert.match(h.plugin.status, /实验功能/);
  assert.match(h.plugin.friendlyError({ code: 'CACHE_ACCESS_DENIED' }), /系统未允许 Obsidian/);
  assert.match(h.plugin.friendlyError({ code: 'CACHE_ROOT_MISSING' }), /Mac 微信 4.x/);
  assert.match(h.plugin.friendlyError({ code: 'CACHE_FORMAT_UNSUPPORTED' }), /格式暂不兼容/);
});

test('unsupported platforms do not start a save or directory scan', async () => {
  for (const platform of ['linux', 'mobile']) {
    const h = await pluginHarness({ platform, settings: { articleUrl: source } });
    await h.plugin.saveSingleArticle(); await h.plugin.fetchCatalog();
    assert.equal(h.writes.length, 0); assert.equal(h.notices.length, 2);
  }
});
