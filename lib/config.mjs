/**
 * `dsh-chrome-devtools` —— 配置层。
 *
 * 本模块只做三件事：
 *
 * 1. 声明 Host 行的 `Config`（schemastery schema）。**可配字段全部 `.volatile()`**：
 *    这是「设置 → 插件 → Chrome 浏览器」表单里能出现、能保存、且保存后立即生效的
 *    唯一开关（见 `docs/CONTRACT.md` §5.1）。行 id `chrome-devtools` 同时是设置
 *    命名空间，是承重结构，不要改名。
 * 2. `readOption` / `resolveOptions`：把「普通值」与「volatile 引用（带 `.get()`）」
 *    两种形态统一读成一份规范化纯对象，供 connection 层与工具层使用。
 * 3. `SCHEME_OPTIONS`：设置页「方案选择」下拉的选项（四个方案 id + 中英标签）。
 *
 * 本文件不 import 任何 `@deepseek-ai/*` 之外的东西，也不 import 本包其它模块的
 * 运行期符号（`@deepseek-ai/schemastery` 必须装进本包自己的 `node_modules`，
 * profile 的下 `require.resolve` 解析不到它）。
 *
 * @module chrome-devtools/config
 */

import z from '@deepseek-ai/schemastery';

/**
 * 四个连接方案的 id（顺序即设置页下拉顺序）。
 *
 * 与 `lib/schemes.mjs` 的 `SCHEMES` 同源；`test/settings.test.mjs` 会在
 * `lib/schemes.mjs` 可加载时校验两边 id 顺序一致。
 */
export const SCHEME_IDS = Object.freeze(['launch', 'auto-connect', 'browser-url', 'ws-endpoint']);

/** Chrome 渠道（与 `lib/chrome.mjs` 的 `CHANNELS` 同源）。 */
export const CHANNEL_IDS = Object.freeze(['stable', 'beta', 'dev', 'canary']);

/** 工具集形态：`full` 注册全部工具，`slim` 只注册契约 §5.2 标 ★ 的 5 个。 */
export const TOOLSET_IDS = Object.freeze(['full', 'slim']);

/** 默认连接方案。auto-connect 在本机实测可用且保留登录态；不可用时由 Host 报错并提示改用 launch。 */
export const DEFAULT_SCHEME = 'auto-connect';

/** 默认调试端点（方案 C）。 */
export const DEFAULT_BROWSER_URL = 'http://127.0.0.1:9222';

/** 默认窗口尺寸（方案 A）。 */
export const DEFAULT_VIEWPORT = '1280x800';

/**
 * 设置页下拉用的方案选项。
 *
 * 契约 §3.9 要求从 `lib/schemes.mjs` 的 `SCHEMES` 派生。这里保留一份**同源的静态
 * 副本**而不是静态 `import`：`lib/schemes.mjs` 与 `lib/config.mjs` 由不同 owner
 * 并行编写，静态 import 会让「配置模块」在它缺失时整体加载失败（把设置页一起带崩）。
 * `test/settings.test.mjs` 在 `lib/schemes.mjs` 可加载时会断言两者 id 顺序一致，
 * 所以这份副本不会悄悄漂移。
 *
 * 字段与 `SCHEMES` 对齐：`{ id, label, labelEn }`。
 */
export const SCHEME_OPTIONS = Object.freeze([
  Object.freeze({ id: 'launch', label: '方案 A：启动全新浏览器', labelEn: 'Launch a new browser' }),
  Object.freeze({ id: 'auto-connect', label: '方案 B：复用当前浏览器（autoConnect）', labelEn: 'Reuse the current browser (autoConnect)' }),
  Object.freeze({ id: 'browser-url', label: '方案 C：连接调试端口（browser-url）', labelEn: 'Connect to a debugging port (browser-url)' }),
  Object.freeze({ id: 'ws-endpoint', label: '方案 D：WebSocket 直连（wsEndpoint）', labelEn: 'Direct WebSocket endpoint (wsEndpoint)' }),
]);

