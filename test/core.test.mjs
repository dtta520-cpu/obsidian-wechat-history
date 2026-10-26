import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidatesFromBytes, candidateFromUrl, publicArticleUrl, parseArticle, parseHistoryPage, parseAuthorPage, enumerateHistory, WechatHttp, entities } from '../src/core.mjs';
import { scanCaches } from '../src/cache.mjs';

const biz = 'TESTBIZ==';
const article = (mid, idx = 1) => `https://mp.weixin.qq.com/s?__biz=TESTBIZ%3D%3D&mid=${mid}&idx=${idx}&sn=public-signature`;
const auth = 'https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=TESTBIZ%3D%3D&uin=FAKE_USER&key=FAKE_SECRET&pass_ticket=FAKE_TICKET';
const payload = (mid, next = 10, more = 1) => ({ ret: 0, next_offset: next, can_msg_continue: more,
  general_msg_list: JSON.stringify({ list: [{ comm_msg_info: { datetime: 1700000000 }, app_msg_ext_info: {
    title: '同名标题', content_url: article(mid), multi_app_msg_item_list: [{ title: '同名标题', content_url: article(mid, 2) }],
  } }] }),
});

test('public URLs remove credentials and reject unexpected hosts and paths', () => {
  const clean = publicArticleUrl(article(1) + '&key=FAKE_SECRET&uin=FAKE_USER&pass_ticket=FAKE_TICKET');
  assert(!clean.includes('FAKE_'));
  for (const url of ['https://evil.invalid/s/a', 'https://mp.weixin.qq.com@evil.invalid/s/a', 'http://evil.invalid/s/a', 'https://mp.weixin.qq.com/mp/profile_ext']) assert.throws(() => publicArticleUrl(url));
  assert.equal(publicArticleUrl('http://mp.weixin.qq.com/s/a'), 'https://mp.weixin.qq.com/s/a');
});

test('HTML entity decoding preserves timestamp parameters and encoded query separators', () => {
  assert.equal(entities('&timestamp=123&amp;x=1'), '&timestamp=123&x=1');
  const candidate = candidateFromUrl(auth + '%26fake=value', biz);
  assert.equal(candidate.fields.pass_ticket, 'FAKE_TICKET&fake=value');
  assert.equal(candidate.fields.fake, undefined);
});

test('cache extraction binds to the requested account and supports UTF16', () => {
  for (const encoding of ['utf8', 'utf16le']) {
    const result = candidatesFromBytes(Buffer.from(`prefix\0${auth}\0suffix`, encoding), biz);
    assert.equal(result.length, 1);
    assert.equal(result[0].fields.key, 'FAKE_SECRET');
  }
  assert.equal(candidatesFromBytes(Buffer.from(auth), 'OTHERBIZ==').length, 0);
});

test('parsing a challenge page fails instead of inventing account metadata', () => {
  assert.throws(() => parseArticle('<h1>环境异常，请完成验证</h1>', 'https://mp.weixin.qq.com/s/public'), { code: 'VERIFICATION_REQUIRED' });
  assert.throws(() => parseArticle('<script>seajs.use("secitptpage/template/verify.js")</script>', article(1)), { code: 'VERIFICATION_REQUIRED' });
});

test('history preserves same-title articles and all secondary entries', () => {
  const page = parseHistoryPage(payload(123), biz, 0);
  assert.equal(page.articles.length, 2);
  assert.notEqual(page.articles[0].id, page.articles[1].id);
  assert.equal(page.nextOffset, 10);
});

test('server errors or malformed responses never become an empty complete history', () => {
  assert.throws(() => parseHistoryPage({ ret: -3 }, biz, 0), { code: 'AUTH_REQUIRED' });
  assert.throws(() => parseHistoryPage({ ret: 200013 }, biz, 0), { code: 'RATE_LIMITED' });
  assert.throws(() => parseHistoryPage({ ret: 0 }, biz, 0), { code: 'INVALID_HISTORY' });
  assert.throws(() => parseHistoryPage({ ret: 0, general_msg_list: '{bad' }, biz, 0), { code: 'INVALID_HISTORY' });
});

