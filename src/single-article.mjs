import { parseHTML } from 'linkedom';
import { parseExpressionAt } from 'acorn';
import { articleIdentity, entities, parseArticle, ProbeError, publicArticleUrl } from './core.mjs';

function scalar(node) {
  if (node?.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) return node.value;
  if (node?.type === 'LogicalExpression' && node.operator === '||') {
    const left = scalar(node.left); const right = scalar(node.right);
    if (left !== undefined && right !== undefined) return left || right;
  }
}
function field(node, key) {
  return node?.type === 'ObjectExpression' ? node.properties.find(property =>
    property.type === 'Property' && !property.computed && !property.method && property.kind === 'init'
    && (property.key.name || property.key.value) === key)?.value : undefined;
}

// Inspect only literal page metadata; remote scripts are never executed.
export function singleArticle(html, input) {
  const source = publicArticleUrl(input);
  const account = parseArticle(html, source);
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll('link[rel="canonical"],meta[property="og:url"]')]
    .map(node => node.getAttribute('href') || node.getAttribute('content')).filter(Boolean);
  const values = {};
  for (const script of document.querySelectorAll('script:not([src])')) {
    const text = script.textContent;
    if (text.length > 1024 * 1024) continue;
    for (const match of text.matchAll(/\b(?:var\s+|let\s+|const\s+|window\.)(biz|mid|appmsgid|idx|itemidx|sn|ct|msg_link|cgiDataNew)\s*=\s*/g)) {
      let node;
      try { node = parseExpressionAt(text, match.index + match[0].length, { ecmaVersion: 2022 }); } catch { continue; }
      if (match[1] === 'cgiDataNew') {
        const link = scalar(field(node, 'link'));
        if (typeof link === 'string' && link) links.push(link);
      } else {
        const value = scalar(node);
        if (value !== undefined && values[match[1]] === undefined) values[match[1]] = String(value);
      }
    }
  }
  if (values.biz && values.biz !== account.biz) throw new ProbeError('ACCOUNT_MISMATCH', '文章页面与链接中的公众号不一致，已停止保存。');
  if (values.msg_link) links.push(values.msg_link);
  const mid = values.mid || values.appmsgid;
  const idx = values.idx || values.itemidx;
  if (/^\d{1,20}$/.test(mid || '') && /^\d{1,3}$/.test(idx || '') && Number(idx) > 0) {
    const url = new URL('https://mp.weixin.qq.com/s');
    url.search = new URLSearchParams({ __biz: account.biz, mid, idx });
    if (/^[a-f\d]{32}$/i.test(values.sn || '')) url.searchParams.set('sn', values.sn);
    links.push(url.href);
  }
  let identity = new URL(source).searchParams.get('mid') ? articleIdentity(source) : null;
  for (const link of links) {
    let canonical;
    try { canonical = publicArticleUrl(entities(link)); } catch { continue; }
    const parsed = new URL(canonical);
    if (!parsed.searchParams.get('mid')) continue;
    if (parsed.searchParams.get('__biz') !== account.biz) throw new ProbeError('ACCOUNT_MISMATCH', '文章页面的公众号标识不一致，已停止保存。');
    const candidateId = articleIdentity(canonical);
    if (identity && candidateId !== identity) throw new ProbeError('ARTICLE_MISMATCH', '文章页面与链接中的文章标识不一致，已停止保存。');
    // Preserve the original public URL; use page metadata only to unify short/long link IDs.
    identity = candidateId;
  }
  const seconds = Number(values.ct || account.publishedAt);
  const date = new Date(seconds * 1000);
  account.nickname ||= account.biz;
  return { account, article: { id: identity || articleIdentity(source), url: source,
    title: account.title || '未命名文章',
    publishedAt: seconds > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null } };
}