/**
 * 该行的 Config schema。
 *
 * `.volatile()` 的字段会出现在设置表单里，保存后立即生效（值解析成带 `.get()` 的
 * 活引用）；这里**所有**字段都是 volatile —— 契约 §5.1 的 14 个字段没有一个是
 * 加载期配置，方案切换必须能在运行时热生效。
 *
 * 注意：按 id 定向的 patch 会**整块替换** `config`，不做深合并。所以
 * `cordis.patch.yml` 里写到的每个键都必须在下面声明，漏一个就会在校验时被丢掉。
 */
export const Config = z.object({
  /** 当前连接方案：launch / auto-connect / browser-url / ws-endpoint。 */
  scheme: z
    .string()
    .default(DEFAULT_SCHEME)
    .description('当前连接方案：launch / auto-connect / browser-url / ws-endpoint。')
    .volatile(),
  /** 方案 C 的调试端点（可写 http URL、host:port 或纯端口）。 */
  browserUrl: z
    .string()
    .default(DEFAULT_BROWSER_URL)
    .description('方案 C 的调试端点，例如 http://127.0.0.1:9222。')
    .volatile(),
  /** 方案 D 的 WebSocket 端点。 */
  wsEndpoint: z.string().default('').description('方案 D 的 WebSocket 端点，例如 ws://127.0.0.1:9222/devtools/browser/…。').volatile(),
  /** 方案 D 的自定义请求头（JSON 字符串；见契约 §3.3 的限制说明）。 */
  wsHeaders: z.string().default('').description('方案 D 的自定义请求头（JSON 字符串）。').volatile(),
  /** Chrome 渠道：stable / beta / dev / canary。 */
  channel: z.string().default('stable').description('Chrome 渠道：stable / beta / dev / canary。').volatile(),
  /** 显式 Chrome 可执行文件路径（空 = 按平台自动探测）。 */
  executablePath: z.string().default('').description('显式 Chrome 路径；空表示自动探测。').volatile(),
  /** 方案 A 是否无头启动。 */
  headless: z.boolean().default(false).description('方案 A 是否以无头模式启动。').volatile(),
  /** 方案 A 是否使用临时 profile（退出即删）。 */
  isolated: z.boolean().default(true).description('方案 A 是否使用临时 profile（退出即删）。').volatile(),
  /** 显式 user data dir（空 = 按 isolated 决定）。 */
  userDataDir: z.string().default('').description('显式 profile 目录；空表示按 isolated 决定。').volatile(),
  /** 方案 A 的窗口尺寸，形如 `1280x800`。 */
  viewport: z.string().default(DEFAULT_VIEWPORT).description('方案 A 窗口尺寸，形如 1280x800。').volatile(),
  /** 工具集：full 全部工具，slim 只保留契约 §5.2 标 ★ 的 5 个。 */
  toolset: z.string().default('full').description('工具集：full 为全部工具，slim 只保留核心 5 个。').volatile(),
  /** 截图目录（空 = `$DSH_HOME/chrome-devtools/screenshots`）。 */
  screenshotDir: z.string().default('').description('截图目录；空表示使用 $DSH_HOME/chrome-devtools/screenshots。').volatile(),
  /** 连接超时（毫秒）。 */
  connectTimeoutMs: z.number().step(1).min(500).default(15_000).description('连接超时（毫秒）。').volatile(),
  /** 单个动作超时（毫秒）。 */
  actionTimeoutMs: z.number().step(1).min(100).default(10_000).description('单个动作超时（毫秒）。').volatile(),
});

/**
 * 读取一个配置值，兼容普通值与 schemastery 的 volatile 引用（后者有 `.get()`）。
 *
 * 特性检测而不是 `typeof value === 'object'`：volatile 引用是对象且带 `get()`，
 * 但普通配置值也可能是对象（本插件目前没有对象字段，保持宽容）。
 *
 * @param {unknown} config 传给 `apply` 的行配置。
 * @param {string} key 字段名。
 * @param {unknown} fallback 缺失或为 null / 读取失败时的值。
 * @returns {unknown} 读到的值（可能是 undefined 之外的任何类型）。
 */
