# 更新日志

本文件记录 `dsh-chrome-devtools` 的所有重要变更。

## 0.1.7 — 2026-11-12

修复「设置页选方案 A、点『应用并连接』却提示『复用已有浏览器』」的误导
（用户报告：明明选的是方案 A，看起来却像用了方案 B）。

- **根因**：`lib/connection.mjs` 的 `connect()` 在「已有连接且方案相同」时提前返回
  `reused: true` —— 它只表示「本次没有新建 CDP 连接」，与方案无关（方案 A 先点
  「测试连接」再点「应用并连接」必然走到这里）。`client.js` 的 `connectSummary()`
  把这个 `reused` 直接渲染成「复用已有浏览器」（方案 B 的措辞），而 RPC 已经返回的
  `schemeLabel` 完全没用上。于是方案 A 复用已建立的连接被显示成方案 B，用户自然
  以为插件偷偷换了方案（状态区的「当前方案」其实一直是对的）。
- **修复**：把两个语义拆开 —— `connectionReused`（复用已建立的连接，与方案无关）与
  `browserReused`（浏览器不是本插件启动的，即方案 B/C/D）。连接摘要固定显示**实际方案
  标签**，并按 `connectionReused → browserReused → launchedPid>0` 选择措辞：「复用已建立
  的连接（PID N）」/「复用你正在用的浏览器」（仅方案 B）/「已连接到外部 Chrome」（方案 C/D）/
  「启动新浏览器（PID N）」。
  「测试连接 / 应用并连接」现在把表单里选中的 `scheme` 显式放进 RPC payload，「应用」
  等于「所见即所连」，不再依赖保存与读取配置之间的时序。
  `browser_connect` 工具的 `note` 同步改为「复用已建立的连接（<方案标签>）」/
  「新建连接（已启动 Chrome，pid N）」/「新建连接（已连接到外部 Chrome）」。
- **兼容性**：`reused` 字段保留（= `connectionReused`），旧调用方不受影响；新增
  `connectionReused` / `browserReused` / `note`。
- **验证**：`npm test`（= `node --test "test/**/*.test.mjs"`）→ 312/312 通过；devkit web UI 沙箱真实界面回归：修复前逐字复现
  「已应用并连接：Chrome 版本 …, 复用已有浏览器」，修复后同一操作显示
  「已应用并连接：方案 A：启动全新浏览器，Chrome 版本 …, 复用已建立的连接（PID …）」，
  状态区「当前方案」始终是方案 A。

## 0.1.6 — 2026-11-11

图标重绘与卡片插画同步。

- 重绘 `icon.svg`：蓝渐变浏览器窗口 + **深色标题栏**（三个白点收进标题栏）+ 白色指针，
  标题栏与内容区分明，缩到 16×16 仍能读出「浏览器自动化」；36×36、透明底、无容器、
  官方色板与构图语言不变（规范见 devkit skill
  `dsh-plugin-development/references/icon-design-language.md`）。
- `client.js` 的 `ITEM_ARTWORK_URI` 用 `embed-plugin-artwork.mjs` 重新生成，与 `icon.svg`
  逐字节一致（`embed-plugin-artwork.mjs . --check` → 状态: 一致）。
- `node --test` → 301/301 通过。

## 0.1.5 — 2026-11-10

图标与「内置插件配置」卡片插画。

- 重绘 `icon.svg`：36×36 蓝渐变浏览器窗口 + 三个白点 + 白色指针，一眼读出「浏览器自动化」；
  与官方 artwork 同一套色板与构图语言（规范见 devkit skill
  `dsh-plugin-development/references/icon-design-language.md`）。
- client 半新增插画注册：`ITEM_ARTWORK_ID` / `ITEM_ARTWORK_URI` / `registerItemArtwork()`，
  在 `apply()` 里把 `icon.svg` 的 data URI 登记进
  `globalThis.__DSH_PLUGIN_ITEM_ARTWORK__['chrome-devtools']`。
