# WeChat History Archive（公众号历史归档）

[English](README.md)

独立运行在 **Windows 桌面版 Obsidian** 中的微信公众号历史归档插件。把公众号当前可访问、可枚举的历史内容保存为 Markdown 笔记，并将文章图片下载到笔记库。

当前版本：**0.3.3**。最终用户不需要安装 wechatDownload、微信读书、Python、Node.js、Docker 或 MCP 服务。

Windows desktop plugin for archiving selected, currently accessible WeChat public-account articles or a native album as Markdown with local images. Full-account discovery requires a logged-in Windows WeChat client and reads its web cache outside the vault. Public albums do not normally need that cache. See the account, network and file-access disclosures below; this is not an official WeChat or Obsidian product.

## 可以做什么

- 从目标公众号的任意一篇文章链接识别账号。
- 读取本机 Windows 微信网页缓存中的目标账号会话，遍历历史目录。
- 支持微信原生合集 / 专辑链接，分页获取单个合集的目录并核对篇数，保留合集顺序。
- 获取目录后暂停，由使用者勾选文章保存；支持标题搜索、全选当前结果、勾选未保存文章。
- 保存常规图文、图片短文以及音频帖的文字介绍。
- 将图片保存到本地，保留原文中的显示宽度、次序和比例。
- 清理微信模板空白，改善横排文字、中文强调和特殊字体符号的 Markdown 显示。
- 保留已有同来源笔记，记录下载进度、访问限制和失败原因。
- 生成按时间排列的归档索引；每篇笔记保留原文链接。

## 安装

