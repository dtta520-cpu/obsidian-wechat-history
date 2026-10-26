import { Plugin, ItemView, PluginSettingTab, Setting, Notice, normalizePath, Platform } from 'obsidian';
import { WechatHttp, HistoryProvider, ProbeError, parseArticle, publicArticleUrl, historyHome, enumerateHistory, fingerprint } from '../src/core.mjs';
import { discoverCaches, scanCaches } from '../src/cache.mjs';
import { inspectTargetCache } from '../src/chromium-cache.mjs';
import { ImageClient, formatArticle, noteName, safeName } from '../src/article-format.mjs';
import { nativeFetch } from '../src/node-fetch.mjs';
import { archiveIndex } from '../src/archive-index.mjs';

const VIEW = 'wechat-history-archive-view';
const DEFAULTS = { articleUrl: '', outputFolder: '公众号归档', downloadImages: true };

function folderSetting(value) {
  const normalized = normalizePath(value.trim());
  if (!normalized || normalized.startsWith('/') || /[:\\]/.test(normalized) || normalized.split('/').some(part => part === '..' || part.startsWith('.'))) {
    throw new ProbeError('INVALID_FOLDER', '保存目录应为笔记库内的普通文件夹，例如：公众号归档。');
  }
  return normalized;
}

export default class WechatArchivePlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.lastIndex = this.settings.lastIndex || '';
    this.running = false; this.stopping = false; this.logs = [];
    this.status = '准备就绪。请先登录电脑微信。'; this.completed = 0; this.total = 0;
    this.registerView(VIEW, leaf => new ArchiveView(leaf, this));
    this.addRibbonIcon('newspaper', '公众号历史归档', () => this.open());
    this.addCommand({ id: 'open', name: '打开公众号历史归档', callback: () => this.open() });
    this.addSettingTab(new ArchiveSettings(this.app, this));
  }
  onunload() { this.stopping = true; }
  async open() {
    const existing = this.app.workspace.getLeavesOfType(VIEW)[0];
    const leaf = existing || this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  update(message, { log = true } = {}) {
    this.status = message;
    if (log) { this.logs.push(`${new Date().toLocaleTimeString()}  ${message}`); this.logs = this.logs.slice(-40); }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.refresh();
  }
  checkStop() { if (this.stopping) throw new ProbeError('CANCELLED', '任务已停止。已保存的文章会保留，下次开始会跳过它们。'); }
  async saveSettings() { await this.saveData(this.settings); }
  async ensureFolder(folder) {
    let current = '';
    for (const part of folder.split('/')) {
      current = current ? current + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
  async writeText(file, content) {
    const existing = this.app.vault.getAbstractFileByPath(file);
    if (existing) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(file, content);
  }
  async homepageLink() {
    try {
      const source = publicArticleUrl(this.settings.articleUrl);
      this.update('正在识别公众号…');
      const http = new WechatHttp({ fetchImpl: nativeFetch });
      const account = parseArticle((await http.get(source)).body, source);
      await navigator.clipboard.writeText(historyHome(account.biz));
      this.update(`已复制「${account.nickname}」的主页链接。请发到微信文件传输助手并在电脑微信内打开，再开始归档。`);
    } catch (error) { this.update(this.friendlyError(error)); }
  }
  friendlyError(error) {
    const messages = {
      AUTH_REQUIRED: '未连接到可用的微信页面。请在电脑微信内重新打开目标公众号主页，再开始归档。',
      CACHE_ROOT_MISSING: '没有找到支持的微信网页缓存。当前版本支持 Windows 微信桌面版。',
      RATE_LIMITED: '微信暂时限制了请求，已停止采集。已保存的文章会保留，请稍后再试。',
      NETWORK_ERROR: '连接微信失败，已保存进度。请检查网络后再试。',
      VERIFICATION_REQUIRED: '微信要求完成验证。请先在微信中正常打开文章，完成验证后再试。',
    };
    return messages[error?.code] || (error instanceof ProbeError ? error.message : '任务遇到本地错误，已保存进度。');
  }
  async start() {
    if (this.running) return;
    if (!Platform.isWin) { new Notice('当前原型仅验证 Windows 微信缓存。'); return; }
    this.running = true; this.stopping = false; this.logs = []; this.completed = 0; this.total = 0;
    let job; let base; let manifest;
    const checkpoint = async () => {
      if (!job || !manifest) return;
      job.updatedAt = new Date().toISOString();
      await this.writeText(manifest, JSON.stringify(job, null, 2));
    };
    try {
      const source = publicArticleUrl(this.settings.articleUrl);
      const root = folderSetting(this.settings.outputFolder);
      this.settings.articleUrl = source; await this.saveSettings();
      this.update('正在识别公众号…');
      const http = new WechatHttp({ fetchImpl: nativeFetch });
      const account = parseArticle((await http.get(source)).body, source);
      this.checkStop();
      base = normalizePath(`${root}/${safeName(account.nickname || account.biz)}`);
      manifest = `${base}/归档记录.json`;
      await this.ensureFolder(base);
      let prior;
      const existing = this.app.vault.getAbstractFileByPath(manifest);
      if (existing) { try { prior = JSON.parse(await this.app.vault.read(existing)); } catch {} }
      if (prior?.account?.biz && prior.account.biz !== account.biz) throw new ProbeError('ACCOUNT_MISMATCH', '保存目录属于另一个同名公众号，请更换目录。');
      job = { version: 1, account, source, status: 'CONNECTING', startedAt: new Date().toISOString(), articles: prior?.articles || [], pages: prior?.pages || [],
        results: prior?.results || [], fullHistoryVerified: false, credentialsPersisted: false };
      await checkpoint();
      this.update(`正在连接「${account.nickname}」的微信页面…`);
      const roots = await discoverCaches();
      if (!roots.length) throw new ProbeError('CACHE_ROOT_MISSING', '没有找到微信网页缓存。');
      const inspected = await inspectTargetCache({ roots, biz: account.biz, authorId: account.authorId });
      this.checkStop();
      const raw = await scanCaches({ biz: account.biz, roots });
      const merged = new Map(raw.candidates.map(candidate => [candidate.identity, candidate]));
      for (const candidate of inspected.candidates) merged.set(candidate.identity, candidate);
      const candidates = [...merged.values()].sort((a, b) => Number(Boolean(b.cachedPage)) - Number(Boolean(a.cachedPage)));
      const provider = new HistoryProvider(http);
      let fields; let firstPage;
      for (const candidate of candidates.slice(0, 5)) {
        this.checkStop();
        try {
          const trial = await provider.prepare(account.biz, candidate);
          const page = await provider.page(account.biz, trial, 0);
          if (page.articles.length) { fields = trial; firstPage = page; break; }
        } catch (error) { if (!['AUTH_REQUIRED'].includes(error.code)) throw error; }
      }
      if (!fields) throw new ProbeError('AUTH_REQUIRED', '缓存会话未通过验证。');
      this.update('已连接微信，正在获取历史文章目录…');
      const history = await enumerateHistory({ firstPage, maxPages: 2000,
        fetchPage: async offset => { this.checkStop(); return provider.page(account.biz, fields, offset); },
        onPage: async state => {
          this.checkStop(); job.articles = state.articles; job.pages = state.pages; job.unresolved = state.unresolved;
          job.status = 'ENUMERATING'; this.total = state.articles.length;
          await checkpoint(); this.update(`已找到 ${this.total} 篇文章，正在继续读取历史目录…`);
        },
      });
      fields = undefined;
      job.endpointExhausted = true; job.coverage = history.coverage; job.endReason = history.endReason; job.status = 'DOWNLOADING';
      job.seedArticleFound = history.articles.some(article => article.title === account.title || article.url === source);
      if (!job.seedArticleFound) throw new ProbeError('KNOWN_ARTICLE_MISSING', '历史目录遗漏了你提供的文章，已停止，不能认定目录完整。');
      this.total = history.articles.length;
      const images = new ImageClient(nativeFetch);
      await this.ensureFolder(`${base}/附件`);
      let failures = 0; let unavailable = 0;
      for (const article of history.articles) {
        this.checkStop();
        const filename = noteName(article); const filePath = `${base}/${filename}`;
        const current = this.app.vault.getAbstractFileByPath(filePath);
        if (current) {
          const text = await this.app.vault.read(current);
          if (!text.slice(0, 3000).includes(`article_id: ${JSON.stringify(article.id)}`)) throw new ProbeError('FILE_CONFLICT', '目标文件已存在且来源不同，已停止以避免覆盖。');
          this.completed++; this.update(`已完成 ${this.completed}/${this.total} 篇，已有笔记已保留。`, { log: false });
          const previous = job.results.find(result => result.id === article.id && ['saved', 'existing'].includes(result.status));
          job.results = job.results.filter(result => result.id !== article.id);
          job.results.push(previous || { id: article.id, file: filename, status: 'existing' });
          continue;
        }
        try {
          const { body } = await http.get(article.url);
          const formatted = await formatArticle({ html: body, article, account, stop: () => this.stopping,
            saveImage: this.settings.downloadImages ? async url => {
              const image = await images.get(url); this.checkStop();
              const name = `${fingerprint(url).slice(0, 24)}.${image.extension}`;
              const destination = `${base}/附件/${name}`;
              if (!this.app.vault.getAbstractFileByPath(destination)) await this.app.vault.createBinary(destination, image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength));
              return `附件/${name}`;
            } : undefined,
          });
          this.checkStop(); await this.app.vault.create(filePath, formatted.markdown);
          job.results = job.results.filter(result => result.id !== article.id);
          job.results.push({ id: article.id, file: filename, status: 'saved', imagesSaved: formatted.imagesSaved, warnings: formatted.warnings });
          this.completed++;
        } catch (error) {
          if (['CANCELLED', 'RATE_LIMITED', 'VERIFICATION_REQUIRED', 'NETWORK_ERROR'].includes(error.code)) throw error;
          if (error.code === 'ARTICLE_PRIVATE') unavailable++; else failures++;
          job.results = job.results.filter(result => result.id !== article.id);
          job.results.push({ id: article.id, status: error.code === 'ARTICLE_PRIVATE' ? 'unavailable' : 'failed', code: error.code || 'LOCAL_ERROR' });
        }
        await checkpoint(); this.update(`已保存 ${this.completed}/${this.total} 篇，访问受限 ${unavailable} 篇，失败 ${failures} 篇。`, { log: false });
      }
      job.status = failures ? 'PARTIAL_DOWNLOAD' : unavailable ? 'ARCHIVED_WITH_UNAVAILABLE_ITEMS' : 'ARCHIVED_AVAILABLE_HISTORY';
      job.unavailableCount = unavailable;
      job.finishedAt = new Date().toISOString(); await checkpoint();
      await this.writeText(`${base}/公众号归档索引.md`, archiveIndex(job));
      this.lastIndex = `${base}/公众号归档索引.md`;
      this.settings.lastIndex = this.lastIndex; await this.saveSettings();
      this.update(`归档完成：${this.completed}/${this.total} 篇，访问受限 ${unavailable} 篇，失败 ${failures} 篇。已保存到「${base}」。`);
      new Notice(`公众号归档：${this.completed}/${this.total} 篇`);
    } catch (error) {
      if (job) { job.status = error.code === 'CANCELLED' ? 'PAUSED' : 'INCOMPLETE'; job.error = { code: error.code || 'LOCAL_ERROR' }; await checkpoint(); }
      this.update(this.friendlyError(error));
    } finally {
      this.running = false;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.refresh();
    }
  }
}

class ArchiveView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return '公众号历史归档'; }
  getIcon() { return 'newspaper'; }
  async onOpen() {
    const content = this.contentEl; content.empty(); content.addClass('wechat-history-view');
    content.createEl('h2', { text: '公众号历史归档' });
    content.createEl('p', { text: '把一个公众号的历史文章保存为笔记。登录电脑微信，打开目标公众号主页后，即可开始归档。', cls: 'wechat-intro' });
    new Setting(content).setName('任意一篇公众号文章链接').addText(text => {
      text.setPlaceholder('https://mp.weixin.qq.com/s/…').setValue(this.plugin.settings.articleUrl)
        .onChange(async value => { this.plugin.settings.articleUrl = value; await this.plugin.saveSettings(); });
    });
    const actions = content.createDiv({ cls: 'wechat-actions' });
    this.copy = actions.createEl('button', { text: '复制微信主页链接' }); this.copy.onclick = () => this.plugin.homepageLink();
    this.startButton = actions.createEl('button', { text: '开始 / 继续归档', cls: 'mod-cta' }); this.startButton.onclick = () => this.plugin.start();
    this.stopButton = actions.createEl('button', { text: '停止' }); this.stopButton.onclick = () => { this.plugin.stopping = true; this.plugin.update('正在停止，当前请求结束后将保留进度。'); };
    const open = actions.createEl('button', { text: '打开归档索引' }); open.onclick = async () => {
      if (this.plugin.lastIndex) await this.app.workspace.openLinkText(this.plugin.lastIndex, '', true);
      else new Notice('完成一次归档后可打开索引。');
    };
    this.statusEl = content.createDiv({ cls: 'wechat-status' });
    this.progress = content.createEl('progress');
    content.createEl('p', { cls: 'wechat-caveat', text: '首次使用：点击“复制微信主页链接”，发到文件传输助手并在电脑微信内打开。凭证只在本机内存中使用；笔记、图片和进度保存在当前笔记库。当前版本仅支持 Windows。' });
    this.logEl = content.createDiv({ cls: 'wechat-log' }); this.refresh();
  }
  refresh() {
    if (!this.statusEl) return;
    this.statusEl.setText(this.plugin.status);
    this.startButton.disabled = this.plugin.running; this.copy.disabled = this.plugin.running; this.stopButton.disabled = !this.plugin.running;
    this.progress.max = this.plugin.total || 1; this.progress.value = this.plugin.completed;
    this.logEl.empty(); for (const line of this.plugin.logs) this.logEl.createEl('p', { text: line });
  }
}

class ArchiveSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('保存文件夹').setDesc('位于当前笔记库内，每个公众号建立一个子文件夹。').addText(text => text.setValue(this.plugin.settings.outputFolder).onChange(async value => {
      try { this.plugin.settings.outputFolder = folderSetting(value); await this.plugin.saveSettings(); } catch {}
    }));
    new Setting(this.containerEl).setName('下载图片').setDesc('图片保存在文章旁边的“附件”文件夹，失败时保留原图链接。').addToggle(toggle => toggle.setValue(this.plugin.settings.downloadImages).onChange(async value => { this.plugin.settings.downloadImages = value; await this.plugin.saveSettings(); }));
  }
}
