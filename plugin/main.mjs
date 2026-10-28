import { Plugin, ItemView, PluginSettingTab, Setting, Notice, normalizePath, Platform, addIcon, setIcon } from 'obsidian';
import { WechatHttp, HistoryProvider, ProbeError, parseArticle, historyHome, enumerateHistory, fingerprint } from '../src/core.mjs';
import { discoverCaches, scanCaches } from '../src/cache.mjs';
import { inspectTargetCache } from '../src/chromium-cache.mjs';
import { ImageClient, formatArticle, noteName, safeName } from '../src/article-format.mjs';
import { nativeFetch } from '../src/node-fetch.mjs';
import { archiveIndex, localDate } from '../src/archive-index.mjs';
import { catalogSource, AlbumProvider, enumerateAlbum } from '../src/album.mjs';
import { singleArticle } from '../src/single-article.mjs';

const VIEW = 'wechat-history-archive-view';
const ICON = 'wechat-history-archive';
const ICON_SVG = '<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M82 43V25a11 11 0 0 0-11-11H25a11 11 0 0 0-11 11v37a11 11 0 0 0 11 11h3v13l18-13h10"/><path d="M29 32h33M29 47h20M75 56v30m-10-10 10 10 10-10"/></g>';
const DEFAULTS = { articleUrl: '', outputFolder: '公众号归档', downloadImages: true };

function settingsForStorage(settings) {
  let articleUrl = '';
  try { articleUrl = catalogSource(settings.articleUrl).source; } catch {}
  const saved = { articleUrl, outputFolder: settings.outputFolder, downloadImages: settings.downloadImages };
  for (const key of ['lastIndex', 'lastCatalog']) {
    if (typeof settings[key] === 'string') saved[key] = settings[key];
  }
  return saved;
}

function folderSetting(value) {
  const normalized = normalizePath(value.trim());
  if (!normalized || normalized.startsWith('/') || /[:\\]/.test(normalized) || normalized.split('/').some(part => part === '..' || part.startsWith('.'))) {
    throw new ProbeError('INVALID_FOLDER', '保存目录应为笔记库内的普通文件夹，例如：公众号归档。');
  }
  return normalized;
}