1. 在 [Releases](https://github.com/dtta520-cpu/obsidian-wechat-history/releases) 下载已发布版本的安装包。
2. 解压，将其中的 `wechat-history-archive` 文件夹复制到笔记库的 `.obsidian/plugins/` 下。
3. 确认该文件夹内直接包含 `main.js`、`manifest.json` 和 `styles.css`。
4. 重新打开 Obsidian，在“设置 → 第三方插件”中启用“WeChat History Archive”。插件功能界面使用中文。

也可以从 Release 分别下载这三个文件，放入上述插件文件夹。GitHub 自动生成的 “Source code” 压缩包是开发源码，需要先构建。

升级时替换插件的代码文件，保留原有 `data.json` 配置以及笔记、附件。升级不会自动改写以前下载的笔记。

## 使用

1. 登录 Windows 微信。
2. 点击 Obsidian 左侧工具栏的绿色归档图标，或右下角带文字的“公众号归档”按钮，打开面板。也可通过命令面板搜索“WeChat History Archive”。
3. 填入目标公众号任意一篇文章的 `https://mp.weixin.qq.com/s/...` 链接。
4. 点击“复制微信主页链接”，发到微信文件传输助手，在**电脑微信内部**打开并向下翻动几屏。
5. 回到 Obsidian，点击“获取文章目录”。这一步保存目录和索引，不会自动保存文章正文。
6. 在目录中勾选需要保存的文章，点击“保存所选文章”。默认不勾选；每条显示日期、标题及保存状态。

可以按标题搜索，再点击“全选当前结果”或“勾选当前未保存”；搜索不会取消已有勾选，保存按钮显示全部勾选数量。“清空全部勾选”会取消所有选择。

再次打开面板会读取上次取得的本地目录，不必重新连接微信。需要检查新文章时点击“刷新文章目录”。获取新目录需要联网和有效微信页面会话，勾选保存正文也需要联网。

### 只获取一个合集

在同一输入框粘贴微信原生合集链接（路径为 `/mp/appmsgalbum`，包含 `__biz` 和 `album_id`），再点击“获取文章目录”。插件自动识别为合集，只返回该合集的文章，随后仍由使用者勾选保存。

公开合集直接请求微信合集目录，无需先扫描本机微信缓存；若微信要求验证或拒绝访问，插件会提示并停止。目录会自动翻页，并在接口提供总数时核对取得的篇数。中途失败、重复页或数量不符不会显示为完整目录。

每个合集有独立的索引和进度文件，放在对应公众号的文件夹内，不覆盖全量历史索引。相同文章共用同一份笔记和附件；保留已有笔记以及使用者修改。当前支持微信原生合集链接，不自动解析自定义菜单、第三方专题页或后台分组。

默认保存位置：

```text
公众号归档/
└─ 公众号名称/
   ├─ 公众号归档索引.md
   ├─ 归档记录.json
   ├─ 日期 文章标题 [文章标识].md
   └─ 附件/
```

设置中可以更改笔记库内的保存文件夹，或关闭图片下载。点击“停止”会在当前请求结束后保留已保存文章；尚未完成的勾选可继续保存，重启插件也会恢复上次保存任务的未完成选择。已有同来源笔记不会覆盖，未勾选文章不会被下载或删除。切换文章链接或保存文件夹后需要重新获取目录。

## 遇到问题

| 提示或现象 | 处理方式 |
|---|---|
| 未连接到可用的微信页面 | 在电脑微信内重新打开目标公众号主页，再开始归档。 |
| 没有找到支持的网页缓存 | 确认使用 Windows 微信桌面版；不同微信版本的缓存布局可能不兼容。 |
| 微信要求验证 | 在微信中正常打开文章并完成验证，然后再试。 |
| 访问频率受限 | 暂停一段时间后再试，已有笔记会保留。 |
| 作者隐私设置限制 | 仅记录标题和原文入口，不生成空白成功笔记。 |
| 图片没有下载成功 | 笔记保留远程图片链接，并在归档记录中记下原因。 |

## 兼容性与覆盖范围

- 当前仅针对 **Windows 微信 4.1.6.14** 的网页缓存进行实测。插件使用 Obsidian 内置的 Node 能力，不支持移动端。
- 清单要求 Obsidian 1.8.0 及以上；这不是所有版本均已测试的承诺。
- “历史目录已遍历”表示接口返回了明确的末页信号。无法保证包含公众号曾经发表的所有内容，已删除、受限或未列入历史目录的文章可能无法获取。
- 微信网页接口及缓存格式可能变化。本项目不是微信或 Obsidian 官方产品。
- 音视频保留原文入口，不下载音视频本体，也不生成转写。付费或访问受限内容不作特殊处理。
- 笔记采用适合阅读的 Markdown 版式；不完全复刻微信模板的背景框、字体和定位效果。
- 当前验证包含实际目录及正文下载、图片引用检查、静态排版对照及模拟 Obsidian API 加载。尚无完整的真实 Obsidian 界面自动化验收，也没有覆盖所有公众号样式。

## 账号、网络与文件访问

- **账号 / Accounts**：获取整个公众号的历史目录需要本人已登录的 Windows 微信；公开合集通常不需要登录。插件不要求单独注册账号，不需要 API 密钥或付费服务。微信可能要求在其客户端完成验证。
- **联网 / Network**：只有使用者主动点击识别公众号、获取目录或保存所选文章时才会连接网络。文章、账号及目录请求发送至 `mp.weixin.qq.com`；图片请求仅允许 `qpic.cn`、`qlogo.cn`、`res.wx.qq.com` 及其子域名。使用 HTTPS，请求中的微信页面会话仅发送给微信文章域名，用于读取该用户当前可访问的内容。
- **笔记库外访问 / Files outside the vault**：全量历史目录功能会只读检查 `%APPDATA%\Tencent\xwechat\radium\web`、`%APPDATA%\Tencent\xwechat\radium\cache`，以及 `%APPDATA%\Tencent\WeChat` 下的 `XPlugin\Plugins\Radium`、`XPlugin\Plugins\XWeb` 和 `Cache` 目录中的网页缓存。这样做是为了找到目标公众号已打开网页的会话参数；不会修改这些目录。公开合集入口不扫描缓存。
- **本地保存 / Local storage**：文章、图片、公共来源链接、索引和进度只写入使用者选择的笔记库内文件夹；插件通过 Obsidian 的配置接口保存设置。粘贴链接在写入配置前先去除会话及追踪参数，旧配置在启动时进行相同清理。
- **离线 / Offline**：已保存的笔记、本地图片和目录可离线阅读。获取新目录、下载正文或图片需要网络；未下载成功而保留远程地址的图片也需要网络。

### 隐私说明

插件只扫描支持的微信**网页缓存**，并匹配本次指定的公众号；跳过聊天数据库、登录数据、独立 Cookie 数据库及聊天附件目录。会话参数在内存中用于请求微信接口，不写入插件配置、笔记和归档进度。插件没有广告、遥测、分析服务、AI 服务、第三方上传或后台下载任务，也不会自行更新插件或依赖库。

笔记库中保存文章内容、图片、公共来源链接和下载记录。若该笔记库启用了同步，这些文件也会按原有设置同步。

本仓库及 Release 仅包含插件代码、测试、说明和构建产物，不包含使用者的微信缓存、会话参数、下载文章或笔记库配置。

## 开发

开发环境需要 Node.js 22+：

```sh
npm ci
npm run build
npm test
```

构建产物位于 `dist/wechat-history-archive/`。运行所需第三方库已打包到 `main.js`，最终用户不用安装开发环境。

主要文件：

- `plugin/main.mjs`：Obsidian 面板、设置和归档任务。
- `src/core.mjs`：网址处理、微信请求与分页。
- `src/album.mjs`：合集链接识别、目录分页与篇数核对。
- `src/cache.mjs`、`src/chromium-cache.mjs`：本地网页缓存读取。
- `src/article-format.mjs`、`src/reading-layout.mjs`：正文和图片转换。
- `test/`：使用虚构会话数据和本地样例的自动测试；不会连接实际微信账号。

本项目采用 [MIT 许可证](LICENSE)。第三方库版权及许可证随安装包保存于 `THIRD-PARTY-NOTICES.txt`；项目许可证和第三方许可全文也包含在 `main.js` 的注释中，因此通过社区目录只安装三个运行文件时仍保留许可声明。更新说明见 [CHANGELOG.md](CHANGELOG.md)。

发布标签必须与 `manifest.json` 的版本完全一致，例如 `0.3.3`，不要增加 `v` 前缀。社区安装需要对应 Release 单独附上 `main.js`、`manifest.json`、`styles.css`；仅上传 ZIP 或源码包不满足安装要求。

问题反馈请使用本仓库的 [Issues](https://github.com/dtta520-cpu/obsidian-wechat-history/issues)。不要在反馈中粘贴微信会话参数、原始缓存、个人文章内容或笔记库配置。
