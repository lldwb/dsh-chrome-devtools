# dsh-chrome-devtools

让 DeepSeek Harness（dsh）的 agent 直接操作你的 Chrome：导航、截图、DOM 快照、点击、填表、执行 JS、读控制台与网络请求。

它的设计参考了 [Chrome DevTools MCP × Claude Code 完整配置指南](https://www.cnblogs.com/max/p/19749818) 里的四种连接方案，
但**不是**对 `chrome-devtools-mcp` 的 MCP 包装：插件用 dsh Host 插件原生重写，直接用 Node 内置的 `fetch` 与
`WebSocket` 说 CDP（Chrome DevTools Protocol），**不 npx、不需要 Node 之外的运行时依赖**。

四种连接方案可以在**设置页**里选，也可以在运行时用 `browser_connect` 工具随时切换：

| 方案 | id | 适用场景 | 是否保留登录态 | Chrome 版本 |
|---|---|---|---|---|
| **A. 启动全新浏览器** | `launch` | CI / 自动化 / 干净环境 | 否（全新临时 profile） | 任意 |
| **B. 复用当前浏览器**（autoConnect） | `auto-connect` | 日常调试：直接用你正在用的 Chrome，保留 Cookie、登录态与已打开的标签页 | 是 | 144+ |
| **C. 连接调试端口**（browser-url） | `browser-url` | 老版本 Chrome，或想精确控制调试端口 | 取决于 profile | 任意 |
| **D. WebSocket 直连**（ws-endpoint） | `ws-endpoint` | 已有 `webSocketDebuggerUrl`、需要直连（如远端/容器） | 取决于目标 | 任意 |

> 默认方案是 **B（auto-connect）**：本机实测只要 Chrome 144+ 且在 `chrome://inspect/#remote-debugging` 里允许过远程调试，
> 插件就能读到用户 profile 下的 `DevToolsActivePort` 并直连——不用重启浏览器，也不用带任何调试参数。

## 安装

插件是标准的 dsh bundle（`dsh.bundle.patch`），Host 半注册工具，Client 半画设置页。

```powershell
# 1) 装进当前 profile（本地路径即可）
dsh plugin --profile desktop add <本插件目录>

# 2) 插件包自带依赖（@deepseek-ai/schemastery），装好后在插件目录跑一次
cd <本插件目录>
npm install

# 3) 重启 DeepSeek Harness（Loader 按 URL 缓存模块，改代码/新装插件都要重启）
```

装好后，任意模式的 agent 都会多出一组 `browser_*` 工具，并且「设置 → 插件 → Chrome 浏览器」里出现配置页。

## 工具

| 工具 | 作用 |
|---|---|
| `browser_status` | 当前方案、连接状态、Chrome 版本、四个方案的可用性探测 |
| `browser_connect` | 按方案连接（可临时覆盖 scheme / 地址 / headless 等参数） |
| `browser_disconnect` | 断开连接（可选关闭本插件启动的 Chrome） |
| `browser_navigate` | 打开 URL（可选新标签页、等待策略） |
| `browser_list_pages` | 列出所有标签页 |
| `browser_select_page` | 切换激活标签页 |
| `browser_close_page` | 关闭标签页 |
| `browser_screenshot` | 截图落盘（PNG/JPEG，支持整页），返回文件路径 |
| `browser_snapshot` | 生成页面可交互元素清单（含稳定 CSS selector），给模型定位元素用 |
| `browser_console` | 读取控制台消息与未捕获异常 |
| `browser_network` | 读取网络请求（方法、状态码、类型、失败原因） |
| `browser_click` | 真实鼠标事件点击元素中心 |
| `browser_fill` | 填表单（单字段或批量；对 React/Vue 受控组件生效） |
| `browser_type` | 逐字符键入文本 |
| `browser_press_key` | 按键（Enter/Tab/Escape/方向键/F1-F12 等） |
| `browser_hover` | 鼠标悬停 |
| `browser_drag` | 拖拽（从元素到元素） |
| `browser_wait_for` | 等待选择器出现或文本可见 |
| `browser_handle_dialog` | 处理 alert/confirm/prompt |
| `browser_upload_file` | 给 `<input type=file>` 设置文件 |
| `browser_evaluate` | 在页面上下文执行 JS |
| `browser_ping` | 最小连通性自检 |

`slim` 模式（配置项 `toolset: "slim"`）只注册 `browser_status` / `browser_connect` / `browser_navigate` /
`browser_screenshot` / `browser_ping` 五个，对应 `chrome-devtools-mcp --slim`。

## 配置

设置页里每个字段都可改、保存即生效：

| 字段 | 默认 | 说明 |
|---|---|---|
| `scheme` | `auto-connect` | 当前连接方案 |
| `browserUrl` | `http://127.0.0.1:9222` | 方案 C 的调试端点 |
| `wsEndpoint` | 空 | 方案 D 的 WebSocket 地址 |
| `wsHeaders` | 空 | 方案 D 的自定义 HTTP 头（JSON）。**必须留空**，见下方「方案 D 的限制」 |
| `channel` | `stable` | Chrome 渠道：stable / beta / dev / canary |
| `executablePath` | 空 | 显式 Chrome 路径（空 = 自动探测） |
| `headless` | `false` | 方案 A 是否无头 |
| `isolated` | `true` | 方案 A 用临时 profile（退出即删） |
| `userDataDir` | 空 | 显式 profile 目录 |
| `viewport` | `1280x800` | 方案 A 窗口尺寸 |
| `toolset` | `full` | `full` / `slim`（切换后需重启应用） |
| `screenshotDir` | 空 | 截图目录（空 = `$DSH_HOME/chrome-devtools/screenshots`） |
| `connectTimeoutMs` | `15000` | 连接超时 |
| `actionTimeoutMs` | `10000` | 单个动作超时 |

## 复用当前浏览器（方案 B）怎么开

1. Chrome 版本 ≥ 144（`chrome://settings/help` 查看）；本机实测 155 可用。
2. 打开 `chrome://inspect/#remote-debugging`，在页面里**允许远程调试**。
3. 设置页把方案切到「方案 B：复用当前浏览器（autoConnect）」，点「测试连接」。
4. 首次连接 Chrome 可能弹一次确认框，点允许。

插件的工作方式是读 `<userDataDir>/DevToolsActivePort`（两行：端口 + `/devtools/browser/<id>`），
再用 Node 的全局 `WebSocket` 连 `ws://127.0.0.1:<port><path>`。
这个端口的 HTTP JSON 路由（`/json/version`）在当前 Chrome 上返回 404 是**正常现象**，不要用它判断可用性。

## 手动开调试端口（方案 C）

Chrome 136+ 禁止对默认 profile 开远程调试，必须指定独立 profile：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\chrome-debug-profile"
```

然后 `curl http://127.0.0.1:9222/json/version` 能看到 `webSocketDebuggerUrl` 就说明端点活着；
设置页把方案切到「方案 C」并填 `browserUrl`，或直接 `browser_connect`。

## 方案 D 的限制（重要）

Node 22/24 内置的全局 `WebSocket` 构造函数是 `new WebSocket(url, protocols)`：**既没有 headers 选项，
也会静默丢弃 URL 里内嵌的凭据**（实测：`ws://user:pass@host/x` 发出的 upgrade 请求不带 `Authorization`，
`new WebSocket(url, {headers})` 不报错但忽略）。所以本插件对方案 D 的处理是：

- `wsEndpoint` 指向**无需鉴权**的 CDP 端点时正常连接；
- `wsHeaders` 非空、或 `wsEndpoint` 里带凭据时，**明确报 `INVALID_ARGUMENT`** 而不是静默失败。

需要鉴权的场景请先在本地做端口转发（例如 `ssh -L 9222:127.0.0.1:9222 user@host`），再用方案 C
连 `http://127.0.0.1:9222`。

## 常见问题

**Q：`browser_status` 显示 `CONNECT_FAILED` / `NO_DEBUG_ENDPOINT`？**
方案 B 需要 Chrome 144+ 且已在 `chrome://inspect/#remote-debugging` 允许调试；否则改用方案 A（全新浏览器）或方案 C。

**Q：为什么截图不直接返回图片？**
截图落盘并返回路径，用 dsh 的 `read_image` 打开即可。这样不会把 base64 塞进上下文。

**Q：agent 怎么知道该点哪个元素？**
先 `browser_snapshot`，它输出可交互元素清单与稳定 CSS selector，然后用 `browser_click` / `browser_fill`。

**Q：会不会控制、关闭我自己正在用的浏览器？**
方案 B/C/D 只建立连接，**从不关闭**别人的浏览器；只有方案 A 启动的 Chrome 会由插件在断开/卸载时关闭。
`browser_disconnect` 的 `closeBrowser` 参数也只会影响插件自己启动的那个实例。

**Q：改了 `toolset` 为什么不生效？**
工具的注册发生在插件加载时，`toolset` 改动需要重启应用；其余字段（方案、地址、超时等）保存即生效。

## 安全提示

方案 B 复用你的真实浏览器会话，agent 因此能读到当前页面内容、执行 JS。请只在可信的开发环境使用；
不需要浏览器能力时，可在插件管理里禁用本插件，或先把方案切到 A。

## 仓库

- 源代码与问题反馈：<https://github.com/lldwb/dsh-chrome-devtools>
- 许可证：MIT

## 验证记录

真机验证环境：Windows 11 + Chrome 155.0.8059.82 + dsh 自带 Node 24.21.0。

- **离线单测**：`node --test "test/**/*.test.mjs"` → **295 / 295 通过**。CDP 协议层用自建的 fake WebSocket 服务器测
  （不使用真实 Chrome 当单测依赖）；工具层镜像 dsh 的两道校验（schema 子集 + 返回值匹配 `output.schema`），并对 22 个工具逐个执行。
  另有两道独立审计：`test/tool-schema.test.mjs`（工具层自带）与 `test/lead-schema-audit.mjs`（独立实现，两套实现互相钉住）。
- **真机 E2E（方案 A）**：`node test/e2e-cdp.mjs` → 14 PASS / 0 FAIL。headless Chrome 自选端口启动 → 读 `DevToolsActivePort`
  → `Browser.getVersion` → `Target.getTargets` → 建 target → `Runtime.evaluate` → 截图（PNG 魔数校验）→ 清理进程与临时 profile。
- **真机 E2E（方案 B）**：读用户 profile 的 `DevToolsActivePort` → WebSocket 101 → 以**裸 `CdpConnection`**（不调
  `Target.setAutoAttach`）只读取 `Browser.getVersion` + `Target.getTargets` 后断开，未对用户浏览器做任何操作。
- **devkit 沙箱回归（真实 Loader，不是 mock）**：
  - 插件装进 headless 沙箱 → 合成树出现 `- id: chrome-devtools` → 22 个工具真实注册；
  - 方案 A 全链路真机：`browser_connect(launch)` → `browser_navigate(about:blank)` → `browser_evaluate` 注入表单
    → `browser_snapshot`（返回 `- input => #q`、`- button "Go" => #b`）→ `browser_fill('#q','hello')`
    → `browser_click('#b')` → `browser_evaluate` 读出 `clicked hello`（证明填值与点击真的生效）→ `browser_wait_for`
    → `browser_screenshot`（PNG 落盘）→ `browser_disconnect(closeBrowser:true)`；
  - 方案 B 真机：`browser_status` 显示 auto-connect 可用 → `browser_list_pages` 列出用户当前真实标签页
    → `browser_disconnect(closeBrowser:false)` 后用户浏览器保持运行。
- **设置页 UI 回归**：web 沙箱 + headless Chrome 打开「设置 → 插件 → Chrome 浏览器」，切换方案、点「测试连接」验证
  RPC 通道（非 405）与状态/探测区渲染。