test('forward cursor is followed even when can_msg_continue is incorrectly zero', async () => {
  const firstPage = parseHistoryPage(payload(1, 10, 0), biz, 0);
  const offsets = [];
  const result = await enumerateHistory({ firstPage, fetchPage: async offset => {
    offsets.push(offset);
    return parseHistoryPage({ ret: 0, next_offset: 10, can_msg_continue: 0, general_msg_list: '{"list":[]}' }, biz, offset);
  } });
  assert.deepEqual(offsets, [10]);
  assert.equal(result.coverage, 'ENDPOINT_EXHAUSTED_UNVERIFIED');
});

test('repeated pages are stopped instead of silently losing older history', async () => {
  await assert.rejects(enumerateHistory({ firstPage: parseHistoryPage(payload(1), biz, 0),
    fetchPage: async offset => parseHistoryPage(payload(1, 20), biz, offset),
  }), { code: 'PAGINATION_LOOP' });
});

test('page budget is incomplete, checkpoint happens before failure', async () => {
  let saved = false;
  await assert.rejects(enumerateHistory({ firstPage: parseHistoryPage(payload(1), biz, 0), maxPages: 1,
    onPage: async () => { saved = true; }, fetchPage: async () => assert.fail('must not request more'),
  }), { code: 'PAGE_LIMIT' });
  assert(saved);
});

test('an ambiguous empty page is incomplete', async () => {
  const firstPage = parseHistoryPage({ ret: 0, can_msg_continue: 1, next_offset: 10, general_msg_list: '{"list":[]}' }, biz, 0);
  await assert.rejects(enumerateHistory({ firstPage, fetchPage: async () => assert.fail() }), { code: 'PAGINATION_UNCERTAIN' });
});

test('HTTP never forwards credentials through a redirect to another host', async () => {
  let calls = 0;
  const http = new WechatHttp({ intervalMs: 0, fetchImpl: async () => {
    calls++; return new Response('', { status: 302, headers: { location: 'https://evil.invalid/' } });
  } });
  await assert.rejects(http.get(auth, { Cookie: 'key=FAKE_SECRET' }), { code: 'INVALID_URL' });
  assert.equal(calls, 1);
});

test('author pagination uses a string cursor and preserves secondary articles', async () => {
  const firstPage = parseAuthorPage({ ret: 0, articles: [
    { __biz: biz, mid: '123', title: '头条', url: article(123), publish_time: 1700000000 },
    { __biz: biz, mid: '123', title: '次条', url: article(123, 2), publish_time: 1700000000 },
  ] }, biz, '');
  assert.equal(firstPage.nextOffset, '123');
  const result = await enumerateHistory({ firstPage, fetchPage: async cursor => {
    assert.equal(cursor, '123'); return parseAuthorPage({ ret: 0, articles: [] }, biz, cursor);
  } });
  assert.equal(result.articles.length, 2);
  assert.equal(result.coverage, 'ENDPOINT_EXHAUSTED_UNVERIFIED');
});

test('author ret zero does not override an error in base_resp', () => {
  assert.throws(() => parseAuthorPage({ ret: 0, base_resp: { ret: -3 }, articles: [] }, biz, ''), { code: 'AUTH_REQUIRED' });
});

test('cache scanner uses recent cache files and skips credential databases', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-prototype-test-'));
  try {
    await fs.writeFile(path.join(root, 'http_cache_entry'), auth);
    await fs.mkdir(path.join(root, 'Network'));
    await fs.writeFile(path.join(root, 'Network', 'Cookies'), auth.replace('FAKE_SECRET', 'WRONG_SECRET'));
    const { candidates, stats } = await scanCaches({ biz, roots: [root] });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].fields.key, 'FAKE_SECRET');
    assert.equal(stats.filesRead, 1);
    assert(!JSON.stringify(stats).includes('FAKE_SECRET'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
