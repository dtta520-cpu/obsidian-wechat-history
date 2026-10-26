import { ProbeError, wechatUrl, publicArticleUrl, articleIdentity, entities, enumerateHistory } from './core.mjs';

const cleanText = value => entities(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function catalogSource(input) {
  const url = wechatUrl(String(input).trim().replace(/^http:\/\/mp\.weixin\.qq\.com\//i, 'https://mp.weixin.qq.com/'));
  if (url.pathname !== '/mp/appmsgalbum') return { type: 'history', source: publicArticleUrl(url.href) };
  const biz = url.searchParams.get('__biz'); const albumId = url.searchParams.get('album_id');
  if (!/^[A-Za-z0-9+/=]{4,128}$/.test(biz || '') || !/^\d{5,30}$/.test(albumId || '')) {
    throw new ProbeError('INVALID_ALBUM_URL', '合集链接缺少有效的公众号或合集标识，请复制完整的微信合集链接。');
  }
  const source = new URL('https://mp.weixin.qq.com/mp/appmsgalbum');
  source.search = new URLSearchParams({ action: 'getalbum', __biz: biz, album_id: albumId });
  return { type: 'album', source: source.href, biz, albumId };
}

export function parseAlbumPage(payload, target, cursor = '') {
  const codes = [payload?.ret, payload?.base_resp?.ret].filter(value => value !== undefined);
  const ret = codes.find(value => value !== 0 && value !== '0') ?? codes[0];
  if (ret !== 0 && ret !== '0') {
    const code = [200013, 200014].includes(Number(ret)) ? 'RATE_LIMITED'
      : [-3, -6, -8, -13].includes(Number(ret)) ? 'ALBUM_ACCESS_REQUIRED' : 'INVALID_ALBUM';
    throw new ProbeError(code, '微信没有返回可用的合集目录，请确认合集仍可正常打开。');
  }
  const data = payload?.getalbum_resp;
  if (!data || typeof data !== 'object') throw new ProbeError('INVALID_ALBUM', '合集响应结构异常，不能当作空目录。');
  // Only the first page carries title, account and total; later pages can contain just is_first_screen.
  const info = data.base_info || {};
  if (!cursor && (!cleanText(info.title) || !cleanText(info.nickname))) throw new ProbeError('INVALID_ALBUM', '合集缺少名称或公众号信息。');
  const rawCount = info.article_count;
  const expectedTotal = /^\d+$/.test(String(rawCount)) && Number.isSafeInteger(Number(rawCount)) ? Number(rawCount) : null;
  const flag = data.continue_flag;
  const canContinue = flag === 1 || flag === '1' ? true : flag === 0 || flag === '0' ? false : null;
  if (canContinue === null) throw new ProbeError('PAGINATION_UNCERTAIN', '合集缺少明确的翻页标记，不能认定目录完整。');
  let list = data.article_list;
  if (list === undefined && expectedTotal === 0 && canContinue === false) list = [];
  if (list && !Array.isArray(list) && typeof list === 'object') list = 'url' in list ? [list] : Object.values(list);
  if (!Array.isArray(list)) throw new ProbeError('INVALID_ALBUM', '未识别到合集文章列表，不能当作空目录。');
  const articles = list.map(item => {
    if (!item || typeof item.url !== 'string' || !/^\d+$/.test(String(item.msgid)) || !/^\d+$/.test(String(item.itemidx))) {
      throw new ProbeError('INVALID_ALBUM', '合集条目缺少文章地址或分页标识。');
    }
    const url = publicArticleUrl(item.url); const parsed = new URL(url);
    if (parsed.searchParams.get('__biz') !== target.biz) throw new ProbeError('ACCOUNT_MISMATCH', '合集条目属于其他公众号，已停止。');
    if (parsed.searchParams.get('mid') !== String(item.msgid) || (parsed.searchParams.get('idx') || '1') !== String(item.itemidx)) {
      throw new ProbeError('INVALID_ALBUM', '合集文章标识与原文链接不一致，已停止。');
    }
    const seconds = Number(item.create_time); const date = new Date(seconds * 1000);
    return { id: articleIdentity(url), title: cleanText(item.title) || '未命名文章', url,
      publishedAt: seconds > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null };
  });
  const last = list.at(-1);
  if (canContinue && !last) throw new ProbeError('PAGINATION_UNCERTAIN', '合集返回空页但仍要求翻页，已停止。');
  return { articles, offset: cursor, nextOffset: canContinue ? `${last.msgid}:${last.itemidx}` : null, canContinue,
    messageCount: list.length, unresolved: 0, expectedTotal,
    account: { biz: target.biz, nickname: cleanText(info.nickname), authorId: /^gh_[A-Za-z0-9_]+$/.test(info.username || '') ? info.username : '' },
    scope: { type: 'album', id: target.albumId, title: cleanText(info.title), url: target.source, reportedTotal: expectedTotal },
  };
}

export class AlbumProvider {
  constructor(http) { this.http = http; }
  async page(target, cursor = '') {
    const url = new URL(target.source);
    url.searchParams.set('count', '20'); url.searchParams.set('f', 'json');
    if (cursor) {
      if (!/^\d+:\d+$/.test(cursor)) throw new ProbeError('INVALID_ALBUM', '合集分页标识无效。');
      const [mid, idx] = cursor.split(':');
      url.searchParams.set('begin_msgid', mid); url.searchParams.set('begin_itemidx', idx);
    }
    const { body } = await this.http.get(url.href, { 'X-Requested-With': 'XMLHttpRequest' });
    let payload;
    try { payload = JSON.parse(body); } catch {
      throw new ProbeError(/验证|secitptpage|js_verify/.test(body) ? 'VERIFICATION_REQUIRED' : 'INVALID_ALBUM', '未取得合集目录，请在微信中确认链接可正常打开。');
    }
    return parseAlbumPage(payload, target, cursor);
  }
}

export async function enumerateAlbum({ provider, target, firstPage, onPage, checkStop = () => {}, maxPages = 2000 }) {
  const history = await enumerateHistory({ firstPage, maxPages, onPage,
    fetchPage: async cursor => {
      checkStop();
      const page = await provider.page(target, cursor);
      if (page.expectedTotal !== null && firstPage.expectedTotal !== null && page.expectedTotal !== firstPage.expectedTotal) throw new ProbeError('ALBUM_CHANGED', '合集篇数在读取期间发生变化，请刷新目录重试。');
      return page;
    },
  });
  if (firstPage.expectedTotal !== null && history.articles.length !== firstPage.expectedTotal) {
    throw new ProbeError('ALBUM_COUNT_MISMATCH', `合集显示 ${firstPage.expectedTotal} 篇，实际读到 ${history.articles.length} 篇，目录未通过完整性核对，请稍后刷新。`);
  }
  return { ...history, coverage: 'ALBUM_ENDPOINT_EXHAUSTED', countVerified: firstPage.expectedTotal !== null };
}
