import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';

const require = createRequire(import.meta.url);

// A real DOM plus a small Obsidian API adapter; no WeChat or user files are used.
export async function pluginHarness({ settings = {}, initialFiles = new Map() } = {}) {
  const { document, HTMLElement } = parseHTML('<html><body></body></html>');
  const proto = HTMLElement.prototype;
  proto.addClass = function (name) { this.classList.add(name); };
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (text) { this.textContent = text; };
  proto.createEl = function (tag, options = {}) {
    const child = this.ownerDocument.createElement(tag);
    if (options.text) child.textContent = options.text;
    if (options.cls) child.className = options.cls;
    for (const [key, value] of Object.entries(options.attr || {})) child.setAttribute(key, value);
    this.appendChild(child); return child;
  };
  proto.createDiv = function (options) { return this.createEl('div', options); };
  proto.createSpan = function (options) { return this.createEl('span', options); };
  const registered = []; const icons = new Map(); const domEvents = []; const leaves = []; const notices = [];
  const files = new Map(initialFiles); const writes = []; const requested = [];
  let savedSettings = structuredClone(settings); let createdLeaves = 0; let revealed = 0; let layoutReady;
  class Plugin {
    async loadData() { return structuredClone(savedSettings); }
    async saveData(data) { savedSettings = JSON.parse(JSON.stringify(data)); }
    registerView(type, callback) { registered.push(['view', type, callback]); }
    addRibbonIcon(icon, label, callback) { registered.push(['ribbon', label, callback, icon]); return document.createElement('button'); }
    addStatusBarItem() { return document.createElement('div'); }
    registerDomEvent(element, type, callback) { domEvents.push({ element, type, callback }); element.addEventListener(type, callback); }
    addCommand(command) { registered.push(['command', command]); }
    addSettingTab() {}
  }
  class ItemView {
    constructor(leaf) { this.app = leaf.app; this.contentEl = document.createElement('div'); document.body.appendChild(this.contentEl); }
  }
  class Setting {
    constructor(container) { this.element = container.createDiv({ cls: 'setting-item' }); }
    setName(name) { this.element.createSpan({ text: name }); return this; }
    setDesc() { return this; }
    addText(callback) {
      const input = this.element.createEl('input', { attr: { type: 'text' } });
      const control = {
        inputEl: input,
        setPlaceholder(value) { input.setAttribute('placeholder', value); return this; },
        setValue(value) { input.value = value; return this; },
        onChange(handler) { this.change = handler; return this; },
        setDisabled(value) { input.disabled = value; return this; },
      };
      callback(control); return this;
    }
  }
  const api = { Plugin, ItemView, Setting, PluginSettingTab: class {}, Notice: class { constructor(message) { notices.push(message); } },
    normalizePath: value => value.replace(/\\/g, '/'), Platform: { isWin: true },
    addIcon: (id, svg) => icons.set(id, svg), setIcon: (element, id) => { assert(icons.has(id)); element.setAttribute('data-icon', id); },
  };
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: name => {
    requested.push(name); if (name === 'obsidian') return api;
    assert(name.startsWith('node:'), `Unexpected external dependency: ${name}`); return require(name);
  }, Buffer, URL, URLSearchParams, AbortSignal, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, process, console };
  vm.runInNewContext(await fs.readFile(new URL('../dist/wechat-history-archive/main.js', import.meta.url), 'utf8'), context);
  const vault = {
    getAbstractFileByPath: path => files.has(path) ? { path, ...(files.get(path) === null ? {
      children: [...files.keys()].filter(child => child.startsWith(path + '/') && !child.slice(path.length + 1).includes('/')).map(child => ({ path: child })),
    } : {}) } : null,
    async read(file) { assert(files.has(file.path)); return files.get(file.path); },
    async createFolder(path) { assert(!files.has(path)); files.set(path, null); writes.push(path); },
    async create(path, content) { assert(!files.has(path), `Overwriting ${path}`); files.set(path, content); writes.push(path); },
    async modify(file, content) { assert(files.has(file.path)); files.set(file.path, content); writes.push(file.path); },
    async createBinary(path, content) { assert(!files.has(path)); files.set(path, content); writes.push(path); },
  };
  const app = { vault, workspace: {
    onLayoutReady: callback => { layoutReady = callback; },
    getLeavesOfType: () => leaves,
    getLeaf: () => { createdLeaves++; return { app, async setViewState(state) {
      assert.equal(state.type, 'wechat-history-archive-view');
      this.view = registered.find(item => item[0] === 'view')[2](this);
      leaves.push(this); await this.view.onOpen();
    } }; },
    revealLeaf: leaf => { assert(leaves.includes(leaf)); revealed++; },
  } };
  const plugin = new module.exports(); plugin.app = app;
  // Tests must explicitly supply responses. Unexpected network paths fail.
  plugin.createHttp = () => { throw new Error('Test did not supply an HTTP response'); };
  plugin.readHistory = async () => { throw new Error('Test did not supply history'); };
  await plugin.onload();
  await layoutReady?.();
  return { plugin, app, vault, files, writes, registered, domEvents, notices, requested, document, leaves,
    get settings() { return savedSettings; }, get createdLeaves() { return createdLeaves; }, get revealed() { return revealed; },
  };
}
