# 更新日志

本文件记录 `dsh-chrome-devtools` 的所有重要变更。

## 0.1.0 — 2026-10-20

首个版本。

- 四方案连接管理器：`launch`（全新 Chrome）、`auto-connect`（复用当前浏览器，读 `DevToolsActivePort`）、
  `browser-url`（`/json/version`）、`ws-endpoint`（WebSocket 直连）；可在设置页或运行时切换。
- 零运行时外部依赖：只用 Node 内置 `fetch` 与全局 `WebSocket` 直连 CDP，不依赖 `chrome-devtools-mcp` / playwright / puppeteer。
- 22 个 `browser_*` 工具：状态与连接、页面导航与标签页、截图、DOM 快照、点击/填表/键入/按键/悬停/拖拽、
  等待、弹窗、文件上传、JS 执行、控制台与网络请求；`toolset: "slim"` 提供 5 个精简工具。
- 设置页：方案下拉、各方案参数、测试连接、状态与四方案可用性探测。
- 生命周期安全：只关闭本插件自己启动的 Chrome，绝不关闭用户的浏览器。
