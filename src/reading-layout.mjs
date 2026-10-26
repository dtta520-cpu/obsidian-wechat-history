const compact = value => value.replace(/[\s\u200b\ufeff]+/g, '');
const declaration = (node, property) => node.getAttribute?.('style')?.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.replace(/!important/g, '').trim() || '';

export function prepareReadingLayout(content) {
  let symbolGlyphsConverted = 0;
  for (const node of content.querySelectorAll('[style]')) {
    if (/^["']?Wingdings["']?(?:,|$)/i.test(declaration(node, 'font-family')) && node.textContent.trim() === 'ü') {
      node.textContent = node.textContent.replace('ü', '✓'); symbolGlyphsConverted++;
    }
  }
  const textBefore = compact(content.textContent);
  let emptyBlocksRemoved = 0; let inlineRows = 0;
  for (const img of content.querySelectorAll('img')) {
    let width = Number.parseFloat(img.getAttribute('width'));
    const ownWidth = declaration(img, 'width');
    if (/^[\d.]+px$/.test(ownWidth)) width = parseFloat(ownWidth);
    if (!Number.isFinite(width)) {
      let parent = img.parentElement;
      for (let hop = 0; parent && parent !== content && hop < 6; hop++, parent = parent.parentElement) {
        if (compact(parent.textContent) || parent.querySelectorAll('img').length !== 1) break;
        const candidate = declaration(parent, 'width');
        if (/^[\d.]+px$/.test(candidate)) { width = parseFloat(candidate); break; }
      }
    }
    if (!Number.isFinite(width) && /^[\d.]+%$/.test(ownWidth)) width = 640 * parseFloat(ownWidth) / 100;
    if (!Number.isFinite(width)) width = Number(img.getAttribute('data-w')) || 640;
    img.setAttribute('data-archive-width', String(Math.max(1, Math.min(640, Math.round(width)))));
  }
  // Empty spacer paragraphs belong to the WeChat template, not to the text.
  for (const node of [...content.querySelectorAll('p,section,div,span')].reverse()) {
    if (!compact(node.textContent) && !node.querySelector('img,svg,video,audio,iframe,hr,table,pre,code')) {
      node.remove(); emptyBlocksRemoved++;
    }
  }
  // Short horizontal title/number groups must not become one paragraph per glyph.
  for (const node of content.querySelectorAll('section,div')) {
    const display = declaration(node, 'display');
    const flow = declaration(node, 'flex-direction') || declaration(node, 'flex-flow') || 'row';
    if (!/^(?:inline-)?flex$/.test(display) || !/^row(?:\s|$)/.test(flow)) continue;
    if (node.children.length < 2 || compact(node.textContent).length > 60 || node.querySelector('table,ul,ol,pre')) continue;
    if ([...node.children].some(child => child.querySelectorAll('p').length > 6 || compact(child.textContent).length > 45)) continue;
    if ([...node.querySelectorAll('img')].some(img => Number(img.getAttribute('data-archive-width')) > 100)) continue;
    node.setAttribute('data-archive-inline', 'true'); inlineRows++;
  }
  const textAfter = compact(content.textContent);
  if (textAfter !== textBefore) throw new Error('Layout normalization changed article text');
  return { emptyBlocksRemoved, inlineRows, symbolGlyphsConverted };
}

export function addReadingRules(service) {
  service.addRule('styledBold', {
    filter: node => ['STRONG', 'B'].includes(node.nodeName) || ['SPAN', 'SECTION', 'DIV', 'P'].includes(node.nodeName) && /^(?:bold|[6-9]00)$/.test(declaration(node, 'font-weight')),
    replacement: (content, node) => {
      const clean = content.trim();
      if (!clean) return '';
      if (/\n\s*\n/.test(clean)) return content;
      // CommonMark asterisks next to Chinese punctuation can render literally.
      const formatted = /^<strong>[\s\S]*<\/strong>$/.test(clean) ? clean : `<strong>${clean}</strong>`;
      return ['SECTION', 'DIV', 'P'].includes(node.nodeName) ? `\n\n${formatted}\n\n` : formatted;
    },
  });
  service.addRule('readingHeadings', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => `\n\n${'#'.repeat(Math.min(6, Number(node.nodeName[1]) + 1))} ${content.trim()}\n\n`,
  });
  service.addRule('portableItalic', {
    filter: node => ['EM', 'I'].includes(node.nodeName),
    replacement: content => content.trim() ? `<em>${content.trim()}</em>` : '',
  });
  service.addRule('sizedImage', {
    filter: 'img', replacement: (_content, node) => {
      const src = node.getAttribute('src'); if (!src) return '';
      const width = node.getAttribute('data-archive-width') || '640';
      const alt = (node.getAttribute('alt') || '').replace(/[\[\]|\r\n]/g, ' ').trim();
      return `![${alt ? alt + '|' : ''}${width}](${src.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
    },
  });
  service.addRule('shortHorizontalGroup', {
    filter: node => node.getAttribute?.('data-archive-inline') === 'true',
    replacement: content => {
      let inline = content.replace(/\s*\n\s*/g, ' ').trim();
      inline = inline.replace(/(?<![\d\w])(\d(?:\s+\d){2,7})(?![\d\w])/g, digits => digits.replace(/\s+/g, ''));
      return `\n\n${inline}\n\n`;
    },
  });
}

export function tidyMarkdown(markdown) {
  // Leave fenced code byte-for-byte; trim template whitespace only outside it.
  let fenced = false; const lines = [];
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || /^\s*```/.test(line)) { lines.push(line); continue; }
    if (!line.trim()) { if (lines.at(-1) !== '') lines.push(''); }
    else lines.push(line);
  }
  return lines.join('\n').trim();
}
