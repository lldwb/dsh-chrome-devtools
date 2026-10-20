/**
 * `dsh-chrome-devtools` —— Host 半（接线层）。
 *
 * 让 agent 直接操作 Chrome。参考 chrome-devtools-mcp 的四方案设计，但用 dsh Host 插件
 * 原生重写：Node 内置 `fetch` + 全局 `WebSocket` 直连 CDP，不 `npx`、不引入 playwright/puppeteer。
 *
 * ## 四方案（可在设置页或 `browser_connect` 工具里切换）
 *
 * | id | 语义 |
 * |---|---|
 * | `launch` | 启动一个全新的 Chrome（`--remote-debugging-port=0` + 独立 profile） |
 * | `auto-connect` | 复用**用户正在用的** Chrome：读它的 `DevToolsActivePort` 直连，保留登录态 |
 * | `browser-url` | 连到已带 `--remote-debugging-port` 启动的 Chrome（`/json/version`） |
 * | `ws-endpoint` | 直连给定 WebSocket 端点 |
 *
 * 四个方案共用同一套工具（`browser_*`），差异只体现在连接建立方式上——所以「切换方案」
 * 就是断开旧连接、按新方案建连，工具层完全无感。
 *
 * ## 装配
 *
 * - 工具：`lib/tools.mjs` 的 `buildTools()`，按 `toolset` 过滤后注册到 `ctx.tools`。
 *   行是全局插入的，所以**任何模式的 agent 都能用浏览器工具**。
 * - 配置：`lib/config.mjs` 的 schemastery `Config`，字段全部 `.volatile()`（设置页可改）。
 * - 设置页：`client.js`（浏览器半）自己画，Host 半用 `settings.configure({auto:false})` 关掉自动页，
 *   并提供 `lib/settings.mjs` 的 RPC 通道。
 * - 生命周期：插件卸载时 `BrowserManager.dispose()` 只关闭**本插件自己启动**的 Chrome；
 *   别人的浏览器（auto-connect / browser-url / ws-endpoint）永不 kill。
 *
 * @module dsh-chrome-devtools
 */

import { Config, resolveOptions } from './lib/config.mjs';
import { BrowserManager } from './lib/connection.mjs';
import { installRpcChannel } from './lib/settings.mjs';
import { buildTools } from './lib/tools.mjs';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'chrome-devtools';

/**
 * 该行声明的 Config schema。
 *
 * 导出是必须的：Loader 用它把 `cordis.patch.yml` 里的 `config` 校验并投影成设置页的
 * 命名空间；没有它就没有「设置 → 插件 → Chrome 浏览器」这一页。
 */
export { Config };

/**
 * `tools` 是硬依赖：没有工具注册表，这个插件没有存在意义。
 *
 * 其余服务（`settings` / `connection` / `webServer`）一律**可选**：headless profile
 * 里没有设置页，缺少它们时插件仍应能注册工具并工作（那是回归测试的主要形态）。
 */
export const inject = ['tools'];

/** `toolset: "slim"` 时保留的工具（对应 chrome-devtools-mcp 的 `--slim`）。 */
const SLIM_TOOLS = new Set([
  'browser_status',
  'browser_connect',
  'browser_navigate',
  'browser_screenshot',
  'browser_ping',
]);

/**
 * 安装插件。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 该行的 Config（schemastery 实例，可含 volatile 引用）。
 */
export function apply(ctx, config) {
  const logger = ctx.logger;
  const manager = new BrowserManager(() => resolveOptions(config), logger);

  // 1) 工具注册。toolset 在注册时读取一次：切换到 slim 需要重启应用（README 里写明）。
  //    工具定义只依赖注入进来的 deps，不读全局状态，便于单测。
  ctx.effect(() => {
    const options = resolveOptions(config);
    const definitions = buildTools({
      manager,
      getConfig: () => resolveOptions(config),
      logger,
    });
    const selected =
      options.toolset === 'slim' ? definitions.filter((definition) => SLIM_TOOLS.has(definition.name)) : definitions;
    const disposers = selected.map((definition) => ctx.tools.register(definition));
    logger?.debug?.(`[chrome-devtools] 已注册 ${selected.length} 个工具（toolset=${options.toolset}）`);
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 工具注销失败不该让插件卸载失败。
        }
      }
    };
  }, 'chrome-devtools: tools');

  // 2) 设置页策略：关掉自动生成页，改由 client.js 自己画（见 lib/settings.mjs 的 RPC）。
  ctx.inject?.(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'chrome-devtools: settings presentation policy',
    );
  });

  // 3) 浏览器半使用的 RPC 通道（status / probe / connect / disconnect）。
  installRpcChannel(ctx, config, manager);

  // 4) 生命周期：插件卸载时释放连接、关掉本插件启动的 Chrome。
  ctx.effect(
    () => () => {
      void manager.dispose();
    },
    'chrome-devtools: lifecycle',
  );

  logger?.info?.('[chrome-devtools] 已加载：浏览器工具就绪（scheme 见设置页或 browser_status）');
}