export default class WechatArchivePlugin extends Plugin {
  async onload() {
    const stored = (await this.loadData()) || {};
    this.settings = settingsForStorage({ ...DEFAULTS, ...stored });
    // Remove old pasted session parameters before any network request or UI action.
    if (stored.articleUrl && stored.articleUrl !== this.settings.articleUrl) await this.saveSettings();
    this.lastIndex = this.settings.lastIndex || '';
    this.running = false; this.stopping = false; this.logs = [];
    this.catalog = null; this.selected = new Set(); this.savedIds = new Set();
    this.status = '准备就绪。粘贴文章链接可直接保存单篇；获取公众号历史目录需要先登录电脑微信。'; this.completed = 0; this.total = 0;
    this.lastSingleFile = '';
    addIcon(ICON, ICON_SVG);
    this.registerView(VIEW, leaf => new ArchiveView(leaf, this));
    const ribbon = this.addRibbonIcon(ICON, '打开微信公众号归档', () => this.open());
    ribbon.addClass('wechat-history-ribbon');
    const statusBar = this.addStatusBarItem();
    statusBar.addClass('wechat-history-status-entry');
    const launcher = statusBar.createEl('button', {
      cls: 'wechat-history-launcher',
      attr: { type: 'button', title: '打开微信公众号归档面板', 'aria-label': '打开微信公众号归档面板' },
    });
    setIcon(launcher.createSpan({ cls: 'wechat-history-launcher-icon', attr: { 'aria-hidden': 'true' } }), ICON);
    launcher.createSpan({ text: '微信公众号归档' });
    this.registerDomEvent(launcher, 'click', () => this.open());
    this.addCommand({ id: 'open', name: '打开归档面板', callback: () => this.open() });
    this.addSettingTab(new ArchiveSettings(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (!this.stopping && !this.running && !this.catalog) return this.restoreCatalog();
    });
  }
  onunload() { this.stopping = true; }
  async open() {
    const existing = this.app.workspace.getLeavesOfType(VIEW)[0];
    const leaf = existing || this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: VIEW, active: true });
    else await leaf.loadIfDeferred?.();
    this.app.workspace.revealLeaf(leaf);
  }
  update(message, { log = true } = {}) {
    this.status = message;
    if (log) { this.logs.push(`${new Date().toLocaleTimeString()}  ${message}`); this.logs = this.logs.slice(-40); }
    this.refreshViews();
  }
  checkStop() { if (this.stopping) throw new ProbeError('CANCELLED', '任务已停止。已保存的文章会保留，可继续保存剩余勾选文章。'); }
  async saveSettings() { await this.saveData(settingsForStorage(this.settings)); }
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
  createHttp() { return new WechatHttp({ fetchImpl: nativeFetch }); }
  createImages() { return new ImageClient(nativeFetch); }
  accountFiles(base) {
    return this.app.vault.getAbstractFileByPath(base)?.children || [];
  }
  async findExistingArticle(base, article, strict = true) {
    const filename = noteName(article);
    const expected = this.app.vault.getAbstractFileByPath(`${base}/${filename}`);
    const suffix = `[${fingerprint(article.id).slice(0, 10)}].md`;
    const candidates = [expected, ...this.accountFiles(base).filter(file => file.path.endsWith(suffix) && file.path !== expected?.path)].filter(Boolean);
    for (const file of candidates) {
      const content = await this.app.vault.read(file);
      if (content.slice(0, 3000).includes(`article_id: ${JSON.stringify(article.id)}`)) return file.path.slice(base.length + 1);
      if (strict && file === expected) throw new ProbeError('FILE_CONFLICT', '目标文件已存在且来源不同，已停止以避免覆盖。');
    }
    return null;
  }
  async saveArticleFile({ article, account, base, http, images, downloadImages, html }) {
    this.checkStop();
    const existing = await this.findExistingArticle(base, article);
    if (existing) return { id: article.id, status: 'existing', file: existing };
    const body = html ?? (await http.get(article.url)).body;
    this.checkStop();
    const formatted = await formatArticle({ html: body, article, account, stop: () => this.stopping,
      saveImage: downloadImages ? async url => {
        const image = await images.get(url); this.checkStop();
        const name = `${fingerprint(url).slice(0, 24)}.${image.extension}`;
        const destination = `${base}/附件/${name}`;
        await this.ensureFolder(`${base}/附件`);
        if (!this.app.vault.getAbstractFileByPath(destination)) await this.app.vault.createBinary(destination, image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength));
        return `附件/${name}`;
      } : undefined,
    });
    const filename = noteName(article);
    this.checkStop(); await this.app.vault.create(`${base}/${filename}`, formatted.markdown);
    return { id: article.id, file: filename, status: 'saved', imagesSaved: formatted.imagesSaved, warnings: formatted.warnings };
  }
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
      if (leaf.view instanceof ArchiveView) leaf.view.refresh();
    }
  }
  clearCatalog() {
    this.catalog = null; this.selected.clear(); this.savedIds.clear(); this.refreshViews();
  }
  catalogMatchesSettings() {
    if (!this.catalog) return false;
    try {
      return catalogSource(this.settings.articleUrl).source === this.catalog.job.source
        && folderSetting(this.settings.outputFolder) === this.catalog.root;
    } catch { return false; }
  }
  async setCatalog(job, base, manifest, restoreSelection = false) {
    this.catalog = { job, base, manifest, root: base.slice(0, base.lastIndexOf('/')) };
    this.savedIds = new Set();
    const results = new Map(job.results.map(result => [result.id, result]));
    for (const article of job.articles) {
      const filename = await this.findExistingArticle(base, article, false);
      if (!filename) continue;
      this.savedIds.add(article.id);
      if (!['saved', 'existing'].includes(results.get(article.id)?.status)) results.set(article.id, { id: article.id, status: 'existing', file: filename });
      else results.set(article.id, { ...results.get(article.id), file: filename });
    }
    const articleIds = new Set(job.articles.map(article => article.id));
    job.results = [...results.values()].map(result => articleIds.has(result.id) && ['saved', 'existing'].includes(result.status) && !this.savedIds.has(result.id)
      ? { ...result, status: 'missing' } : result);
    this.selected = new Set(restoreSelection ? (job.selection?.ids || []).filter(id => articleIds.has(id) && !this.savedIds.has(id)) : []);
  }
  async restoreCatalog() {
    const manifest = this.settings.lastCatalog || this.lastIndex.replace(/公众号归档索引\.md$/, '归档记录.json');
    if (!manifest || !/\/(?:合集-\d+-)?归档记录\.json$/.test(manifest)) return;
    try {
      const base = folderSetting(manifest.slice(0, manifest.lastIndexOf('/')));
      const existing = this.app.vault.getAbstractFileByPath(manifest);
      if (!existing) return;
      const job = JSON.parse(await this.app.vault.read(existing));
      if (!job.endpointExhausted || job.seedArticleFound === false || !Array.isArray(job.articles) || !Array.isArray(job.results)) return;
      await this.setCatalog(job, base, manifest, true);
      if (!this.catalogMatchesSettings()) { this.clearCatalog(); return; }
      this.status = `已载入「${this.catalogLabel(job)}」的本地目录，共 ${job.articles.length} 篇。请勾选需要保存的文章。`;
      this.refreshViews();
    } catch { this.clearCatalog(); }
  }
  articleState(article) {
    if (this.savedIds.has(article.id)) return '已保存';
    const result = this.catalog?.job.results.find(item => item.id === article.id);
    if (result?.code === 'ARTICLE_PRIVATE') return '访问受限';
    return result?.status === 'failed' ? '保存失败，可重试' : '未保存';
  }
  async checkpoint(catalog) {
    catalog.job.updatedAt = new Date().toISOString();
    await this.writeText(catalog.manifest, JSON.stringify(catalog.job, null, 2));
  }
  catalogLabel(job) { return job.scope?.type === 'album' ? `${job.account.nickname} / ${job.scope.title}` : job.account.nickname; }
  async readJob(file) {
    const existing = this.app.vault.getAbstractFileByPath(file);
    if (!existing) return null;
    try { return JSON.parse(await this.app.vault.read(existing)); }
    catch { throw new ProbeError('INVALID_RECORD', '已有归档记录无法读取，请检查该文件后重试。'); }
  }
  async writeIndex(catalog) {
    const scope = catalog.job.scope;
    this.lastIndex = scope?.type === 'album'
      ? `${catalog.base}/合集-${safeName(scope.title).slice(0, 70)} [${scope.id}].md`
      : scope?.type === 'single' ? `${catalog.base}/单篇归档索引.md`
      : `${catalog.base}/公众号归档索引.md`;
    await this.writeText(this.lastIndex, archiveIndex(catalog.job));
    this.settings.lastIndex = this.lastIndex;
    if (scope?.type !== 'single') this.settings.lastCatalog = catalog.manifest;
    await this.saveSettings();
  }
  async homepageLink() {
    try {
      const target = catalogSource(this.settings.articleUrl);
      if (target.type === 'album') {
        await navigator.clipboard.writeText(target.source);
        this.update('已复制合集链接。可直接点击“获取文章目录”；如微信要求验证，请先在电脑微信内打开此链接。');
        return;
      }
      const source = target.source;
      this.update('正在识别公众号…');
      const http = this.createHttp();
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
      NETWORK_ERROR: '连接微信失败。请检查网络后再试，已保存的文章会保留。',
      VERIFICATION_REQUIRED: '微信要求完成验证。请先在微信中正常打开文章，完成验证后再试。',
      ALBUM_ACCESS_REQUIRED: '微信未允许读取该合集。请在微信中确认合集可以打开后重试。',
    };
    return messages[error?.code] || (error instanceof ProbeError ? error.message : '任务遇到本地错误，已保存的文章会保留。');
  }
  async saveSingleArticle() {
    if (this.running) return;
    if (!Platform.isWin) { new Notice('当前插件仅支持 Windows 桌面版。'); return; }
    this.running = true; this.stopping = false; this.logs = []; this.completed = 0; this.total = 1; this.lastSingleFile = '';
    const downloadImages = this.settings.downloadImages;
    let catalog; let article;
    try {
      const target = catalogSource(this.settings.articleUrl);
      if (target.type === 'album') throw new ProbeError('SINGLE_ARTICLE_REQUIRED', '单篇保存需要文章链接。合集请使用“获取文章目录”后勾选保存。');
      const root = folderSetting(this.settings.outputFolder);
      this.settings.articleUrl = target.source; await this.saveSettings();
      this.update('正在读取这篇文章…');
      const http = this.createHttp();
      const { body } = await http.get(target.source);
      this.checkStop();
      const parsed = singleArticle(body, target.source); article = parsed.article;
      const account = parsed.account;
      const base = normalizePath(`${root}/${safeName(account.nickname)}`);
      await this.ensureFolder(base);
      const manifest = `${base}/单篇归档记录.json`;
      for (const file of this.accountFiles(base).filter(file => /\/(?:归档记录|单篇归档记录|合集-\d+-归档记录)\.json$/.test(file.path))) {
        const record = await this.readJob(file.path);
        if (record?.account?.biz && record.account.biz !== account.biz) throw new ProbeError('ACCOUNT_MISMATCH', '保存目录属于另一个同名公众号，请更换目录。');
      }
      const prior = await this.readJob(manifest);
      if (prior && (prior.scope?.type !== 'single' || !Array.isArray(prior.articles) || !Array.isArray(prior.results))) throw new ProbeError('INVALID_RECORD', '单篇归档记录格式异常，请检查该文件后重试。');
      const job = prior || { version: 1, account, scope: { type: 'single' }, articles: [], results: [], pages: [],
        startedAt: new Date().toISOString(), endpointExhausted: false, fullHistoryVerified: false, credentialsPersisted: false };
      job.articles = job.articles.filter(item => item.id !== article.id); job.articles.push(article);
      job.articles.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
      job.status = 'SAVING_SINGLE'; delete job.error;
      catalog = { job, base, manifest, root };
      await this.checkpoint(catalog);
      const result = await this.saveArticleFile({ article, account, base, http, images: this.createImages(), downloadImages, html: body });
      const previous = job.results.find(item => item.id === article.id && ['saved', 'existing'].includes(item.status));
      job.results = job.results.filter(item => item.id !== article.id);
      job.results.push(result.status === 'existing' && previous ? { ...previous, file: result.file } : result);
      job.status = 'SINGLE_ARTICLE_SAVED'; this.completed = 1;
      this.lastSingleFile = `${base}/${result.file}`;
      if (this.catalog?.base === base && this.catalog.job.articles.some(item => item.id === article.id)) {
        this.savedIds.add(article.id); this.selected.delete(article.id);
      }
      this.update(result.status === 'existing' ? `这篇文章已有笔记，已保留原文及修改：「${article.title}」。` : `已保存单篇文章：「${article.title}」。`);
      new Notice(result.status === 'existing' ? '文章已存在，保留已有笔记。' : '单篇文章已保存。');
    } catch (error) {
      if (catalog) {
        catalog.job.status = error.code === 'CANCELLED' ? 'PAUSED' : 'SINGLE_ARTICLE_FAILED';
        catalog.job.error = { code: error.code || 'LOCAL_ERROR' };
        catalog.job.results = catalog.job.results.filter(item => item.id !== article.id);
        catalog.job.results.push({ id: article.id, status: error.code === 'ARTICLE_PRIVATE' ? 'unavailable' : 'failed', code: error.code || 'LOCAL_ERROR' });
      }
      this.update(this.friendlyError(error));
    } finally {
      if (catalog) {
        try { await this.checkpoint(catalog); await this.writeIndex(catalog); }
        catch { this.update('单篇处理已停止，但保存记录写入失败。请检查笔记库是否可写。'); }
      }
      this.running = false; this.refreshViews();
    }
  }
  async readHistory(account, http, onPage) {
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
      } catch (error) { if (error.code !== 'AUTH_REQUIRED') throw error; }
    }
    if (!fields) throw new ProbeError('AUTH_REQUIRED', '缓存会话未通过验证。');
    this.update('已连接微信，正在获取历史文章目录…');
    return enumerateHistory({ firstPage, maxPages: 2000,
      fetchPage: async offset => { this.checkStop(); return provider.page(account.biz, fields, offset); }, onPage,
    });
  }
  async fetchCatalog() {
    if (this.running) return;
    if (!Platform.isWin) { new Notice('当前原型仅验证 Windows 微信缓存。'); return; }
    this.running = true; this.stopping = false; this.logs = []; this.completed = 0; this.total = 0;
    this.clearCatalog();
    let catalog;
    try {
      const target = catalogSource(this.settings.articleUrl);
      const source = target.source;
      const root = folderSetting(this.settings.outputFolder);
      this.settings.articleUrl = source; await this.saveSettings();
      this.update(target.type === 'album' ? '正在识别合集…' : '正在识别公众号…');
      const http = this.createHttp();
      let account; let scope; let albumProvider; let firstPage;
      if (target.type === 'album') {
        albumProvider = new AlbumProvider(http);
        firstPage = await albumProvider.page(target);
        account = firstPage.account; scope = firstPage.scope;
      } else {
        account = parseArticle((await http.get(source)).body, source);
        scope = { type: 'history' };
      }
      this.checkStop();
      const base = normalizePath(`${root}/${safeName(account.nickname || account.biz)}`);
      const manifest = scope.type === 'album' ? `${base}/合集-${scope.id}-归档记录.json` : `${base}/归档记录.json`;
      await this.ensureFolder(base);
      const accountJob = await this.readJob(`${base}/归档记录.json`);
      const prior = scope.type === 'album' ? await this.readJob(manifest) : accountJob;
      if ([prior, accountJob].some(record => record?.account?.biz && record.account.biz !== account.biz)) throw new ProbeError('ACCOUNT_MISMATCH', '保存目录属于另一个同名公众号，请更换目录。');
      const results = new Map([...(accountJob?.results || []), ...(prior?.results || [])].map(result => [result.id, result]));
      const job = { version: 1, account, source, scope, status: 'CONNECTING', startedAt: new Date().toISOString(), articles: [], pages: [],
        results: [...results.values()], fullHistoryVerified: false, credentialsPersisted: false };
      catalog = { job, base, manifest, root };
      await this.checkpoint(catalog);
      this.update(scope.type === 'album' ? `正在读取「${scope.title}」的合集目录…` : `正在连接「${account.nickname}」的微信页面…`);
      const onPage = async state => {
          this.checkStop(); job.articles = state.articles; job.pages = state.pages; job.unresolved = state.unresolved;
          job.status = 'ENUMERATING'; this.total = state.articles.length;
          await this.checkpoint(catalog); this.update(`已找到 ${this.total} 篇文章，正在继续读取${scope.type === 'album' ? '合集' : '历史'}目录…`);
      };
      const history = scope.type === 'album'
        ? await enumerateAlbum({ provider: albumProvider, target, firstPage, onPage, checkStop: () => this.checkStop() })
        : await this.readHistory(account, http, onPage);
      this.checkStop();
      job.articles = history.articles; job.pages = history.pages; job.unresolved = history.unresolved;
      job.endpointExhausted = true; job.coverage = history.coverage; job.endReason = history.endReason;
      if (scope.type === 'album') {
        job.scope.countVerified = history.countVerified;
        const ids = new Set(history.articles.map(article => article.id));
        job.results = job.results.filter(result => ids.has(result.id));
      } else {
        job.seedArticleFound = history.articles.some(article => article.title === account.title || article.url === source);
        if (!job.seedArticleFound) throw new ProbeError('KNOWN_ARTICLE_MISSING', '历史目录遗漏了你提供的文章，已停止，不能认定目录完整。');
      }
      job.status = 'AWAITING_SELECTION';
      await this.setCatalog(job, base, manifest);
      await this.checkpoint(catalog);
      await this.writeIndex(catalog);
      this.total = history.articles.length;
      this.update(`目录已取得：「${this.catalogLabel(job)}」共 ${this.total} 篇。请勾选文章，再点击“保存所选文章”。`);
    } catch (error) {
      this.update(this.friendlyError(error));
      this.clearCatalog();
      if (catalog) {
        catalog.job.status = error.code === 'CANCELLED' ? 'PAUSED' : 'INCOMPLETE'; catalog.job.error = { code: error.code || 'LOCAL_ERROR' };
        try { await this.checkpoint(catalog); } catch { this.update('目录获取已停止，但目录记录写入失败。请检查笔记库是否可写后重试。'); }
      }
    } finally { this.running = false; this.refreshViews(); }
  }
  async saveSelected() {
    if (this.running) return;
    if (!this.catalogMatchesSettings()) { new Notice('文章链接或保存文件夹已改变，请重新获取目录。'); return; }
    const catalog = this.catalog;
    const { job, base } = catalog;
    // Freeze the requested IDs: filtering or UI changes cannot broaden this download.
    const articles = job.articles.filter(article => this.selected.has(article.id));
    if (!articles.length) { new Notice('请先勾选要保存的文章。'); return; }
    this.running = true; this.stopping = false; this.completed = 0; this.total = articles.length;
    const downloadImages = this.settings.downloadImages;
    job.status = 'DOWNLOADING_SELECTION'; delete job.error;
    job.selection = { ids: articles.map(article => article.id), startedAt: new Date().toISOString(), total: articles.length };
    let failures = 0; let unavailable = 0;
    try {
      await this.checkpoint(catalog);
      this.update(`准备保存勾选的 ${this.total} 篇文章…`);
      const http = this.createHttp();
      const images = this.createImages();
      if (downloadImages) await this.ensureFolder(`${base}/附件`);
      for (const article of articles) {
        this.checkStop();
        const filename = await this.findExistingArticle(base, article);
        const current = filename && this.app.vault.getAbstractFileByPath(`${base}/${filename}`);
        if (current) {
          const text = await this.app.vault.read(current);
          if (!text.slice(0, 3000).includes(`article_id: ${JSON.stringify(article.id)}`)) throw new ProbeError('FILE_CONFLICT', '目标文件已存在且来源不同，已停止以避免覆盖。');
          this.completed++; this.update(`已完成 ${this.completed}/${this.total} 篇，已有笔记已保留。`, { log: false });
          const previous = job.results.find(result => result.id === article.id && ['saved', 'existing'].includes(result.status));
          job.results = job.results.filter(result => result.id !== article.id);
          job.results.push(previous ? { ...previous, file: filename } : { id: article.id, file: filename, status: 'existing' });
          this.savedIds.add(article.id); this.selected.delete(article.id);
          await this.checkpoint(catalog);
          continue;
        }
        try {
          const result = await this.saveArticleFile({ article, account: job.account, base, http, images, downloadImages });
          job.results = job.results.filter(result => result.id !== article.id);
          job.results.push(result);
          this.completed++;
          this.savedIds.add(article.id); this.selected.delete(article.id);
        } catch (error) {
          if (['CANCELLED', 'RATE_LIMITED', 'VERIFICATION_REQUIRED', 'NETWORK_ERROR'].includes(error.code)) throw error;
          if (error.code === 'ARTICLE_PRIVATE') unavailable++; else failures++;
          job.results = job.results.filter(result => result.id !== article.id);
          job.results.push({ id: article.id, status: error.code === 'ARTICLE_PRIVATE' ? 'unavailable' : 'failed', code: error.code || 'LOCAL_ERROR' });
        }
        await this.checkpoint(catalog); this.update(`所选 ${this.total} 篇：已保存 ${this.completed} 篇，访问受限 ${unavailable} 篇，失败 ${failures} 篇。`, { log: false });
      }
      job.status = failures ? 'PARTIAL_SELECTION' : unavailable ? 'SELECTED_ARTICLES_WITH_UNAVAILABLE' : 'SELECTED_ARTICLES_SAVED';
      job.unavailableCount = job.results.filter(result => result.code === 'ARTICLE_PRIVATE').length;
      job.selection.finishedAt = new Date().toISOString();
      this.update(`所选文章处理完成：已保存 ${this.completed}/${this.total} 篇，访问受限 ${unavailable} 篇，失败 ${failures} 篇。未勾选文章保持不变。`);
      new Notice(`所选文章已保存：${this.completed}/${this.total} 篇`);
    } catch (error) {
      job.status = error.code === 'CANCELLED' ? 'PAUSED' : 'INCOMPLETE'; job.error = { code: error.code || 'LOCAL_ERROR' };
      this.update(this.friendlyError(error));
    } finally {
      try {
        Object.assign(job.selection, { saved: this.completed, unavailable, failed: failures });
        await this.checkpoint(catalog);
        await this.writeIndex(catalog);
      } catch { this.update('文章处理已停止，但进度文件写入失败。请检查笔记库是否可写后重试。'); }
      this.running = false; this.refreshViews();
    }
  }
}

