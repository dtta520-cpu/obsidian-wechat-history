import { parseExpressionAt } from 'acorn';
import { articleIdentity, publicArticleUrl } from './core.mjs';

function field(node, key) {
  return node?.type === 'ObjectExpression' ? node.properties.find(property =>
    property.type === 'Property' && !property.computed && !property.method && property.kind === 'init' &&
    (property.key.name || property.key.value) === key)?.value : undefined;
}
const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : '';

// Read only literal values from the public page. Never execute remote JavaScript.
export function sharedContent(document, article) {
  for (const script of document.querySelectorAll('script:not([src])')) {
    const text = script.textContent;
    const match = /\bwindow\.cgiDataNew\s*=\s*/.exec(text);
    if (!match || text.length > 1024 * 1024) continue;
    let data;
    try { data = parseExpressionAt(text, match.index + match[0].length, { ecmaVersion: 2022 }); }
    catch { continue; }
    if (data.type !== 'ObjectExpression') continue;
    const source = literal(field(data, 'link'));
    try { if (articleIdentity(publicArticleUrl(source)) !== article.id) continue; } catch { continue; }
    const body = literal(field(data, 'content_noencode'));
    const pictures = field(data, 'picture_page_info_list');
    const urls = pictures?.type === 'ArrayExpression' ? pictures.elements.map(item => literal(field(item, 'cdn_url'))).filter(Boolean) : [];
    if (!body.trim() && !urls.length) continue;
    const container = document.createElement('section');
    for (const url of urls) {
      const img = document.createElement('img'); img.setAttribute('data-src', url); container.append(img);
    }
    const content = document.createElement('section');
    if (/<(?:section|p|div|span|br|h[1-6])(?:\s|>)/i.test(body)) content.innerHTML = body.replace(/\r?\n/g, '<br>');
    else for (const line of body.split(/\r?\n/)) {
      const p = document.createElement('p'); p.textContent = line; content.append(p);
    }
    container.append(content);
    const audio = [...document.querySelectorAll('script[src]')].some(item => /common_share_audio[.]/.test(item.getAttribute('src')));
    if (audio) {
      const note = document.createElement('p');
      note.textContent = '[此条为音频内容：已保存页面文字介绍，音频请通过原文链接收听]';
      container.append(note);
    }
    return { content: container, warnings: audio ? ['AUDIO_ORIGINAL_ONLY'] : [] };
  }
  return null;
}
