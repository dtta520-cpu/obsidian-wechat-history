import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
test('community three-file installation retains the complete dependency notices', async () => {
  const [bundle, notices, license] = await Promise.all([
    fs.readFile('dist/wechat-history-archive/main.js', 'utf8'),
    fs.readFile('dist/wechat-history-archive/THIRD-PARTY-NOTICES.txt', 'utf8'),
    fs.readFile('LICENSE', 'utf8'),
  ]);
  assert(notices.includes('turndown'));
  assert(notices.includes('Permission is hereby granted'));
  assert(bundle.startsWith(license.split('\n').map(line => `// ${line}`).join('\n')));
  assert(bundle.endsWith('\n' + notices.split('\n').map(line => `// ${line}`).join('\n') + '\n'));
});

test('standalone bundle registers clickable launchers and reuses the archive panel', async () => {
  const registered = [];
  const icons = new Map(); const domEvents = []; const leaves = []; let createdLeaves = 0; let revealed = 0;
  class Element {
    constructor(tag = 'div', options = {}) { this.tag = tag; this.options = options; this.children = []; this.classes = []; }
    addClass(name) { this.classes.push(name); }
    createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
    createSpan(options) { return this.createEl('span', options); }
  }
  class Plugin {
    async loadData() { return { lastIndex: '公众号归档/测试/公众号归档索引.md' }; }
    registerView(type, callback) { registered.push(['view', type, callback]); }
    addRibbonIcon(icon, label, callback) { registered.push(['ribbon', label, callback, icon]); return new Element(); }
    addStatusBarItem() { return new Element(); }
    registerDomEvent(element, type, callback) { domEvents.push({ element, type, callback }); }
    addCommand(command) { registered.push(['command', command]); }
    addSettingTab() {}
  }
  const api = { Plugin, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, normalizePath: value => value.replace(/\\/g, '/'), Platform: { isWin: true },
    addIcon: (id, svg) => icons.set(id, svg), setIcon: (element, id) => { assert(icons.has(id)); element.icon = id; } };
  const module = { exports: {} }; const requested = [];
  const context = { module, exports: module.exports, require: name => {
    requested.push(name); if (name === 'obsidian') return api;
    assert(name.startsWith('node:'), `Unexpected external dependency: ${name}`); return require(name);
  }, Buffer, URL, URLSearchParams, AbortSignal, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, process, console };
  vm.runInNewContext(await fs.readFile('dist/wechat-history-archive/main.js', 'utf8'), context);
  const plugin = new module.exports(); plugin.app = { workspace: {
    onLayoutReady() {},
    getLeavesOfType: () => leaves,
    getLeaf: () => { createdLeaves++; return { async setViewState(state) { assert.equal(state.type, 'wechat-history-archive-view'); leaves.push(this); } }; },
    revealLeaf: leaf => { assert(leaves.includes(leaf)); revealed++; },
  } };
  await plugin.onload();
  assert.equal(typeof plugin.fetchCatalog, 'function'); assert.equal(typeof plugin.saveSelected, 'function'); assert.equal(plugin.lastIndex, '公众号归档/测试/公众号归档索引.md');
  assert(registered.some(([type, command]) => type === 'command' && command.id === 'open'));
  plugin.fetchCatalog = plugin.saveSelected = () => assert.fail('Opening the panel must not start a download');
  await registered.find(([type]) => type === 'ribbon')[2]();
  const launcher = domEvents.find(item => item.type === 'click');
  assert.equal(launcher.element.tag, 'button');
  assert.equal(launcher.element.options.attr['aria-label'], '打开公众号归档面板');
  assert(launcher.element.children.some(child => child.options.text === '公众号归档'));
  await launcher.callback();
  assert.equal(createdLeaves, 1); assert.equal(revealed, 2);
  assert(requested.includes('obsidian')); plugin.onunload(); assert.equal(plugin.stopping, true);
});

test('deferred archive tabs are only refreshed after they have been loaded', async () => {
  const { pluginHarness } = await import('../test-support/plugin-harness.mjs');
  const harness = await pluginHarness();
  let loaded = 0;
  harness.leaves.push({ view: {}, async loadIfDeferred() { loaded++; } });
  assert.doesNotThrow(() => harness.plugin.update('目录已就绪'));
  await harness.plugin.open();
  assert.equal(loaded, 1);
  assert.equal(harness.revealed, 1);
  assert.equal(harness.createdLeaves, 0);
});
