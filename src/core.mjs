import { createHash } from 'node:crypto';

export class ProbeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const fingerprint = value => createHash('sha256').update(value).digest('hex');

// Decode only terminated entities: html.unescape-like decoding corrupts &timestamp.
export function entities(value = '') {
  return String(value).replace(/&(amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, (full, key) => {
    const known = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    const lower = key.toLowerCase();
    if (lower in known) return known[lower];
    const number = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : full;
  });
}

export function wechatUrl(input) {
  let url;
  try { url = new URL(entities(input)); } catch { throw new ProbeError('INVALID_URL', '需要有效的微信公众号文章链接。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password) {
    throw new ProbeError('INVALID_URL', '仅接受 HTTPS 的 mp.weixin.qq.com 链接。');
  }
  return url;
}

export function publicArticleUrl(input) {
  const url = wechatUrl(String(input).replace(/^http:\/\/mp\.weixin\.qq\.com\//i, 'https://mp.weixin.qq.com/'));
  if (!/^\/s(?:\/[^/]+)?$/.test(url.pathname)) throw new ProbeError('INVALID_URL', '链接不是微信文章地址。');
  const clean = new URL(url.origin + url.pathname);
  for (const key of ['__biz', 'mid', 'idx', 'sn', 'chksm']) {
    if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key));
  }
  if (url.pathname === '/s' && (!clean.searchParams.get('__biz') || !clean.searchParams.get('mid'))) {
    throw new ProbeError('INVALID_URL', '长文章链接缺少公众号或文章标识。');
  }
  return clean.href;
}

export function historyHome(biz) {
  const url = new URL('https://mp.weixin.qq.com/mp/profile_ext');
  url.search = new URLSearchParams({ action: 'home', __biz: biz, scene: '124' });
  url.hash = 'wechat_redirect';
  return url.href;
}

function textOnly(html) {
  return entities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function parseArticle(html, source) {
  const url = wechatUrl(source);
  if (/secitptpage\/(?:template\/)?verify(?:\.html|\.js|\d+\.)/i.test(html) || /id=["']js_verify["']/i.test(html)) {
    throw new ProbeError('VERIFICATION_REQUIRED', '微信要求完成验证，请先在微信中正常打开文章。');
  }
  const extract = (...patterns) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return textOnly(match[1]);
    }
    return '';
  };
  const biz = url.searchParams.get('__biz') || extract(
    /(?:var\s+|window\.)biz\s*=\s*["']([A-Za-z0-9+/=]+)["']/,
    /["']biz["']\s*:\s*["']([A-Za-z0-9+/=]+)["']/,
    /__biz=([A-Za-z0-9%+/=]+)[&"']/,
  );
  if (!biz) {
    const challenged = /环境异常|完成验证|访问过于频繁|js_verify|访问过于频繁/.test(html);
    throw new ProbeError(challenged ? 'VERIFICATION_REQUIRED' : 'ARTICLE_ID_MISSING', challenged
      ? '微信返回了验证页面，需要先在微信中正常打开文章。'
      : '文章页面未返回公众号标识，不能继续猜测目标账号。');
  }
  let decodedBiz;
  try { decodedBiz = decodeURIComponent(biz); } catch { throw new ProbeError('ARTICLE_ID_MISSING', '公众号标识编码异常。'); }
  if (!/^[A-Za-z0-9+/=]{4,128}$/.test(decodedBiz)) throw new ProbeError('ARTICLE_ID_MISSING', '公众号标识格式异常。');
  return {
    source: publicArticleUrl(source), biz: decodedBiz,
    title: extract(/<h1[^>]*id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i,
      /<meta\s+property=["']og:title["']\s+content=["']([^"']*)/i,
      /(?:var\s+msg_title|window\.title)\s*=\s*["']([^"']+)/,
      /\btitle:\s*'([^']+)'/),
    nickname: extract(/<[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\//i,
      /<[^>]*id=["']profile_nickname["'][^>]*>([\s\S]*?)<\//i,
      /var\s+nickname\s*=\s*(?:htmlDecode\()?\s*["']([^"']+)/,
      /\bnick_name:\s*'([^']+)'/),
    publishedAt: extract(/var\s+ct\s*=\s*["']?(\d{9,11})/),
    authorId: extract(/(?:["']?(?:author_id|authorId|user_name)["']?)\s*[:=]\s*["'](gh_[A-Za-z0-9_]+)["']/),
  };
}

export function candidateFromUrl(raw, targetBiz) {
  let url;
  try {
    url = wechatUrl(raw.replace(/\\u0026/gi, '&').replace(/\\\//g, '/'));
  } catch { return null; }
  if (url.searchParams.get('__biz') !== targetBiz) return null;
  const names = ['uin', 'key', 'pass_ticket', 'appmsg_token', 'poc_token', 'poc_sid', 'wxtoken', 'scene', 'devicetype', 'version', 'lang', 'exportkey', 'author_id'];
  const fields = Object.fromEntries(names.filter(key => url.searchParams.get(key)).map(key => [key, url.searchParams.get(key)]));
  if (!(fields.uin && fields.key && fields.pass_ticket) && !(fields.appmsg_token && fields.pass_ticket)) return null;
  return { fields, requestUrl: url.href, identity: fingerprint(JSON.stringify(fields)) };
}

export function candidatesFromBytes(bytes, biz) {
  const found = new Map();
  // Chromium disk-cache keys can contain ASCII or UTF-16 strings.
  for (const encoding of ['latin1', 'utf16le']) {
    const text = bytes.toString(encoding).replace(/\\\//g, '/');
    for (const match of text.matchAll(/https:\/\/mp\.weixin\.qq\.com[^\s<>"'\x00-\x1f\x7f-\xff]{1,16384}/g)) {
      const candidate = candidateFromUrl(match[0], biz);
      if (candidate) found.set(candidate.identity, candidate);
    }
  }
  return [...found.values()];
}

export class WechatHttp {
  constructor({ intervalMs = 3500, timeoutMs = 25000, fetchImpl = globalThis.fetch } = {}) {
    this.intervalMs = intervalMs; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl; this.last = 0;
  }
  async get(input, headers = {}) {
    let url = wechatUrl(input);
    let transientRetried = false;
    for (let redirects = 0; redirects < 4; redirects++) {
      await wait(Math.max(0, this.last + this.intervalMs - Date.now()));
      this.last = Date.now();
      let response;
      try {
        response = await this.fetchImpl(url, {
          redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 MicroMessenger/4.1.6.14', ...headers },
        });
      } catch { throw new ProbeError('NETWORK_ERROR', '连接微信失败或超时。'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new ProbeError('REMOTE_ERROR', '微信返回无目标地址的跳转。');
        url = wechatUrl(new URL(location, url).href);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        if ([502, 503, 504].includes(response.status) && !transientRetried) {
          transientRetried = true;
          await wait(10000);
          continue;
        }
        throw new ProbeError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', '微信请求未成功。', { status: response.status });
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new ProbeError('RESPONSE_TOO_LARGE', '微信响应超过原型的大小限制。');
        chunks.push(Buffer.from(chunk));
      }
      return { body: Buffer.concat(chunks).toString('utf8'), cookies: response.headers.getSetCookie?.() || [], contentType: response.headers.get('content-type') || '' };
    }
    throw new ProbeError('REDIRECT_LOOP', '微信页面跳转次数异常。');
  }
}

function authCookie(fields) {
  const pairs = new Map(Object.entries(fields.cookieJar || {}));
  if (!pairs.has('wxtokenkey')) pairs.set('wxtokenkey', '777');
  for (const key of ['pass_ticket', 'poc_sid', 'wxtokenkey']) if (fields[key]) pairs.set(key, fields[key]);
  return [...pairs].map(([key, value]) => `${key}=${value}`).join('; ');
}

function collectCookies(fields, cookies) {
  fields.cookieJar ||= {};
  for (const raw of cookies) {
    const match = raw.match(/^([^=;\s]+)=([^;]*)/);
    if (match) fields.cookieJar[match[1]] = match[2];
  }
}

export class HistoryProvider {
  constructor(http) { this.http = http; }
  async prepare(biz, candidate) {
    const fields = { ...candidate.fields };
    const referer = wechatUrl(historyHome(biz)); referer.hash = '';
    for (const key of ['uin', 'key', 'pass_ticket', 'devicetype', 'version', 'lang']) if (fields[key]) referer.searchParams.set(key, fields[key]);
    fields.referer = referer.href;
    if (!fields.poc_token && fields.uin && fields.key && fields.pass_ticket) {
      const url = wechatUrl(historyHome(biz)); url.hash = '';
      for (const key of ['uin', 'key', 'pass_ticket', 'devicetype', 'version', 'lang']) if (fields[key]) url.searchParams.set(key, fields[key]);
      const result = await this.http.get(url.href, { Cookie: authCookie(fields) });
      collectCookies(fields, result.cookies);
      const token = result.body.match(/poc_token\s*[:=]\s*["']([^"']+)["']/);
      if (token) fields.poc_token = token[1];
      for (const rawCookie of result.cookies) {
        const match = rawCookie.match(/^poc_sid=([^;]+)/);
        if (match) fields.poc_sid = match[1];
      }
    }
    return fields;
  }
  async page(biz, fields, offset) {
    const url = new URL('https://mp.weixin.qq.com/mp/profile_ext');
    url.search = new URLSearchParams({ action: 'getmsg', __biz: biz, f: 'json', offset: String(offset), count: '10', scene: '124', is_ok: '1', x5: '0' });
    for (const key of ['uin', 'key', 'pass_ticket', 'appmsg_token', 'poc_token', 'wxtoken', 'devicetype', 'version', 'lang']) if (fields[key]) url.searchParams.set(key, fields[key]);
    const response = await this.http.get(url.href, { Referer: fields.referer || historyHome(biz), Cookie: authCookie(fields), Accept: 'application/json,text/plain,*/*', 'X-Requested-With': 'XMLHttpRequest' });
    let payload;
    try { payload = JSON.parse(response.body); } catch { throw new ProbeError('AUTH_REQUIRED', '历史接口未返回 JSON，可能需要重新登录或完成验证。'); }
    return parseHistoryPage(payload, biz, offset);
  }
}

export class AuthorProvider {
  constructor(http, authorId = '') { this.http = http; this.authorId = authorId; }
  async prepare(biz, candidate) {
    const fields = { ...candidate.fields };
    if (fields.appmsg_token && (fields.author_id || this.authorId)) {
      fields.author_id ||= this.authorId;
      if (candidate.requestUrl) {
        const page = await this.http.get(candidate.requestUrl);
        collectCookies(fields, page.cookies);
        const token = page.body.match(/(?:["']?appmsg_token["']?)\s*[:=]\s*["']([^"']+)["']/);
        if (token?.[1]) fields.appmsg_token = token[1];
      }
      return fields;
    }
    const url = new URL('https://mp.weixin.qq.com/mp/author');
    url.search = new URLSearchParams({ action: 'show', __biz: biz, idx: '1', scene: '142', rscene: '128', acctmode: '0' });
    if (fields.author_id || this.authorId) url.searchParams.set('author_id', fields.author_id || this.authorId);
    for (const key of ['uin', 'key', 'pass_ticket', 'devicetype', 'version', 'lang', 'exportkey', 'appmsg_token']) if (fields[key]) url.searchParams.set(key, fields[key]);
    const response = await this.http.get(url.href, { Cookie: authCookie(fields) });
    collectCookies(fields, response.cookies);
    const author = response.body.match(/(?:["']?(?:author_id|authorId|user_name)["']?)\s*[:=]\s*["']([^"']+)["']/);
    const token = response.body.match(/(?:["']?appmsg_token["']?)\s*[:=]\s*["']([^"']+)["']/);
    fields.author_id = author?.[1] || fields.author_id || this.authorId;
    if (token?.[1]) fields.appmsg_token = token[1];
    if (!fields.author_id || !fields.appmsg_token) throw new ProbeError('AUTHOR_CONTEXT_MISSING', '新版主页没有返回足够的文章列表参数。', {
      authorIdPresent: Boolean(fields.author_id), appmsgTokenPresent: Boolean(fields.appmsg_token),
      cookieNames: Object.keys(fields.cookieJar), verificationPage: /环境异常|完成验证|js_verify/.test(response.body),
    });
    return fields;
  }
  async page(biz, fields, cursor = '') {
    const url = new URL('https://mp.weixin.qq.com/mp/author');
    url.search = new URLSearchParams({ action: 'get_articles', author_id: fields.author_id, scene: '142', limit: '30',
      version: 'undefined', appmsg_token: fields.appmsg_token, x5: '0', f: 'json', user_article_role: '0', });
    if (cursor) url.searchParams.set('from_article_id', String(cursor));
    const referer = new URL('https://mp.weixin.qq.com/mp/author');
    referer.search = new URLSearchParams({ action: 'show', __biz: biz, author_id: fields.author_id, idx: '1', scene: '142', rscene: '128', acctmode: '0' });
    for (const key of ['uin', 'key', 'pass_ticket', 'devicetype', 'version', 'lang']) if (fields[key]) referer.searchParams.set(key, fields[key]);
    const response = await this.http.get(url.href, { Cookie: authCookie(fields), Referer: referer.href, Accept: 'application/json,text/plain,*/*', 'X-Requested-With': 'XMLHttpRequest' });
    let payload;
    try { payload = JSON.parse(response.body); } catch { throw new ProbeError('AUTH_REQUIRED', '新版历史接口未返回 JSON。', { contentType: response.contentType, bytes: Buffer.byteLength(response.body), verificationPage: /环境异常|完成验证|js_verify/.test(response.body), clientRequired: /请在微信|微信客户端/.test(response.body) }); }
    return parseAuthorPage(payload, biz, cursor);
  }
}

export function parseAuthorPage(payload, biz, cursor) {
  const codes = [payload?.ret, payload?.base_resp?.ret].filter(value => value !== undefined);
  if (!codes.length || codes.some(value => Number(value) !== 0)) {
    const ret = codes.find(value => Number(value) !== 0);
    throw new ProbeError(Number(ret) === -3 ? 'AUTH_REQUIRED' : Number(ret) === 200013 ? 'RATE_LIMITED' : 'REMOTE_ERROR', '新版历史请求没有成功。', { ret: typeof ret === 'number' ? ret : 'missing_or_unknown' });
  }
  if (!Array.isArray(payload.articles)) throw new ProbeError('INVALID_HISTORY', '新版历史接口缺少文章数组。');
  const articles = []; let unresolved = 0;
  for (const item of payload.articles) {
    if (item.__biz && item.__biz !== biz) throw new ProbeError('ACCOUNT_MISMATCH', '新版列表返回其他公众号。');
    let url;
    try { url = publicArticleUrl(item.url); } catch { unresolved++; continue; }
    const articleBiz = new URL(url).searchParams.get('__biz');
    if (articleBiz && articleBiz !== biz) throw new ProbeError('ACCOUNT_MISMATCH', '文章链接不属于目标公众号。');
    const timestamp = Number(item.publish_time);
    articles.push({ id: articleIdentity(url), title: textOnly(item.title), url,
      publishedAt: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
      deleted: false, isPaid: Boolean(item.is_paid || item.is_pay_subscribe) });
  }
  const lastMid = payload.articles.at(-1)?.mid;
  return { offset: cursor, articles, messageCount: payload.articles.length, unresolved,
    nextOffset: lastMid && String(lastMid) !== String(cursor) ? String(lastMid) : null,
    canContinue: payload.articles.length ? null : false,
    responseFields: Object.keys(payload).sort() };
}

export function articleIdentity(url) {
  const parsed = wechatUrl(url);
  const biz = parsed.searchParams.get('__biz'); const mid = parsed.searchParams.get('mid');
  return biz && mid ? `${biz}:${mid}:${parsed.searchParams.get('idx') || '1'}` : publicArticleUrl(url);
}

export function parseHistoryPage(payload, biz, offset) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProbeError('INVALID_HISTORY', '历史响应结构异常。');
  const codes = [payload.ret, payload.base_resp?.ret].filter(value => value !== undefined);
  const ret = codes.find(value => value !== 0 && value !== '0') ?? codes[0];
  if (ret !== 0 && ret !== '0') {
    const code = [-3, -6, -8, -13].includes(Number(ret)) ? 'AUTH_REQUIRED' : [200013, 200014].includes(Number(ret)) ? 'RATE_LIMITED' : 'REMOTE_ERROR';
    throw new ProbeError(code, '微信没有接受历史列表请求。', { ret: typeof ret === 'number' || /^-?\d+$/.test(ret) ? Number(ret) : 'missing_or_unknown' });
  }
  let messages = payload.general_msg_list;
  if (typeof messages === 'string') {
    try { messages = JSON.parse(messages); } catch { throw new ProbeError('INVALID_HISTORY', '历史列表 JSON 不完整。'); }
  }
  if (!messages || !Array.isArray(messages.list)) throw new ProbeError('INVALID_HISTORY', '未识别到历史列表，不能当作空账号。');
  const articles = []; let unresolved = 0;
  for (const item of messages.list) {
    const ext = item.app_msg_ext_info;
    if (!ext) { unresolved++; continue; }
    for (const article of [ext, ...(Array.isArray(ext.multi_app_msg_item_list) ? ext.multi_app_msg_item_list : [])]) {
      if (!article.content_url) { unresolved++; continue; }
      let url;
      try { url = publicArticleUrl(article.content_url); } catch { unresolved++; continue; }
      const articleBiz = new URL(url).searchParams.get('__biz');
      if (articleBiz && articleBiz !== biz) throw new ProbeError('ACCOUNT_MISMATCH', '历史列表混入了其他公众号，已停止。');
      const timestamp = Number(item.comm_msg_info?.datetime);
      articles.push({ id: articleIdentity(url), title: textOnly(article.title), url,
        publishedAt: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
        sourceDeleteFlag: article.del_flag ?? null,
      });
    }
  }
  const rawNext = payload.next_offset; const next = Number(rawNext);
  const rawContinue = payload.can_msg_continue;
  const canContinue = rawContinue === 1 || rawContinue === '1' ? true : rawContinue === 0 || rawContinue === '0' ? false : null;
  return { offset, articles, messageCount: messages.list.length, unresolved,
    nextOffset: rawNext !== undefined && Number.isInteger(next) && next > offset ? next : null,
    canContinue, responseFields: Object.keys(payload).sort(),
  };
}

export async function enumerateHistory({ firstPage, fetchPage, onPage = async () => {}, maxPages = 2000, initialArticles = [] }) {
  const articles = new Map(initialArticles.map(article => [article.id, article]));
  const pages = []; const signatures = new Set(); const offsets = new Set(); let page = firstPage;
    let unresolved = 0;
  for (let n = 0; n < maxPages; n++) {
    if (offsets.has(page.offset)) throw new ProbeError('PAGINATION_LOOP', '历史列表游标重复，任务未完成。');
    offsets.add(page.offset);
    const signature = fingerprint(page.articles.map(article => article.id).join('\n'));
    if (page.messageCount && page.articles.length && signatures.has(signature)) throw new ProbeError('PAGINATION_LOOP', '不同分页返回了相同文章，任务未完成。');
    if (page.articles.length) signatures.add(signature);
    let added = 0;
    for (const article of page.articles) { if (!articles.has(article.id)) added++; articles.set(article.id, article); }
    unresolved += page.unresolved;
    const evidence = { offset: page.offset, nextOffset: page.nextOffset, canContinue: page.canContinue,
      messageCount: page.messageCount, articleCount: page.articles.length, added, unresolved: page.unresolved, signature };
    pages.push(evidence);
    const emptyEnd = page.messageCount === 0 && page.canContinue === false;
    // Missing/contradictory pagination metadata is uncertainty, never success.
    const endpointEnd = emptyEnd || (page.messageCount > 0 && page.canContinue === false && page.nextOffset === null);
    await onPage({ articles: [...articles.values()], evidence, pages, unresolved, endpointEnd });
    if (endpointEnd) return { articles: [...articles.values()], pages, unresolved, endpointEnd: true,
      coverage: 'ENDPOINT_EXHAUSTED_UNVERIFIED', endReason: emptyEnd ? 'explicit_empty_end' : 'explicit_nonadvancing_end' };
    if (page.messageCount === 0 || page.nextOffset === null) throw new ProbeError('PAGINATION_UNCERTAIN', '接口分页信号矛盾，不能认定已拉完。');
    if (n + 1 >= maxPages) throw new ProbeError('PAGE_LIMIT', '已达到分页上限，任务仍不完整。');
    page = await fetchPage(page.nextOffset);
  }
  throw new ProbeError('PAGE_LIMIT', '分页上限必须大于零。');
}