export function readOption(config, key, fallback) {
  if (config === null || config === undefined) return fallback;
  let value;
  try {
    value = config[key];
  } catch {
    return fallback;
  }
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const live = value.get();
      return live === undefined || live === null ? fallback : live;
    } catch {
      return fallback;
    }
  }
  return value;
}

/** 取非空字符串；空白字符串视同缺失。 */
function textOr(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return value.trim().length > 0 ? value : fallback;
}

/** 取字符串（允许空串，空串是「未设置」的合法表达）。 */
function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/** 取白名单内的字符串；不在白名单内回落到默认值。 */
function enumOr(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/** 取正数毫秒；非有限数或非正数回落默认值（取整，避免表单里出现小数）。 */
function positiveIntOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

/**
 * 把配置对象归一成 `{ ctx, config }` 里的 config。
 *
 * 契约 §3.9 的签名是 `resolveOptions(config)`；但 Host 半的调用方（`index.js`）可能
 * 像本工作区其它插件那样写成 `resolveOptions(ctx, config)`。两种都接受，不为此抛错。
 *
 * @param {unknown} first 第一参数。
 * @param {unknown} second 第二参数。
 * @returns {object | undefined} 配置对象。
 */
function pickConfig(first, second) {
  if (second !== undefined && second !== null) return second;
  if (first !== undefined && first !== null) return first;
  return undefined;
}

/**
 * config → 规范化纯对象（所有默认值补齐）。
 *
 * 每次调用都现读 volatile 引用，所以设置页保存后下一个操作就用上新值（选项必须按
 * thunk 传递，不能在 `apply` 里固化快照）。
 *
 * @param {object} [first] 行配置；也兼容 `(ctx, config)` 形态。
 * @param {object} [second] 行配置（两参形态时）。
 * @returns {{
 *   scheme: string, browserUrl: string, wsEndpoint: string, wsHeaders: string,
 *   channel: string, executablePath: string, headless: boolean, isolated: boolean,
 *   userDataDir: string, viewport: string, toolset: string, screenshotDir: string,
 *   connectTimeoutMs: number, actionTimeoutMs: number,
 * }} 纯对象配置快照。
 */
export function resolveOptions(first, second) {
  const config = pickConfig(first, second);
  return {
    scheme: enumOr(readOption(config, 'scheme', DEFAULT_SCHEME), SCHEME_IDS, DEFAULT_SCHEME),
    browserUrl: textOr(readOption(config, 'browserUrl', DEFAULT_BROWSER_URL), DEFAULT_BROWSER_URL),
    wsEndpoint: stringOr(readOption(config, 'wsEndpoint', ''), ''),
    wsHeaders: stringOr(readOption(config, 'wsHeaders', ''), ''),
    channel: enumOr(readOption(config, 'channel', 'stable'), CHANNEL_IDS, 'stable'),
    executablePath: stringOr(readOption(config, 'executablePath', ''), ''),
    headless: readOption(config, 'headless', false) === true,
    isolated: readOption(config, 'isolated', true) !== false,
    userDataDir: stringOr(readOption(config, 'userDataDir', ''), ''),
    viewport: (() => {
      const raw = readOption(config, 'viewport', DEFAULT_VIEWPORT);
      return typeof raw === 'string' && /^\d{1,5}x\d{1,5}$/u.test(raw.trim()) ? raw.trim() : DEFAULT_VIEWPORT;
    })(),
    toolset: enumOr(readOption(config, 'toolset', 'full'), TOOLSET_IDS, 'full'),
    screenshotDir: stringOr(readOption(config, 'screenshotDir', ''), ''),
    connectTimeoutMs: positiveIntOr(readOption(config, 'connectTimeoutMs', 15_000), 15_000),
    actionTimeoutMs: positiveIntOr(readOption(config, 'actionTimeoutMs', 10_000), 10_000),
  };
}

/**
 * 由方案 id 取设置页下拉标签（中文）。
 *
 * @param {string} scheme 方案 id。
 * @returns {string} 标签；未知 id 原样返回。
 */
export function schemeLabel(scheme) {
  const option = SCHEME_OPTIONS.find((item) => item.id === scheme);
  return option === undefined ? String(scheme ?? '') : option.label;
}
