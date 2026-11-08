# Mac 使用说明

0.5.0 使用标准 Obsidian 桌面插件格式，无需额外运行 Python、Node.js、Docker 或 AI 服务。

## 安装

1. 将安装包中的 `wechat-history-archive` 文件夹放入目标笔记库的 `.obsidian/plugins/`。
2. 在 Finder 中按 `Command + Shift + .` 可显示 `.obsidian` 隐藏文件夹。
3. 确认插件目录中直接包含 `main.js`、`manifest.json` 和 `styles.css`。
4. 在 Obsidian 的“设置 → 第三方插件”中启用 WeChat Official Account Archive。
5. 点击“微信公众号归档”，粘贴公开文章链接，选择“保存单篇文章”。合集链接则选择“获取文章目录”。

更新时保留原有 `data.json`、笔记和附件。Mac 和 Windows 使用相同插件 ID，不需要迁移数据。只替换运行文件，不要用一个空文件夹覆盖整个已有插件目录。

## 功能范围

- 单篇文章、图片归档、公开合集、手动勾选和重复保存保护已加入 Mac 路径。
- macOS 上的自动测试覆盖单篇正文与图片、合集目录与所选文章、保留用户编辑、平台限制，以及缓存读取范围、格式、预算和权限失败。
- 2026-11-08，在 macOS 27.2 / Apple Silicon / Obsidian 1.14.5 的独立测试库中成功加载插件，实际保存一篇用户提供的公开文章及 6 张本地图片，归档记录没有图片警告；重载后重复保存提示保留已有笔记，文章内容校验值保持不变。
- 公开合集通过 Mac 平台模拟 Obsidian API 的目录、勾选及保存测试，尚未使用真实合集链接实测。
- **Mac 公众号历史目录为实验功能，尚未验证完整可用。** 只支持微信 4.x 中兼容的网页缓存，不支持旧 WebKit 缓存或聊天数据库。

## 公众号历史目录

在本人已登录的电脑微信中打开目标公众号主页，再请求目录。Mac 适配仅检查：

```text
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/web
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/cache
```

只读取近期 Chromium Simple Cache v5 条目的 URL key，并只使用匹配目标公众号的会话。跳过聊天、登录、Cookie 数据库、附件及符号链接。会话只在内存中使用，不写入设置、笔记或发布包。

如果系统拒绝读取，插件会提示“系统未允许 Obsidian 读取微信网页缓存”。不要把这一结果视作公众号没有历史文章。单篇和公开合集无需缓存权限，可以继续使用。插件不会自动调整系统隐私权限。

在本次 macOS 27.2 环境中，对应开关位于“系统设置 → 隐私与安全 → 文件与文件夹 → Obsidian → 微信”。这是微信应用数据访问权限，范围大于单个网页缓存目录，是否开启由使用者决定。本次保持关闭。

本次真实历史目录测试停止于上述系统权限限制，归档记录标记为 `INCOMPLETE / CACHE_ACCESS_DENIED`。未获取历史目录，也未证明登录会话或分页接口可用。

缓存路径、格式和微信接口可能改变。即使接口明确返回末页，也只代表当前可访问的目录已遍历，不代表所有历史文章都可取得。

## 适配依据

- [Chromium Simple Cache 结构定义](https://github.com/chromium/chromium/blob/main/net/disk_cache/simple/simple_entry_format.h)：校验文件头、版本和 key 长度，只读取 key。
- [Mac 微信 4.x 缓存路径的公开实测记录](https://gist.github.com/acmerfight/755b373b0b27b0ab58431eb4d46cde76)：仅用于定位候选网页缓存范围；不代表本插件已通过真实历史目录测试。

运行 `npm ci` 和 `npm run check` 可重现自动检查。测试不读取实际微信缓存，不连接用户账号。