class ArchiveView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return '微信公众号归档'; }
  getIcon() { return ICON; }
  async onOpen() {
    const content = this.contentEl; content.empty(); content.addClass('wechat-history-view');
    content.createEl('h2', { text: '微信公众号归档' });
    content.createEl('p', { text: '单篇：粘贴文章链接，点击“保存单篇文章”。批量：先获取公众号或合集目录，再勾选保存。', cls: 'wechat-intro' });
    new Setting(content).setName('公众号文章或合集链接').addText(text => {
      this.urlInput = text;
      text.setPlaceholder('https://mp.weixin.qq.com/…').setValue(this.plugin.settings.articleUrl)
        .onChange(async value => {
          this.plugin.settings.articleUrl = value;
          if (this.plugin.catalog && !this.plugin.catalogMatchesSettings()) {
            this.plugin.clearCatalog(); this.plugin.update('文章链接已更改，请重新获取目录。');
          }
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
    });
    const actions = content.createDiv({ cls: 'wechat-actions' });
    this.singleButton = actions.createEl('button', { text: '保存单篇文章', cls: 'mod-cta', attr: { title: '只保存此链接指向的文章，不获取历史目录' } });
    this.singleButton.onclick = () => this.plugin.saveSingleArticle();
    this.openSingleButton = actions.createEl('button', { text: '打开刚保存文章' });
    this.openSingleButton.onclick = async () => {
      if (this.plugin.lastSingleFile) await this.app.workspace.openLinkText(this.plugin.lastSingleFile, '', true);
    };
    this.copy = actions.createEl('button', { text: '复制微信主页链接' }); this.copy.onclick = () => this.plugin.homepageLink();
    this.startButton = actions.createEl('button', { text: '1. 获取文章目录' }); this.startButton.onclick = () => this.plugin.fetchCatalog();
    this.stopButton = actions.createEl('button', { text: '停止' }); this.stopButton.onclick = () => { this.plugin.stopping = true; this.plugin.update('正在停止，当前请求结束后将保留进度。'); };
    const open = actions.createEl('button', { text: '打开归档索引' }); open.onclick = async () => {
      if (this.plugin.lastIndex) await this.app.workspace.openLinkText(this.plugin.lastIndex, '', true);
      else new Notice('取得目录后可打开索引。');
    };
    this.statusEl = content.createDiv({ cls: 'wechat-status' });
    this.progress = content.createEl('progress');
    this.catalogEl = content.createDiv({ cls: 'wechat-catalog' });
    this.catalogTitle = this.catalogEl.createEl('h3', { text: '2. 勾选文章' });
    this.catalogEl.createEl('p', { cls: 'wechat-caveat', text: '默认不勾选。搜索不会取消已有勾选；已保存的笔记会保留。' });
    this.search = this.catalogEl.createEl('input', { attr: { type: 'search', placeholder: '按标题搜索文章…', 'aria-label': '按标题搜索文章' } });
    this.search.oninput = () => this.refresh();
    const selectionActions = this.catalogEl.createDiv({ cls: 'wechat-actions' });
    this.selectAll = selectionActions.createEl('button', { text: '全选当前结果' });
    this.selectAll.onclick = () => this.selectVisible(false);
    this.selectUnsaved = selectionActions.createEl('button', { text: '勾选当前未保存' });
    this.selectUnsaved.onclick = () => this.selectVisible(true);
    this.clearSelection = selectionActions.createEl('button', { text: '清空全部勾选' });
    this.clearSelection.onclick = () => { if (!this.plugin.running) { this.plugin.selected.clear(); this.plugin.refreshViews(); } };
    this.selectionSummary = this.catalogEl.createDiv({ cls: 'wechat-selection-summary', attr: { 'aria-live': 'polite' } });
    this.articleList = this.catalogEl.createDiv({ cls: 'wechat-article-list', attr: { role: 'group', 'aria-label': '可选择的文章目录' } });
    const saveActions = this.catalogEl.createDiv({ cls: 'wechat-actions' });
    this.saveButton = saveActions.createEl('button', { text: '3. 保存所选文章', cls: 'mod-cta' });
    this.saveButton.onclick = () => this.plugin.saveSelected();
    content.createEl('p', { cls: 'wechat-caveat', text: '单篇文章及公开合集通常不需要读取微信缓存。获取公众号历史目录：先复制主页链接，在电脑微信内打开。遇到验证或访问限制时按提示处理。' });
    this.logEl = content.createDiv({ cls: 'wechat-log' }); this.refresh();
  }
  visibleArticles() {
    const query = this.search.value.trim().toLocaleLowerCase();
    return (this.plugin.catalog?.job.articles || []).filter(article => !query || article.title.toLocaleLowerCase().includes(query));
  }
  selectVisible(unsavedOnly) {
    if (this.plugin.running) return;
    for (const article of this.visibleArticles()) {
      if (!unsavedOnly || !this.plugin.savedIds.has(article.id)) this.plugin.selected.add(article.id);
    }
    this.plugin.refreshViews();
  }
  refreshCatalog() {
    const job = this.plugin.catalog?.job;
    this.catalogEl.hidden = !job;
    if (!job) { this.renderedArticles = null; return; }
    this.catalogTitle.setText(`2. 勾选文章 · ${this.plugin.catalogLabel(job)}`);
    const visible = this.visibleArticles();
    if (this.renderedArticles !== job.articles || this.renderedQuery !== this.search.value) {
      this.renderedArticles = job.articles; this.renderedQuery = this.search.value;
      this.articleList.empty(); this.rowControls = [];
      if (!visible.length) this.articleList.createEl('p', { text: '没有匹配的文章，请调整搜索词。', cls: 'wechat-caveat' });
      for (const article of visible) {
        const row = this.articleList.createEl('label', { cls: 'wechat-article-row' });
        const checkbox = row.createEl('input', { attr: { type: 'checkbox', 'aria-label': `选择文章：${article.title}` } });
        checkbox.onchange = () => {
          if (this.plugin.running) return;
          if (checkbox.checked) this.plugin.selected.add(article.id); else this.plugin.selected.delete(article.id);
          this.plugin.refreshViews();
        };
        const body = row.createDiv({ cls: 'wechat-article-details' });
        body.createSpan({ text: article.title, cls: 'wechat-article-title' });
        const meta = body.createDiv({ cls: 'wechat-article-meta' });
        meta.createSpan({ text: localDate(article.publishedAt) });
        const state = meta.createSpan();
        this.rowControls.push({ article, checkbox, state });
      }
    }
    for (const { article, checkbox, state } of this.rowControls) {
      checkbox.checked = this.plugin.selected.has(article.id); checkbox.disabled = this.plugin.running;
      state.setText(this.plugin.articleState(article));
    }
    this.selectionSummary.setText(`目录共 ${job.articles.length} 篇 · 当前显示 ${visible.length} 篇 · 已勾选 ${this.plugin.selected.size} 篇`);
    this.saveButton.setText(`3. 保存所选文章（${this.plugin.selected.size}）`);
    this.saveButton.disabled = this.plugin.running || !this.plugin.selected.size || !this.plugin.catalogMatchesSettings();
    this.selectAll.disabled = this.plugin.running || !visible.length;
    this.selectUnsaved.disabled = this.plugin.running || !visible.some(article => !this.plugin.savedIds.has(article.id));
    this.clearSelection.disabled = this.plugin.running || !this.plugin.selected.size;
    this.search.disabled = this.plugin.running;
  }
  refresh() {
    if (!this.statusEl) return;
    this.statusEl.setText(this.plugin.status);
    this.startButton.disabled = this.plugin.running; this.copy.disabled = this.plugin.running; this.stopButton.disabled = !this.plugin.running;
    this.startButton.setText(this.plugin.catalog ? '1. 刷新文章目录' : '1. 获取文章目录');
    let album = false;
    try { album = catalogSource(this.plugin.settings.articleUrl).type === 'album'; } catch {}
    this.singleButton.disabled = this.plugin.running || album;
    this.openSingleButton.hidden = !this.plugin.lastSingleFile;
    this.openSingleButton.disabled = this.plugin.running;
    this.copy.setText(album ? '复制合集链接' : '复制微信主页链接');
    this.urlInput.setDisabled(this.plugin.running);
    this.progress.max = this.plugin.total || 1; this.progress.value = this.plugin.completed;
    this.logEl.empty(); for (const line of this.plugin.logs) this.logEl.createEl('p', { text: line });
    this.refreshCatalog();
  }
}

class ArchiveSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('保存文件夹').setDesc('位于当前笔记库内，每个公众号建立一个子文件夹。').addText(text => text.setDisabled(this.plugin.running).setValue(this.plugin.settings.outputFolder).onChange(async value => {
      try {
        if (this.plugin.running) return;
        this.plugin.settings.outputFolder = folderSetting(value);
        if (this.plugin.catalog && !this.plugin.catalogMatchesSettings()) { this.plugin.clearCatalog(); this.plugin.update('保存文件夹已更改，请重新获取目录。'); }
        await this.plugin.saveSettings();
      } catch {}
    }));
    new Setting(this.containerEl).setName('下载图片').setDesc('图片保存在文章旁边的“附件”文件夹，失败时保留原图链接。').addToggle(toggle => toggle.setValue(this.plugin.settings.downloadImages).onChange(async value => { this.plugin.settings.downloadImages = value; await this.plugin.saveSettings(); }));
  }
}
