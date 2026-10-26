import test from 'node:test';
import assert from 'node:assert/strict';
import { formatArticle, safeName, noteName, imageUrl } from '../src/article-format.mjs';
import { parseHistoryPage } from '../src/core.mjs';
const account = { biz: 'TESTBIZ==', nickname: '测试公众号' };
const article = { id: 'TESTBIZ==:123:1', title: '测试', publishedAt: '2026-10-25T23:00:00Z', url: 'https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=123&idx=1&key=FAKE_SECRET' };
const format = (html, options = {}) => formatArticle({ html, article, account, ...options });
function shared(body, extra = '') {
  return `<html><body><script>window.cgiDataNew = { link: 'https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=123&idx=1', content_noencode: ${JSON.stringify(body)}, ${extra} }; throw new Error('never execute');</script></body></html>`;
}
test('article formatting localizes images, keeps tables and code, and removes page scripts', async () => {
  const result = await format('<html><body><div id="js_content"><p>正文内容</p><img data-src="https://mmbiz.qpic.cn/a/0"><table><tr><th>列</th><th>数</th></tr><tr><td>A|B</td><td>2</td></tr></table><pre><code>const n = 2;</code></pre><script>bad()</script></div></body></html>', { saveImage: async url => { assert.equal(url, 'https://mmbiz.qpic.cn/a/0'); return '附件/a.jpg'; } });
  assert.match(result.markdown, /附件\/a.jpg/); assert.match(result.markdown, /A\\\|B/);
  assert.match(result.markdown, /```[\s\S]*const n = 2/);
  assert(!result.markdown.includes('bad()')); assert(!result.markdown.includes('FAKE_SECRET'));
  assert.equal(result.imagesSaved, 1);
});
test('private and missing bodies are never saved as empty success notes', async () => {
  await assert.rejects(format('<script src="/assets/private-legacy.abc.js"></script>'), { code: 'ARTICLE_PRIVATE' });
  await assert.rejects(format('<html><body>unavailable</body></html>'), { code: 'BODY_UNAVAILABLE' });
});
test('shared picture text is read statically, including escaped line breaks', async () => {
  const result = await format(shared('第一段\n\n第二段', "picture_page_info_list: [{cdn_url:'https://mmbiz.qpic.cn/a/0'}]"), { saveImage: async () => '附件/b.png' });
  assert.match(result.markdown, /第一段\n\n第二段/); assert.equal(result.imagesSaved, 1);
});
test('shared audio retains its description and explicitly marks original-only audio', async () => {
  const result = await format(shared('<section>00:00 介绍\n01:00 讨论</section>').replace('</body>', '<script src="/assets/common_share_audio.abc.js"></script></body>'));
  assert.match(result.markdown, /00:00 介绍/); assert(result.warnings.includes('AUDIO_ORIGINAL_ONLY'));
});
test('dynamic script expressions and another article data are not evaluated as content', async () => {
  const html = shared('hello').replace('"hello"', "(()=>{throw new Error('must not run')})()");
  await assert.rejects(format(html), { code: 'BODY_UNAVAILABLE' });
  await assert.rejects(format(shared('hello').replace('mid=123', 'mid=999')), { code: 'BODY_UNAVAILABLE' });
});
test('cancellation during an image write propagates to the job', async () => {
  await assert.rejects(format('<div id="js_content">文字<img data-src="https://mmbiz.qpic.cn/a"></div>', { saveImage: async () => { const error = new Error('stop'); error.code = 'CANCELLED'; throw error; } }), { code: 'CANCELLED' });
});
test('Windows note names are safe and date uses China local time', () => {
  assert.equal(safeName('CON'), '_CON'); assert.equal(safeName('a/b:c?'), 'a_b_c_');
  assert.match(noteName(article), /^2026-10-26 /);
  assert.throws(() => imageUrl('https://mmbiz.qpic.cn.evil.invalid/a'));
});
test('nested server failure is respected even with top-level success', () => {
  assert.throws(() => parseHistoryPage({ ret: 0, base_resp: { ret: -3 } }, account.biz, 0), { code: 'AUTH_REQUIRED' });
});

test('small template images retain display width instead of their large source dimensions', async () => {
  const result = await format('<div id="js_content"><section style="display:flex;flex-flow:row"><div><img style="width:30.625px" data-w="500" data-src="https://mmbiz.qpic.cn/a"></div><div><p><span style="font-weight:bold">章节标题</span></p></div></section><p><br></p><section><p>正文</p><p>第二段</p></section></div>', { saveImage: async () => '附件/a.png' });
  assert.match(result.markdown, /!\[31\]\(附件\/a.png\) <strong>章节标题<\/strong>/);
  assert.match(result.markdown, /正文\n\n第二段/); assert(!result.markdown.includes('\n\n\n'));
});
test('horizontal year digits join while separate introduction paragraphs remain separate', async () => {
  const result = await format('<div id="js_content"><section style="display:flex"><div><section style="display:flex;flex-flow:row"><p>2</p><p>0</p><p>2</p><p>5</p><p>Happy Time</p></section><p>介绍第一段</p><p>介绍第二段</p></div></section></div>');
  assert.match(result.markdown, /2025 Happy Time/); assert.match(result.markdown, /介绍第一段\n\n介绍第二段/);
});
test('Wingdings checkmark becomes a portable Unicode checkmark without changing normal umlauts', async () => {
  const result = await format('<div id="js_content"><p><span style="font-family:Wingdings">ü</span>项目一</p><p>普通 ü 保留</p></div>');
  assert.match(result.markdown, /✓项目一/); assert.match(result.markdown, /普通 ü 保留/); assert.equal(result.layout.symbolGlyphsConverted, 1);
});
test('table cells keep image and hyperlink content instead of discarding nontext data', async () => {
  const result = await format('<div id="js_content"><table><tr><th>图</th><th>链接</th></tr><tr><td><img style="width:80px" data-src="https://mmbiz.qpic.cn/a"></td><td><a href="https://example.com/">来源</a></td></tr></table></div>', { saveImage: async () => '附件/a.png' });
  assert.match(result.markdown, /!\[80\]\(附件\/a.png\)/); assert.match(result.markdown, /\[来源\]\(https:\/\/example.com\/\)/);
});
test('Chinese emphasis beside punctuation uses markup that does not become literal stars', async () => {
  const result = await format('<div id="js_content"><p>前文。<strong>重点。</strong>后文。<em>储蓄、稳健和投资。</em>下一句。</p></div>');
  assert.match(result.markdown, /前文。<strong>重点。<\/strong>后文。<em>储蓄、稳健和投资。<\/em>下一句。/);
});
