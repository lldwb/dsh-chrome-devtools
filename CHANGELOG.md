# 更新日志

本文件记录 `dsh-chrome-devtools` 的所有重要变更。

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
