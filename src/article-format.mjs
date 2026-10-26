import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { fingerprint, parseArticle, ProbeError, publicArticleUrl, wait } from './core.mjs';
import { sharedContent } from './share-content.mjs';
import { prepareReadingLayout, addReadingRules, tidyMarkdown } from './reading-layout.mjs';

export function safeName(value, maxLength = 80) {
  const name = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, maxLength) || '未命名';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

export function noteName(article) {
  const date = article.publishedAt ? new Date(new Date(article.publishedAt).getTime() + 8 * 3600000).toISOString().slice(0, 10) : '日期未知';
  return `${date} ${safeName(article.title)} [${fingerprint(article.id).slice(0, 10)}].md`;
}

export function imageUrl(input) {
  let url;
  try { url = new URL(input.startsWith('//') ? 'https:' + input : input); } catch { throw new ProbeError('IMAGE_URL_INVALID', '图片地址无效。'); }
  if (url.protocol === 'http:' && /(^|\.)qpic\.cn$/.test(url.hostname)) url.protocol = 'https:';
  const hostAllowed = ['qpic.cn', 'qlogo.cn', 'res.wx.qq.com', 'mmbiz.qlogo.cn'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  if (!hostAllowed || url.protocol !== 'https:' || url.port || url.username || url.password) throw new ProbeError('IMAGE_HOST_NOT_ALLOWED', '图片不属于允许下载的微信图片域名。');
  return url;
}

export class ImageClient {
  constructor(fetchImpl = globalThis.fetch) { this.fetchImpl = fetchImpl; this.last = 0; }
  async get(input) {
    let url = imageUrl(input);
    for (let hop = 0; hop < 3; hop++) {
      await wait(Math.max(0, this.last + 200 - Date.now())); this.last = Date.now();
      let response;
      try { response = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { Referer: 'https://mp.weixin.qq.com/' } }); }
      catch { throw new ProbeError('IMAGE_NETWORK_ERROR', '图片连接失败。'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new ProbeError('IMAGE_REDIRECT', '图片跳转异常。');
        url = imageUrl(new URL(location, url).href); continue;
      }
      if (response.status !== 200) { await response.body?.cancel(); throw new ProbeError('IMAGE_HTTP_ERROR', '图片请求失败。', { status: response.status }); }
      const type = response.headers.get('content-type')?.split(';')[0].toLowerCase();
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }[type];
      if (!extension) { await response.body?.cancel(); throw new ProbeError('IMAGE_TYPE_UNSUPPORTED', '图片格式未获支持。'); }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024) throw new ProbeError('IMAGE_TOO_LARGE', '图片超过 20 MB。');
        chunks.push(Buffer.from(chunk));
      }
      return { data: Buffer.concat(chunks), extension };
    }
    throw new ProbeError('IMAGE_REDIRECT', '图片跳转次数过多。');
  }
}

export async function formatArticle({ html, article, account, saveImage, stop = () => false }) {
  const metadata = parseArticle(html, article.url);
  if (metadata.biz !== account.biz) throw new ProbeError('ACCOUNT_MISMATCH', '正文公众号与任务目标不符。');
  const { document } = parseHTML(html);
  let content = document.querySelector('#js_content');
  if (!content && /\/assets\/private(?:-legacy)?[.-][^"'<>]+\.js/.test(html)) {
    throw new ProbeError('ARTICLE_PRIVATE', '根据作者隐私设置，无法查看该内容。');
  }
  const shared = !content ? sharedContent(document, article) : null;
  content ||= shared?.content;
  if (!content || !content.textContent.trim() && !content.querySelector('img')) throw new ProbeError('BODY_UNAVAILABLE', '没有取得可归档的文章正文。');
  content.querySelectorAll('script,style,link,meta,form,input,button').forEach(element => element.remove());
  const warnings = [...(shared?.warnings || [])]; let imagesSaved = 0;
  for (const element of content.querySelectorAll('iframe,video,audio')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = '[此处包含音视频或嵌入内容，请通过原文链接查看]'; element.replaceWith(paragraph);
    warnings.push('EMBEDDED_MEDIA_ORIGINAL_ONLY');
  }
  const layout = prepareReadingLayout(content);
  for (const img of content.querySelectorAll('img')) {
    if (stop()) throw new ProbeError('CANCELLED', '用户已停止任务。');
    const source = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src');
    if (!source) { img.remove(); continue; }
    try {
      if (!saveImage) throw new ProbeError('IMAGE_REMOTE_ONLY', '本次保留远程图片。');
      const local = await saveImage(imageUrl(source).href); img.setAttribute('src', local); imagesSaved++;
    } catch (error) {
      if (error.code === 'CANCELLED') throw error;
      warnings.push(error.code || 'IMAGE_FAILED');
      try { img.setAttribute('src', imageUrl(source).href); }
      catch { const span = document.createElement('span'); span.textContent = '[图片未归档]'; img.replaceWith(span); }
    }
  }
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  addReadingRules(service);
  service.addRule('table', { filter: 'table', replacement: (_content, node) => {
    const rows = [...node.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => service.turndown(cell.innerHTML).trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map(row => row.length));
    const line = row => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
    return '\n\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
  } });
  const body = tidyMarkdown(service.turndown(content));
  if (body.trim().length < 20) warnings.push('SHORT_BODY_REVIEW');
  const frontmatter = { title: article.title || metadata.title, wechat_account: account.nickname, source: publicArticleUrl(article.url),
    published: article.publishedAt, article_id: article.id, archived_at: new Date().toISOString(), archive_format: 'reading-v2' };
  const header = '---\n' + Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value ?? '')}`).join('\n') + '\n---\n';
  return { markdown: header + `\n# ${frontmatter.title}\n\n` + body + `\n\n---\n[查看微信原文](${frontmatter.source})\n`,
    imagesSaved, warnings: [...new Set(warnings)], textLength: content.textContent.trim().length, layout };
}
