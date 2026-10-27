# WeChat Official Account Archive

[中文说明：微信公众号归档](README.zh-CN.md)

Archive selected WeChat Official Account (微信公众号) articles as Markdown notes with local images in **Obsidian on Windows**. Fetch an account's currently accessible history or one native WeChat album, then choose which articles to save.

Version: **0.3.4**. The plugin runs inside Obsidian. End users do not need Python, Node.js, Docker, AI, an MCP server, wechatDownload, or WeChat Read.

## Features

- Fetch available account history or one native album, with pagination and completeness checks.
- Choose articles after fetching the directory. Nothing is selected by default.
- Search by title, select visible results, or select unsaved articles.
- Save text and local images, preserving image order, proportions, and display widths.
- Improve Markdown spacing, emphasis, tables, and decorative image sizing.
- Preserve existing notes and user edits, record unavailable articles, and resume unfinished selections.
- Keep local indexes and original public URLs. Albums have separate indexes and share notes for the same article.

## Requirements

- Windows desktop Obsidian. The manifest specifies version 1.8.0 or later; not every version has been tested. Mobile, macOS, and Linux are not supported.
- A logged-in Windows WeChat client for full-account history. The web-cache layout has been tested with WeChat **4.1.6.14**.
- Internet access for new directories, articles, and images. Saved notes, local images, and local directories can be read offline.

## Installation

