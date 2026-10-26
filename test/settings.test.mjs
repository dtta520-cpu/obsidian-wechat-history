import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from '../test-support/plugin-harness.mjs';

test('pasted article and album sessions never reach saved settings, even before fetching', async () => {
  const harness = await pluginHarness();
  const inputs = [
    ['https://mp.weixin.qq.com/s/public?key=FAKE_SECRET&pass_ticket=FAKE_TICKET#FAKE_FRAGMENT', 'https://mp.weixin.qq.com/s/public'],
    ['https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=123&idx=1&uin=FAKE_UIN&appmsg_token=FAKE_TOKEN', 'https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=123&idx=1'],
    ['https://mp.weixin.qq.com/mp/appmsgalbum?__biz=TESTBIZ%3D%3D&album_id=9000000000000000001&sessionid=FAKE_SESSION', 'https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz=TESTBIZ%3D%3D&album_id=9000000000000000001'],
    ['https://mp.weixin.qq.com/?key=FAKE_SECRET', ''],
    ['unfinished FAKE_SECRET', ''],
  ];
  for (const [input, expected] of inputs) {
    harness.plugin.settings.articleUrl = input;
    harness.plugin.settings.cookie = 'FAKE_COOKIE';
    await harness.plugin.saveSettings();
    assert.equal(harness.settings.articleUrl, expected);
    assert(!JSON.stringify(harness.settings).includes('FAKE_'));
    assert.equal(harness.plugin.settings.articleUrl, input, 'Typing must not replace the in-memory input');
  }
  assert.equal(harness.writes.length, 0, 'Saving settings must not write article files');
});

test('loading an older configuration removes pasted credentials without downloading', async () => {
  const settings = {
    articleUrl: 'https://mp.weixin.qq.com/s/public?key=FAKE_SECRET&pass_ticket=FAKE_TICKET',
    outputFolder: '自定义归档', downloadImages: false,
    lastIndex: '自定义归档/测试/公众号归档索引.md',
    lastCatalog: '自定义归档/测试/归档记录.json',
  };
  const harness = await pluginHarness({ settings });
  assert.deepEqual(harness.settings, { ...settings, articleUrl: 'https://mp.weixin.qq.com/s/public' });
  assert.equal(harness.plugin.settings.articleUrl, harness.settings.articleUrl);
  assert.equal(harness.writes.length, 0);
});
