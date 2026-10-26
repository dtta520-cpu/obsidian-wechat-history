import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
test('standalone bundle exports a plugin and registers the command without any external runtime', async () => {
  const registered = [];
  class Plugin {
    async loadData() { return { lastIndex: '公众号归档/测试/公众号归档索引.md' }; }
    registerView(type, callback) { registered.push(['view', type, callback]); }
    addRibbonIcon(icon, label, callback) { registered.push(['ribbon', label, callback]); }
    addCommand(command) { registered.push(['command', command]); }
    addSettingTab() {}
  }
  const api = { Plugin, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, normalizePath: value => value.replace(/\\/g, '/'), Platform: { isWin: true } };
  const module = { exports: {} }; const requested = [];
  const context = { module, exports: module.exports, require: name => {
    requested.push(name); if (name === 'obsidian') return api;
    assert(name.startsWith('node:'), `Unexpected external dependency: ${name}`); return require(name);
  }, Buffer, URL, URLSearchParams, AbortSignal, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, process, console };
  vm.runInNewContext(await fs.readFile('dist/wechat-history-archive/main.js', 'utf8'), context);
  const plugin = new module.exports(); plugin.app = {};
  await plugin.onload();
  assert.equal(typeof plugin.start, 'function'); assert.equal(plugin.lastIndex, '公众号归档/测试/公众号归档索引.md');
  assert(registered.some(([type, command]) => type === 'command' && command.id === 'open'));
  assert(requested.includes('obsidian')); plugin.onunload(); assert.equal(plugin.stopping, true);
});