- 新增 `test/client-artwork.test.mjs`（6 用例，含逐字节一致与注册/注销语义）；`node --test` → 301/301 通过。

## 0.1.4 — 2026-11-06

适配 **DSH 0.2.2-rc.1**。**无代码改动**——用到的 Host / Client 契约在 0.2.2 未发生破坏性变化，
本次只补回归证据与版本记录（`node --test` 295/295 通过）。

- 真实桌面版（0.2.2-rc.1，profile `desktop`）：`chrome-devtools` 行 `fiberPhase=active`；`browser_status` 正常
  （`launch` 可用、`auto-connect` 可用且为当前方案、`browser-url` 不可用、`ws-endpoint` 未配置）。
- devkit web 沙箱（`ui-chromedev`）UI 回归：client 半进入页面清单；点「插件 → Chrome 浏览器」进入设置页，
  四方案下拉 / 渠道 / Profile 目录 / 工具集 / 截图目录 / 两个超时全部渲染，「重新探测」RPC 返回四方案可用性，
  控制台 **0 错误**。

## 0.1.3 — 2026-10-27

插件图标改为手绘 SVG，对齐 dsh 官方插件图标的矢量语言（36×36、透明底、官方蓝色渐变、同一描边与留白）：
`icon.png` → `icon.svg`，`package.json` 的 `icon` 与 `files`、`test/lead-release-check.mjs` 的
`expectedFiles` 同步更新。纯资源与清单改动，不涉及代码逻辑。

## 0.1.2 — 2026-10-27

插件图标换成 gpt-image-2.5 生成的 PNG 图标（256×256，圆角透明）：`icon.svg` → `icon.png`，
`package.json` 的 `icon` 与 `files`、`test/lead-release-check.mjs` 的 `expectedFiles` 同步更新。
纯资源与清单改动，不涉及代码逻辑。

## 0.1.1 — 2026-10-24

修复 Windows 上「方案 A（启动全新浏览器）的 Chrome 窗口不可见」的 bug。

- **根因**：`launchChrome` 用 `spawn(..., { windowsHide: true })` 启动 Chrome。Windows 会让
  Chrome 继承「隐藏窗口」的启动信息：主窗口照常创建（hwnd 存在、标题
  `about:blank - Google Chrome`、尺寸也对），但 `IsWindowVisible` 为 `false`。结果是屏幕上
  只剩一块白色残影，用户会误以为插件启动了个坏窗口。
- **修复**：有头模式改用 `windowsHide: false`（`stdio: 'ignore'` 已足够，不需要靠它隐藏控制台）；
  headless 模式本身不建窗口，与该选项无关。
- **验证**：同一套启动参数只改这一个选项，实测 `windowsHide=true → visible=False`、
  `false → visible=True`；修复后用插件自己的 `launchChrome` 冷启动，窗口
  `visible=True 1281×801 title='about:blank - Google Chrome'`。`node --test` 295/295 通过。

## 0.1.0 — 2026-10-20

首个版本。

- 四方案连接管理器：`launch`（全新 Chrome）、`auto-connect`（复用当前浏览器，读 `DevToolsActivePort`）、
  `browser-url`（`/json/version`）、`ws-endpoint`（WebSocket 直连）；可在设置页或运行时切换。
- 零运行时外部依赖：只用 Node 内置 `fetch` 与全局 `WebSocket` 直连 CDP，不依赖 `chrome-devtools-mcp` / playwright / puppeteer。
- 22 个 `browser_*` 工具：状态与连接、页面导航与标签页、截图、DOM 快照、点击/填表/键入/按键/悬停/拖拽、
  等待、弹窗、文件上传、JS 执行、控制台与网络请求；`toolset: "slim"` 提供 5 个精简工具。
- 设置页：方案下拉、各方案参数、测试连接、状态与四方案可用性探测。
- 生命周期安全：只关闭本插件自己启动的 Chrome，绝不关闭用户的浏览器。
