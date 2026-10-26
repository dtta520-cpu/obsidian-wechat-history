import { noteName } from './article-format.mjs';
export const localDate = value => value ? new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10) : '未知';
export function archiveIndex(job) {
  const articles = job.articles;
  const results = new Map(job.results.map(item => [item.id, item]));
  const saved = articles.filter(item => ['saved', 'existing'].includes(results.get(item.id)?.status)).length;
  const privateCount = articles.filter(item => results.get(item.id)?.code === 'ARTICLE_PRIVATE').length;
  const dates = articles.map(item => item.publishedAt).filter(Boolean).sort();
  const escape = value => value.replace(/[\[\]\\\r\n]/g, ' ');
  return [
    `# ${job.account.nickname} · 公众号归档`, '',
    `本次历史接口返回 **${articles.length} 条**，已保存文字 **${saved} 条**，作者隐私限制 **${privateCount} 条**，其他待补齐 **${articles.length - saved - privateCount} 条**。`, '',
    `发布时间范围（北京时间）：${localDate(dates[0])} 至 ${localDate(dates.at(-1))}。`, '',
    '范围为微信历史接口当前可枚举的内容，不保证包含已删除、无权访问或未列入目录的文章。音视频保留原文入口；音频帖保存页面文字介绍，不含音频本体或转写。', '',
    ...articles.map(article => {
      const item = results.get(article.id);
      const available = item && ['saved', 'existing'].includes(item.status);
      const target = available ? encodeURIComponent(item.file || noteName(article)).replace(/\(/g, '%28').replace(/\)/g, '%29') : article.url;
      const suffix = available ? item.warnings?.includes('AUDIO_ORIGINAL_ONLY') ? ' — 音频介绍，收听请打开原文' : '' : item?.code === 'ARTICLE_PRIVATE' ? ' — 作者隐私设置限制，仅保留原文入口' : ' — 正文待补齐';
      return `- ${localDate(article.publishedAt)} [${escape(article.title)}](${target})${suffix}`;
    }), '',
  ].join('\n');
}