1. Download the installation ZIP from [GitHub Releases](https://github.com/dtta520-cpu/obsidian-wechat-history/releases).
2. Extract it and copy the `wechat-history-archive` folder into your vault's plugin directory. The default location is `.obsidian/plugins/`.
3. Confirm that the folder directly contains `main.js`, `manifest.json`, and `styles.css`.
4. Restart Obsidian, open **Settings → Community plugins**, and enable **WeChat Official Account Archive**.

You can also download those three files separately from the release. GitHub's source-code archives need to be built before installation. Preserve `data.json`, notes, and attachments when upgrading. If your vault uses a custom configuration directory, use its `plugins` subdirectory.

The plugin is listed in the [Obsidian Community directory](https://community.obsidian.md/plugins/wechat-history-archive). Each new release is checked separately before it becomes available there. Version 0.3.4 updates the display name from WeChat History Archive; the plugin ID and storage paths remain unchanged.

## Usage

The plugin interface is currently in Chinese. The steps below identify each button.

### Archive account history

1. Sign in to your own Windows WeChat account.
2. Click the green archive icon in Obsidian's left ribbon or the **微信公众号归档** status-bar button. You can also search for **WeChat Official Account Archive** in the command palette.
3. Paste a public article URL from the target account, such as an `https://mp.weixin.qq.com/s/...` URL.
4. Click **复制微信主页链接** (copy account homepage). Send that link to WeChat's File Transfer Assistant, open it **inside desktop WeChat**, and scroll down a few screens.
5. Back in Obsidian, click **获取文章目录** (fetch directory). This saves the directory and index without downloading article bodies.
6. Check the articles you want, then click **保存所选文章** (save selected articles).

Use title search, **全选当前结果** (select visible results), **勾选当前未保存** (select visible unsaved articles), or **清空全部勾选** (clear selections). Filtering does not clear earlier selections. Existing notes from the same source are preserved.

Click **停止** (stop) to retain completed work and stop after the current request. Unfinished selections can be resumed. Reopening the panel restores the local directory without a network request. Use **刷新文章目录** (refresh directory) to check for new articles.

### Archive one album

Paste a native WeChat album URL containing `/mp/appmsgalbum`, `__biz`, and `album_id`, fetch its directory, and select articles to save. Public albums normally work without a WeChat login or cache scan. If WeChat requests verification or denies access, the plugin stops and reports the condition.

Pagination preserves album order and checks the reported count when available. Incomplete, repeated, or inconsistent pages are not marked complete. Each album has its own index and progress record. Custom menus, third-party topic pages, and unpublished backend groups are not supported.

### Storage and settings

The default vault-relative folder is `公众号归档`. Each account has a subfolder containing its index, progress JSON, notes, and an `附件` image folder. Settings let you change the output folder or disable image downloads. Changing the source or folder requires fetching a new directory.

## Privacy, network, and filesystem disclosures

### Accounts and payments

Full-account history requires the user's own logged-in Windows WeChat client. Public albums usually do not. There is no separate plugin account, API key, subscription, or payment. Verification requested by WeChat must be completed in WeChat.

### Network requests

Requests occur only after the user asks to identify an account, fetch a directory, or save selected articles. The plugin uses HTTPS to contact:

- `mp.weixin.qq.com` for article pages, account information, history, and album directories.
- `qpic.cn`, `qlogo.cn`, `res.wx.qq.com`, and their subdomains for article images.

WeChat session parameters are sent only to `mp.weixin.qq.com`. Redirect destinations are validated. Node HTTPS is used on desktop to enforce redirect boundaries, timeouts, and response-size limits without weakening TLS.

### Files outside the vault

Full-account discovery uses Node filesystem APIs to **read** existing WeChat web caches outside the vault. Supported cache directories are under:

```text
%APPDATA%\Tencent\xwechat\radium\web
%APPDATA%\Tencent\xwechat\radium\cache
%APPDATA%\Tencent\WeChat\XPlugin\Plugins\Radium
%APPDATA%\Tencent\WeChat\XPlugin\Plugins\XWeb
%APPDATA%\Tencent\WeChat\Cache
```

This reuses the session of an account page the user has already opened. The plugin does not modify these directories. It skips chat databases, login databases, standalone cookie databases, and chat attachment folders. Public-album discovery does not scan these caches.

Session values remain in memory and are not written to settings, notes, or progress records. Pasted URLs are stripped of session and tracking parameters before saving; old settings are cleaned on load. Articles, images, public links, and progress are written inside the selected vault folder through Obsidian APIs. Vault sync services synchronize those files according to the user's existing configuration.

### Clipboard and other services

Copy-homepage and copy-album buttons **write** the generated public URL to the clipboard only when clicked. The plugin does not read the clipboard. There are no ads, analytics, telemetry, AI calls, third-party uploads, background downloads, or self-updating dependencies.

The bundled CSS parser resolves error constructors through a static lookup. The build replaces its upstream dynamic-evaluation fallback and fails if that dependency code changes unexpectedly. Dependency copyright and license notices remain included.

## Limitations and troubleshooting

- “Directory exhausted” means an explicit final page was returned, not that every article ever published is available. Deleted, restricted, paid, or unlisted content may be unavailable.
- If no usable session is found, reopen the account homepage inside desktop WeChat and try again. Cache layouts and endpoints may change.
- If WeChat requests verification or limits frequency, the plugin stops. Verify in WeChat or wait before retrying.
- Author-restricted articles are recorded as unavailable, not saved as empty successful notes.
- Failed image downloads retain an allowed remote image link and record the problem. Those remote images require internet access.
- Audio, video, and embedded media retain an original-page link; media downloads and transcription are not supported.
- Markdown focuses on readability and does not reproduce every WeChat background, font, or layout.

Validation includes actual directory and article downloads, image-reference checks, formatting comparisons, and automated tests with a simulated Obsidian API. Full automation against the real Obsidian interface and all account styles has not been completed. This is an independent project, not an official WeChat or Obsidian product.

## Development

Use Node.js 22 or later:

```sh
npm ci
npm run check
```

Build output: `dist/wechat-history-archive/`. Runtime libraries are bundled into `main.js`; users need no development runtime. Tests use synthetic sessions and local fixtures, not real WeChat accounts.

Release tags must exactly match `manifest.json`, such as `0.3.4`, without a `v` prefix. Attach `main.js`, `manifest.json`, and `styles.css` individually for community installation. The ZIP is also supplied for manual installation.

## License and support

This project uses the [MIT License](LICENSE). Project and third-party licenses are included as comments in `main.js`; manual packages also contain `LICENSE` and `THIRD-PARTY-NOTICES.txt`. See the [changelog](CHANGELOG.md).

Report problems through [GitHub Issues](https://github.com/dtta520-cpu/obsidian-wechat-history/issues). Do not include session values, raw caches, private article content, or vault configuration in public reports.
