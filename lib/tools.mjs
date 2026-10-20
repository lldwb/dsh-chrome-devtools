/**
 * 工具层：把浏览器语义层包装成 dsh 的 22 个 `browser_*` 工具。
 *
 * ## 这一层的两条硬约束（踩过坑，别放松）
 *
 * 1. **schema 必须落在 dsh 支持的严格 JSON Schema 子集里**。第三方插件不能 import
 *    `@deepseek-ai/dsh-tools`（profile 下解析不到），所以只能手写 register 的编译后形态：
 *    只允许 `type` / `oneOf` / `properties` / `required` / `additionalProperties` /
 *    `items` / `enum` / `const` + 注释键；`required` 必须是字符串数组且名字都在
 *    `properties` 里；`type` 必须是单个字符串。写错一个属性级 `required: true`，
 *    整个插件都不会激活。本文件的 `prop()` / `objectSchema()` 在构建期就拒绝非法键。
 * 2. **execute 的返回值必须严格匹配自己声明的 `output.schema`**。所有输出 schema 都是
 *    `additionalProperties: false` 且**每个字段都必填**（契约 §4：可选字段用空值表达，
 *    不要省略——省略会被判成 not lossless JSON / 缺 required 字段）。新增字段必须同步
 *    改 schema，否则运行时报 `tool returned invalid output`。
 *
 * ## 依赖注入
 *
 * `buildTools(deps)` 只拿 `{ manager, getConfig, logger }`（可选 `schemes`）：不自己建连接、
 * 不读全局状态。页面句柄按 targetId 缓存在 `buildTools` 的闭包里，这样控制台/网络缓冲
 * 在多次工具调用之间是连续的。
 *
 * ## 工具与 slim 模式
 *
 * 22 个工具的顺序与契约 §5.2 一致；`toolset: "slim"` 时只返回 ★ 标记的 5 个
 * （`browser_status` / `browser_connect` / `browser_navigate` / `browser_screenshot` /
 * `browser_ping`）。`index.js` 也会再过滤一次，幂等。
 *
 * @module lib/tools
 */

import path from 'node:path';

import { BrowserError } from './errors.mjs';
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  PageHandle,
  asBrowserError,
  redactUrl,
  resolveScreenshotDir,
  screenshotFileName,
  truncateText,
} from './page.mjs';

/** 工具名（契约 §5.2，顺序即注册顺序）。 */
export const TOOL_NAMES = Object.freeze([
  'browser_status',
  'browser_connect',
  'browser_disconnect',
  'browser_navigate',
  'browser_list_pages',
  'browser_select_page',
  'browser_close_page',
  'browser_screenshot',
  'browser_snapshot',
  'browser_console',
  'browser_network',
  'browser_click',
  'browser_fill',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_upload_file',
  'browser_drag',
  'browser_evaluate',
  'browser_ping',
]);

/** `toolset: "slim"` 时保留的工具（契约 §5.2 ★）。 */
export const SLIM_TOOL_NAMES = Object.freeze([
  'browser_status',
  'browser_connect',
  'browser_navigate',
  'browser_screenshot',
  'browser_ping',
]);

/** 四个连接方案的 id（与 lib/schemes.mjs / lib/config.mjs 同源）。 */
const SCHEME_IDS = Object.freeze(['launch', 'auto-connect', 'browser-url', 'ws-endpoint']);

/** 方案标签的静态副本：仅当 `lib/schemes.mjs` 不可用（单测/半成品 profile）时兜底。 */
const SCHEME_LABELS = Object.freeze({
  launch: '方案 A：启动全新浏览器',
  'auto-connect': '方案 B：复用当前浏览器（autoConnect）',
  'browser-url': '方案 C：连接调试端口（browser-url）',
  'ws-endpoint': '方案 D：WebSocket 直连（wsEndpoint）',
});

/** `waitFor` / 动作参数的默认超时（毫秒）。 */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/** 单个 evaluate 结果进入工具输出前的字符上限。 */
const EVALUATE_RESULT_MAX_CHARS = 8_000;

/** 同时接受 `date` 判断用的格式集合。 */
const SCREENSHOT_FORMATS = Object.freeze(['png', 'jpeg']);

/** 支持等待的导航状态。 */
const WAIT_UNTIL_VALUES = Object.freeze(['load', 'domcontentloaded', 'networkidle0', 'none']);

/** 控制台类型过滤的枚举值。 */
const CONSOLE_TYPES = Object.freeze(['log', 'info', 'warning', 'warn', 'error', 'debug', 'exception']);

/* ------------------------------------------------------------------ *
 * 严格 JSON Schema 构建器（镜像 dsh register 期的校验）
 * ------------------------------------------------------------------ */

/** dsh 支持的 schema 键（约束 + 注解）。 */
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

/** dsh 支持的 `type` 取值（单个字符串）。 */
const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** `oneOf` 旁边不允许出现的键。 */
const ONEOF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/**
 * 构建一个属性 schema 节点；构建期拒绝任何 dsh 不支持的键。
 *
 * @param {string} type - 单个 JSON Schema 类型。
 * @param {string} [description] - 面向模型的说明。
 * @param {Record<string, unknown>} [extra] - 其它受支持的键（`enum` / `items` / `default` …）。
 * @returns {Record<string, unknown>} schema 节点。
 */
function prop(type, description, extra = {}) {
  if (!SUPPORTED_TYPES.has(type)) throw new Error(`tools: unsupported schema type "${String(type)}"`);
  const node = { type };
  if (description !== undefined) node.description = description;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) throw new Error(`tools: schema key "${key}" is outside the dsh subset`);
    node[key] = value;
  }
  return node;
}

/**
 * 构建严格 object schema：`additionalProperties: false`，`required` 名都在 `properties` 里。
 *
 * @param {Record<string, unknown>} properties - 属性 schema。
 * @param {string[]} [required] - 必填字段名（默认全部必填）。工具**输出**一律全部必填：
 *   契约 §4 要求可选字段用空值表达而不是省略。
 * @returns {Record<string, unknown>} object schema 节点。
 */
function objectSchema(properties, required = Object.keys(properties)) {
  const names = Array.isArray(required) ? required : [];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) {
      throw new Error(`tools: required "${name}" is not declared in properties`);
    }
  }
  const node = { type: 'object', additionalProperties: false, properties };
  if (names.length > 0) node.required = [...names];
  return node;
}

/** 一段文本内容块（render 返回数组的元素）。 */
function textBlock(text) {
  return { type: 'text', text: String(text ?? '') };
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 取字符串，否则默认值。 */
function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** 取非空字符串（trim 后），否则默认值。 */
function nonEmptyString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text === '' ? fallback : text;
}

/** 取整数并夹在区间内。 */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** sleep（点击后等导航用）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * 读一个配置值，兼容普通对象与 schemastery 的 volatile 引用（带 `.get()`）。
 *
 * 这里不 import `lib/config.mjs`：`index.js` 已经把 `resolveOptions()` 的结果传进来，
 * 本模块保持零额外依赖即可（也避免把 schemastery 带进单测）。
 *
 * @param {unknown} source - 配置快照。
 * @param {string} key - 字段名。
 * @param {unknown} fallback - 缺失时的值。
 * @returns {unknown} 配置值。
 */
function readOption(source, key, fallback) {
  if (source === null || typeof source !== 'object') return fallback;
  let value;
  try {
    value = /** @type {Record<string, unknown>} */ (source)[key];
  } catch {
    return fallback;
  }
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof /** @type {{ get?: unknown }} */ (value).get === 'function') {
    try {
      const live = /** @type {{ get: () => unknown }} */ (value).get();
      return live === undefined || live === null ? fallback : live;
    } catch {
      return fallback;
    }
  }
  return value;
}

/** 把 browserVersion 归一成一行文本。 */
function versionText(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record.browser === 'string' && record.browser !== '') return record.browser;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

/** 把 lastError 归一成一行文本。 */
function errorText(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record.message === 'string' && record.message !== '') return record.message;
    if (typeof record.code === 'string' && record.code !== '') return record.code;
  }
  return '';
}

/** 普通对象或空对象。 */
function asRecord(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

/* ------------------------------------------------------------------ *
 * 工具实现
 * ------------------------------------------------------------------ */

/**
 * 构建全部工具定义。
 *
 * @param {{
 *   manager: object,
 *   getConfig?: () => unknown,
 *   logger?: { info?: Function, warn?: Function, debug?: Function },
 *   schemes?: { probeAllSchemes?: Function, SCHEMES?: unknown[] },
 * }} deps - 依赖注入：`manager` 必填（`BrowserManager`），其余可选。
 * @returns {object[]} 工具定义数组（`toolset: "slim"` 时只有 5 个）。
 * @throws {TypeError} 缺少 `deps.manager` 时。
 */
export function buildTools(deps = {}) {
  const manager = deps !== null && typeof deps === 'object' ? deps.manager : undefined;
  if (manager === null || manager === undefined || typeof manager !== 'object') {
    throw new TypeError('buildTools(deps): deps.manager 必填（BrowserManager 实例）');
  }
  const getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({});
  const logger = deps !== null && typeof deps === 'object' ? deps.logger : undefined;

  /** 按 targetId 缓存的页面句柄（控制台/网络缓冲跨调用连续）。 */
  const pageCache = new Map();
  /** 工具层「当前页」：`browser_select_page` / `browser_navigate` 更新。 */
  let activePageId = '';
  /** `lib/schemes.mjs` 的惰性加载缓存（测试可注入 `deps.schemes` 完全绕开）。 */
  let schemesModulePromise;

  /**
   * 读当前配置快照（每次 execute 都读，设置页改动下一个操作就生效）。
   *
   * @returns {object} 规范化配置（14 个字段全部补齐默认值）。
   */
  function readOptions() {
    let raw;
    try {
      raw = getConfig();
    } catch (error) {
      logger?.warn?.(`[chrome-devtools] 读取配置失败，使用默认值：${errorText(error)}`);
      raw = undefined;
    }
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    const scheme = stringOr(readOption(source, 'scheme', 'auto-connect'), 'auto-connect');
    return {
      scheme: SCHEME_IDS.includes(scheme) ? scheme : 'auto-connect',
      browserUrl: stringOr(readOption(source, 'browserUrl', 'http://127.0.0.1:9222'), 'http://127.0.0.1:9222'),
      wsEndpoint: stringOr(readOption(source, 'wsEndpoint', ''), ''),
      channel: stringOr(readOption(source, 'channel', 'stable'), 'stable'),
      executablePath: stringOr(readOption(source, 'executablePath', ''), ''),
      headless: readOption(source, 'headless', false) === true,
      isolated: readOption(source, 'isolated', true) !== false,
      userDataDir: stringOr(readOption(source, 'userDataDir', ''), ''),
      viewport: stringOr(readOption(source, 'viewport', '1280x800'), '1280x800'),
      toolset: readOption(source, 'toolset', 'full') === 'slim' ? 'slim' : 'full',
      screenshotDir: stringOr(readOption(source, 'screenshotDir', ''), ''),
      connectTimeoutMs: clampInt(readOption(source, 'connectTimeoutMs', 15_000), 15_000, 500, 600_000),
      actionTimeoutMs: clampInt(readOption(source, 'actionTimeoutMs', DEFAULT_ACTION_TIMEOUT_MS), DEFAULT_ACTION_TIMEOUT_MS, 100, 300_000),
    };
  }

  /** 当前动作超时。 */
  function actionTimeout() {
    return readOptions().actionTimeoutMs;
  }

  /**
   * 从 `manager.status()` 拿一份安全快照（缺字段补空值，不抛）。
   *
   * @returns {{ connected: boolean, scheme: string, wsUrl: string, browserVersion: string, launchedPid: number, pageCount: number, lastError: string }}
   *   连接状态。
   */
  function statusSnapshot() {
    let raw;
    try {
      raw = typeof manager.status === 'function' ? manager.status() : undefined;
    } catch (error) {
      logger?.warn?.(`[chrome-devtools] status() 失败：${errorText(error)}`);
      raw = undefined;
    }
    const record = asRecord(raw);
    return {
      connected: record.connected === true,
      scheme: stringOr(record.scheme, ''),
      wsUrl: stringOr(record.wsUrl, ''),
      browserVersion: versionText(record.browserVersion),
      launchedPid: typeof record.launchedPid === 'number' && Number.isFinite(record.launchedPid) ? record.launchedPid : 0,
      pageCount: typeof record.pageCount === 'number' && Number.isFinite(record.pageCount) ? record.pageCount : 0,
      lastError: errorText(record.lastError),
    };
  }

  /** 方案标签：优先 manager 的 `labelOf`（T1 的权威标签），其次静态副本。 */
  function schemeLabelFor(scheme) {
    const id = stringOr(scheme, '');
    if (typeof manager.labelOf === 'function') {
      try {
        const label = manager.labelOf(id);
        if (typeof label === 'string' && label !== '') return label;
      } catch {
        /* 标签读取失败用静态副本 */
      }
    }
    return Object.prototype.hasOwnProperty.call(SCHEME_LABELS, id) ? SCHEME_LABELS[id] : id;
  }

  /**
   * 惰性加载 `lib/schemes.mjs`（可能不存在：并行开发期 / 测试环境）。
   *
   * @returns {Promise<object | undefined>} 模块命名空间，加载失败时 undefined。
   */
  async function loadSchemesModule() {
    if (schemesModulePromise === undefined) {
      schemesModulePromise = import('./schemes.mjs').catch((error) => {
        logger?.warn?.(`[chrome-devtools] lib/schemes.mjs 不可用（方案探测降级）：${errorText(error)}`);
        return undefined;
      });
    }
    return schemesModulePromise;
  }

  /**
   * 探测四个方案的可用性（供 `browser_status`）。
   *
   * @param {object} options - 规范化配置。
   * @param {string} currentScheme - 当前方案 id。
   * @returns {Promise<object[]>} `[{ id, label, available, detail, isCurrent }]`。
   */
  async function probeSchemes(options, currentScheme) {
    const injected = deps !== null && typeof deps === 'object' ? deps.schemes : undefined;
    if (injected !== undefined && injected !== null && typeof injected.probeAllSchemes === 'function') {
      try {
        return await injected.probeAllSchemes(options, currentScheme);
      } catch (error) {
        logger?.warn?.(`[chrome-devtools] 注入的方案探测失败：${errorText(error)}`);
      }
    }
    const loaded = await loadSchemesModule();
    if (loaded !== undefined && loaded !== null && typeof loaded.probeAllSchemes === 'function') {
      try {
        return await loaded.probeAllSchemes(options, currentScheme);
      } catch (error) {
        logger?.warn?.(`[chrome-devtools] probeAllSchemes 失败：${errorText(error)}`);
      }
    }
    return SCHEME_IDS.map((id) => ({
      id,
      label: schemeLabelFor(id),
      available: false,
      detail: '方案探测不可用（lib/schemes.mjs 未加载）',
      isCurrent: id === currentScheme,
    }));
  }

  /**
   * 缓存并返回一个页面句柄。
   *
   * @param {object} session - TargetSession。
   * @param {string} targetId - target id。
   * @returns {PageHandle} 页面句柄（同一 target 复用）。
   */
  function adoptPage(session, targetId) {
    const key = nonEmptyString(targetId, nonEmptyString(session?.targetId, ''));
    const cached = pageCache.get(key);
    if (cached !== undefined && cached.session === session) return cached;
    if (cached !== undefined) cached.dispose();
    const page = new PageHandle(session, key);
    pageCache.set(key, page);
    return page;
  }

  /** 丢弃一个页面句柄。 */
  function forgetPage(targetId) {
    const cached = pageCache.get(targetId);
    if (cached === undefined) return;
    cached.dispose();
    pageCache.delete(targetId);
  }

  /** 丢弃全部页面句柄（断开连接时）。 */
  function disposeAllPages() {
    for (const page of pageCache.values()) {
      try {
        page.dispose();
      } catch {
        /* 释放失败不影响断开流程 */
      }
    }
    pageCache.clear();
    activePageId = '';
  }

  /**
   * 取一个页面句柄：显式 pageId → 工具层当前页 → manager 的激活页（必要时新建 about:blank）。
   *
   * 优先走 manager 的扩展页面 API `pageFor(pageId)`（T1 的 BrowserManager 提供）：
   * 它统一缓存 session + PageHandle，**同一个 target 只会有一个句柄**，否则控制台/网络
   * 缓冲会分叉、事件监听会翻倍。manager 只提供契约 §3.5 最小面（`activePage` / `browser`）
   * 时，退回工具层自己的解析（`browser.attach` + 按 targetId 缓存的句柄）。
   *
   * @param {unknown} pageId - 工具参数里的 pageId。
   * @returns {Promise<PageHandle>} 页面句柄。
   */
  async function requirePage(pageId) {
    const explicit = nonEmptyString(pageId, '');
    if (typeof manager.pageFor === 'function') {
      let entry;
      try {
        entry = await manager.pageFor(explicit === '' ? undefined : explicit);
      } catch (error) {
        throw asBrowserError(error, 'pageFor');
      }
      const record = asRecord(entry);
      const session = record.session;
      const page = record.page;
      const targetId = nonEmptyString(asRecord(page).targetId, nonEmptyString(record.targetId, nonEmptyString(session?.targetId, '')));
      if (page instanceof PageHandle) {
        if (activePageId === '') activePageId = targetId;
        return page;
      }
      if (session !== null && typeof session === 'object') {
        const adopted = adoptPage(session, targetId);
        if (activePageId === '') activePageId = targetId;
        return adopted;
      }
      throw new BrowserError('PROTOCOL_ERROR', 'manager.pageFor() 没有返回可用的 session/page（页面层未正确安装）');
    }
    // ---- 退化路径：契约最小面的 manager ----
    const wanted = explicit === '' ? activePageId : explicit;
    if (wanted === '') {
      let active;
      try {
        active = await manager.activePage();
      } catch (error) {
        throw asBrowserError(error, 'activePage');
      }
      const session = asRecord(active).session;
      const page = asRecord(active).page;
      if (page instanceof PageHandle) {
        const targetId = nonEmptyString(page.targetId, nonEmptyString(session?.targetId, ''));
        // 复用已缓存的句柄：manager 可能每次返回新 PageHandle，但控制台/网络缓冲
        // 必须跨工具调用连续，所以同一 target 只保留一份。
        const cached = pageCache.get(targetId);
        if (cached !== undefined) {
          if (activePageId === '') activePageId = targetId;
          return cached;
        }
        pageCache.set(targetId, page);
        if (activePageId === '') activePageId = targetId;
        return page;
      }
      if (session === null || typeof session !== 'object') {
        throw new BrowserError('NOT_CONNECTED', '没有可用的页面：请先调用 browser_connect');
      }
      const adopted = adoptPage(session, nonEmptyString(session.targetId, ''));
      if (activePageId === '') activePageId = adopted.targetId;
      return adopted;
    }
    const cached = pageCache.get(wanted);
    if (cached !== undefined) return cached;
    const browser = await manager.browser();
    let session;
    try {
      session = await browser.attach(wanted);
    } catch (error) {
      throw asBrowserError(error, `attach(${wanted})`);
    }
    if (session === null || typeof session !== 'object') {
      throw new BrowserError('TARGET_NOT_FOUND', `找不到页面 "${wanted}"（用 browser_list_pages 查看可用 id）`, { pageId: wanted });
    }
    return adoptPage(session, wanted);
  }

  /** 默认工具标题（presentCall 卡片）。 */
  const presentCallFor = (title) => () => ({ card: 'generic', title, kind: 'read' });

  /** 每个工具的统一 `render`：summary 必在，附加详情可选。 */
  const renderWith = (detail) => (args, value) => {
    const blocks = [textBlock(value.summary)];
    if (typeof detail === 'function') {
      const extra = detail(value);
      if (typeof extra === 'string' && extra.trim() !== '') blocks.push(textBlock(extra));
    }
    return blocks;
  };

  /**
   * 构造一个工具定义（参数与输出 schema 都走本文件的严格构建器）。
   *
   * @param {object} spec - `{ name, title, description, parameters, required, output, execute, render }`。
   * @returns {object} 可直接 `ctx.tools.register()` 的定义。
   */
  function defineTool(spec) {
    return {
      name: spec.name,
      description: spec.description,
      parameters: objectSchema(spec.parameters ?? {}, spec.required ?? []),
      output: {
        schema: objectSchema(spec.output, Object.keys(spec.output)),
        render: spec.render ?? renderWith(),
      },
      async execute(args, execContext) {
        return spec.execute(args !== null && typeof args === 'object' ? args : {}, execContext);
      },
      presentCall: presentCallFor(spec.title),
    };
  }

  const tools = [];

  /* ----------------------------- 1. browser_status ----------------------------- */
  tools.push(
    defineTool({
      name: 'browser_status',
      title: '浏览器状态',
      description:
        'Report the Chrome connection state and the availability of the four connection schemes (launch / auto-connect / browser-url / ws-endpoint). Use this first when you are unsure whether Chrome is attached, after browser_connect, or when the user asks why a browser tool is failing. It never throws for an unconnected state: scheme availability, the last error and the effective config are returned as data.',
      parameters: {},
      required: [],
      output: {
        connected: prop('boolean', 'Whether a CDP connection is currently established.'),
        scheme: prop('string', 'Active/configured connection scheme id, or an empty string.'),
        schemeLabel: prop('string', 'Human readable label of the active/configured scheme.'),
        wsUrl: prop('string', 'Connected WebSocket endpoint with credentials redacted, or an empty string.'),
        browserVersion: prop('string', 'Browser version string, or an empty string when not connected.'),
        launchedPid: prop('number', 'PID of the Chrome process this plugin launched (0 = not ours / not running).'),
        pageCount: prop('number', 'Number of open page targets.'),
        lastError: prop('string', 'Last connection error message, or an empty string.'),
        availableSchemes: prop('array', 'Per-scheme availability probes.', {
          items: objectSchema({
            id: prop('string', 'Scheme id.'),
            label: prop('string', 'Scheme label.'),
            available: prop('boolean', 'Whether this scheme looks usable right now.'),
            detail: prop('string', 'Probe explanation.'),
            isCurrent: prop('boolean', 'Whether this is the current scheme.'),
          }),
        }),
        config: prop('object', 'Effective plugin configuration (secrets redacted).', {
          properties: {
            scheme: prop('string', 'Configured scheme id.'),
            browserUrl: prop('string', 'Configured browser-url debugging endpoint.'),
            wsEndpoint: prop('string', 'Configured WebSocket endpoint (credentials redacted).'),
            channel: prop('string', 'Chrome channel.'),
            executablePath: prop('string', 'Explicit Chrome executable path (empty = auto-detect).'),
            headless: prop('boolean', 'Whether a launched browser is headless.'),
            isolated: prop('boolean', 'Whether a launched browser uses a temporary profile.'),
            userDataDir: prop('string', 'Explicit user data dir.'),
            viewport: prop('string', 'Launched window size, e.g. 1280x800.'),
            toolset: prop('string', 'Tool set: full or slim.'),
            screenshotDir: prop('string', 'Screenshot directory (empty = $DSH_HOME default).'),
            connectTimeoutMs: prop('number', 'Connection timeout in milliseconds.'),
            actionTimeoutMs: prop('number', 'Per-action timeout in milliseconds.'),
          },
          required: [
            'scheme',
            'browserUrl',
            'wsEndpoint',
            'channel',
            'executablePath',
            'headless',
            'isolated',
            'userDataDir',
            'viewport',
            'toolset',
            'screenshotDir',
            'connectTimeoutMs',
            'actionTimeoutMs',
          ],
        }),
        summary: prop('string', 'One-line human-readable status.'),
      },
      render: renderWith((value) => {
        const lines = ['方案可用性：'];
        for (const scheme of Array.isArray(value.availableSchemes) ? value.availableSchemes : []) {
          const mark = scheme.available === true ? '✅ 可用' : '❌ 不可用';
          const current = scheme.isCurrent === true ? '（当前）' : '';
          const detail = scheme.detail === '' ? '' : ` — ${scheme.detail}`;
          lines.push(`- ${scheme.id} ${scheme.label}：${mark}${current}${detail}`);
        }
        lines.push(
          '',
          `配置：scheme=${value.config.scheme} · toolset=${value.config.toolset} · channel=${value.config.channel} · headless=${value.config.headless}`,
        );
        return lines.join('\n');
      }),
      async execute() {
        const options = readOptions();
        const status = statusSnapshot();
        const scheme = status.scheme === '' ? options.scheme : status.scheme;
        const probes = await probeSchemes(options, scheme);
        const availableSchemes = (Array.isArray(probes) ? probes : []).map((entry) => {
          const record = asRecord(entry);
          const id = stringOr(record.id, '');
          return {
            id,
            label: stringOr(record.label, schemeLabelFor(id)),
            available: record.available === true,
            detail: stringOr(record.detail, ''),
            isCurrent: record.isCurrent === true,
          };
        });
        const label = schemeLabelFor(scheme);
        const summary = status.connected
          ? `✅ 已连接 · ${label} · ${status.browserVersion === '' ? '未知版本' : status.browserVersion} · ${status.pageCount} 个页面`
          : `⚪ 未连接 · 配置方案 ${label}${status.lastError === '' ? '' : ` · 最近错误：${status.lastError}`}`;
        return {
          summary,
          connected: status.connected,
          scheme,
          schemeLabel: label,
          wsUrl: redactUrl(status.wsUrl),
          browserVersion: status.browserVersion,
          launchedPid: status.launchedPid,
          pageCount: status.pageCount,
          lastError: status.lastError,
          availableSchemes,
          config: {
            scheme: options.scheme,
            browserUrl: options.browserUrl,
            wsEndpoint: redactUrl(options.wsEndpoint),
            channel: options.channel,
            executablePath: options.executablePath,
            headless: options.headless,
            isolated: options.isolated,
            userDataDir: options.userDataDir,
            viewport: options.viewport,
            toolset: options.toolset,
            screenshotDir: options.screenshotDir,
            connectTimeoutMs: options.connectTimeoutMs,
            actionTimeoutMs: options.actionTimeoutMs,
          },
        };
      },
    }),
  );

  /* ----------------------------- 2. browser_connect ----------------------------- */
  tools.push(
    defineTool({
      name: 'browser_connect',
      title: '连接 Chrome',
      description:
        'Connect to Chrome using one of four schemes: "launch" (start a fresh browser), "auto-connect" (reuse the browser the user is already using, keeping cookies/logins), "browser-url" (attach to a debugging port), or "ws-endpoint" (raw WebSocket URL). Call this before any page tool when browser_status reports not connected, or to switch schemes. Switching schemes drops the previous connection first.',
      parameters: {
        scheme: prop('string', 'Connection scheme id. Omit to use the configured scheme.', { enum: [...SCHEME_IDS] }),
      },
      required: [],
      output: {
        connected: prop('boolean', 'Whether the connection is established.'),
        scheme: prop('string', 'Scheme id actually used.'),
        schemeLabel: prop('string', 'Scheme label.'),
        wsUrl: prop('string', 'WebSocket endpoint (credentials redacted).'),
        browserVersion: prop('string', 'Browser version string.'),
        reused: prop('boolean', 'Whether an existing connection/browser was reused.'),
        launchedPid: prop('number', 'PID of a browser launched by this call (0 = none).'),
        note: prop('string', 'How the connection was established.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const options = readOptions();
        const requested = nonEmptyString(args.scheme, '');
        if (requested !== '' && !SCHEME_IDS.includes(requested)) {
          throw new BrowserError('INVALID_ARGUMENT', `未知的连接方案 "${requested}"（可选：${SCHEME_IDS.join(' / ')}）`, { scheme: requested });
        }
        let result;
        try {
          result = await manager.connect({
            ...(requested === '' ? {} : { scheme: requested }),
            timeoutMs: options.connectTimeoutMs,
          });
        } catch (error) {
          throw asBrowserError(error, 'connect');
        }
        const record = asRecord(result);
        const scheme = stringOr(record.scheme, requested === '' ? options.scheme : requested);
        const reused = record.reused === true;
        const launchedPid = typeof record.launchedPid === 'number' && Number.isFinite(record.launchedPid) ? record.launchedPid : 0;
        const label = schemeLabelFor(scheme);
        const note = reused ? '复用已有连接/浏览器' : '新建连接';
        return {
          summary: `✅ ${note}成功 · ${label} · ${versionText(record.browserVersion) || '未知版本'}${launchedPid > 0 ? ` · pid ${launchedPid}` : ''}`,
          connected: true,
          scheme,
          schemeLabel: label,
          wsUrl: redactUrl(stringOr(record.wsUrl, '')),
          browserVersion: versionText(record.browserVersion),
          reused,
          launchedPid,
          note,
        };
      },
    }),
  );

  /* ---------------------------- 3. browser_disconnect --------------------------- */
  tools.push(
    defineTool({
      name: 'browser_disconnect',
      title: '断开 Chrome',
      description:
        'Close the CDP connection. With closeBrowser=true it also terminates the Chrome process this plugin launched itself; a browser the user started (auto-connect / browser-url / ws-endpoint) is never killed. Use it to switch schemes cleanly or to stop the launched browser when done. Page handles and their console/network buffers are dropped.',
      parameters: {
        closeBrowser: prop('boolean', 'Also close the Chrome process launched by this plugin (ignored for externally owned browsers).', {
          default: false,
        }),
      },
      required: [],
      output: {
        disconnected: prop('boolean', 'Whether the connection was dropped.'),
        closedOwnedBrowser: prop('boolean', 'Whether a browser launched by this plugin was closed.'),
        note: prop('string', 'Human-readable note.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        let result;
        try {
          result = await manager.disconnect({ closeBrowser: args.closeBrowser === true });
        } catch (error) {
          throw asBrowserError(error, 'disconnect');
        }
        disposeAllPages();
        const record = asRecord(result);
        const closed = record.closedOwnedBrowser === true;
        return {
          summary: closed ? '🔌 已断开连接，并关闭了本插件启动的 Chrome' : '🔌 已断开连接（外部浏览器保持运行）',
          disconnected: true,
          closedOwnedBrowser: closed,
          note: closed ? '本插件启动的 Chrome 已关闭' : '未关闭浏览器（非本插件启动，或未开启 closeBrowser）',
        };
      },
    }),
  );

  /* ----------------------------- 4. browser_navigate ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_navigate',
      title: '打开网页',
      description:
        'Navigate the current page (or a new tab with newTab=true) to a URL and wait for it to load. This is the entry point for most browser tasks: call it after browser_connect, then use browser_snapshot to see what is on the page. waitUntil="domcontentloaded" is faster but less complete; "networkidle0" waits for network activity to settle (heuristic). Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        url: prop('string', 'Absolute URL to open, e.g. https://example.com/.'),
        newTab: prop('boolean', 'Open in a new tab instead of navigating the current one.', { default: false }),
        waitUntil: prop('string', 'When to consider navigation complete.', {
          enum: [...WAIT_UNTIL_VALUES],
          default: 'load',
        }),
        pageId: prop('string', 'Target page id from browser_list_pages. Omit for the current page.'),
      },
      required: ['url'],
      output: {
        pageId: prop('string', 'Target id of the navigated page.'),
        url: prop('string', 'Final URL.'),
        title: prop('string', 'Page title.'),
        isNewTab: prop('boolean', 'Whether a new tab was opened.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const url = nonEmptyString(args.url, '');
        if (url === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_navigate 需要非空 url');
        const options = readOptions();
        const waitUntil = WAIT_UNTIL_VALUES.includes(args.waitUntil) ? args.waitUntil : 'load';
        const isNewTab = args.newTab === true;
        let page;
        if (isNewTab) {
          if (typeof manager.newPage === 'function') {
            let created;
            try {
              created = await manager.newPage('about:blank');
            } catch (error) {
              throw asBrowserError(error, 'newPage');
            }
            const pageId = stringOr(asRecord(created).pageId, '');
            if (pageId === '') throw new BrowserError('CDP_ERROR', '新建标签页失败：没有拿到 pageId');
            page = await requirePage(pageId);
          } else {
            const browser = await manager.browser();
            let created;
            try {
              created = await browser.createTarget('about:blank');
            } catch (error) {
              throw asBrowserError(error, 'createTarget');
            }
            const targetId = stringOr(asRecord(created).targetId, '');
            if (targetId === '') throw new BrowserError('CDP_ERROR', '新建标签页失败：没有拿到 targetId');
            let session;
            try {
              session = await browser.attach(targetId);
            } catch (error) {
              throw asBrowserError(error, 'attach');
            }
            page = adoptPage(session, targetId);
          }
        } else {
          page = await requirePage(args.pageId);
        }
        const result = await page.navigate(url, { waitUntil, timeoutMs: Math.max(30_000, options.actionTimeoutMs) });
        activePageId = page.targetId;
        return {
          summary: `🌐 已打开 ${result.title === '' ? '(无标题)' : result.title} — ${result.url}${isNewTab ? '（新标签页）' : ''}`,
          pageId: page.targetId,
          url: result.url,
          title: result.title,
          isNewTab,
        };
      },
    }),
  );

  /* ---------------------------- 5. browser_list_pages --------------------------- */
  tools.push(
    defineTool({
      name: 'browser_list_pages',
      title: '列出页面',
      description:
        'List open page targets (tabs) with their ids, URLs and titles, and mark which one is the current page. Use it when the user mentions an already-open tab, or to get a pageId for another browser tool. Requires Chrome — call browser_connect first if not connected.',
      parameters: {},
      required: [],
      output: {
        count: prop('number', 'Number of open pages.'),
        pages: prop('array', 'Open pages.', {
          items: objectSchema({
            id: prop('string', 'Target id usable as pageId.'),
            url: prop('string', 'Page URL.'),
            title: prop('string', 'Page title.'),
            active: prop('boolean', 'Whether this is the current page for page tools.'),
          }),
        }),
        summary: prop('string', 'One-line human-readable result.'),
      },
      render: renderWith((value) =>
        (Array.isArray(value.pages) ? value.pages : [])
          .map((page) => `- ${page.active === true ? '👉 ' : ''}${page.id} · ${page.title === '' ? '(无标题)' : page.title} · ${page.url}`)
          .join('\n'),
      ),
      async execute() {
        /** @type {{ id: string, url: string, title: string, active: boolean }[]} */
        let pages;
        if (typeof manager.listPages === 'function') {
          let listed;
          try {
            listed = await manager.listPages();
          } catch (error) {
            throw asBrowserError(error, 'listPages');
          }
          pages = (Array.isArray(listed) ? listed : []).map((entry) => {
            const record = asRecord(entry);
            return {
              id: stringOr(record.pageId, stringOr(record.targetId, '')),
              url: stringOr(record.url, ''),
              title: stringOr(record.title, ''),
              active: record.active === true,
            };
          });
        } else {
          const browser = await manager.browser();
          let targets;
          try {
            targets = await browser.listTargets();
          } catch (error) {
            throw asBrowserError(error, 'listTargets');
          }
          pages = (Array.isArray(targets) ? targets : []).map((target) => {
            const record = asRecord(target);
            return {
              id: stringOr(record.targetId, ''),
              url: stringOr(record.url, ''),
              title: stringOr(record.title, ''),
              active: false,
            };
          });
          const preferred = activePageId === '' ? stringOr(pages[0]?.id, '') : activePageId;
          for (const page of pages) page.active = page.id === preferred;
        }
        return {
          summary: pages.length === 0 ? '📑 当前没有打开的页面' : `📑 ${pages.length} 个页面：${pages.map((page) => page.title === '' ? page.id : page.title).join(' / ')}`,
          count: pages.length,
          pages,
        };
      },
    }),
  );

  /* ---------------------------- 6. browser_select_page -------------------------- */
  tools.push(
    defineTool({
      name: 'browser_select_page',
      title: '切换页面',
      description:
        'Select an open page as the current page: later page tools that omit pageId operate on it. Get ids from browser_list_pages. Use it when several tabs are open (e.g. the user says "the one with the docs"). Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        pageId: prop('string', 'Target id from browser_list_pages.'),
      },
      required: ['pageId'],
      output: {
        pageId: prop('string', 'Selected page id.'),
        url: prop('string', 'Page URL.'),
        title: prop('string', 'Page title.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const targetId = nonEmptyString(args.pageId, '');
        if (targetId === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_select_page 需要 pageId');
        if (typeof manager.selectPage === 'function') {
          let selected;
          try {
            selected = await manager.selectPage(targetId);
          } catch (error) {
            throw asBrowserError(error, 'selectPage');
          }
          const record = asRecord(selected);
          activePageId = stringOr(record.pageId, targetId);
          const url = stringOr(record.url, '');
          const title = stringOr(record.title, '');
          return {
            summary: `🎯 已切换到页面 ${activePageId}（${title === '' ? url : title}）`,
            pageId: activePageId,
            url,
            title,
          };
        }
        const browser = await manager.browser();
        let targets;
        try {
          targets = await browser.listTargets();
        } catch (error) {
          throw asBrowserError(error, 'listTargets');
        }
        const match = (Array.isArray(targets) ? targets : []).find((target) => stringOr(asRecord(target).targetId, '') === targetId);
        if (match === undefined) {
          throw new BrowserError('TARGET_NOT_FOUND', `没有 id 为 "${targetId}" 的页面（用 browser_list_pages 查看可用 id）`, { pageId: targetId });
        }
        let session;
        try {
          session = await browser.attach(targetId);
        } catch (error) {
          throw asBrowserError(error, `attach(${targetId})`);
        }
        adoptPage(session, targetId);
        activePageId = targetId;
        const record = asRecord(match);
        const url = stringOr(record.url, '');
        const title = stringOr(record.title, '');
        return {
          summary: `🎯 已切换到页面 ${targetId}（${title === '' ? url : title}）`,
          pageId: targetId,
          url,
          title,
        };
      },
    }),
  );

  /* ---------------------------- 7. browser_close_page ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_close_page',
      title: '关闭页面',
      description:
        'Close a page (tab). Omit pageId to close the current page. Use it to clean up tabs opened during a task; the remaining page count is returned. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        pageId: prop('string', 'Target id from browser_list_pages. Omit to close the current page.'),
      },
      required: [],
      output: {
        closedPageId: prop('string', 'Target id that was closed.'),
        remaining: prop('number', 'Number of pages still open.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        if (typeof manager.closePage === 'function') {
          let result;
          try {
            result = await manager.closePage(nonEmptyString(args.pageId, '') || undefined);
          } catch (error) {
            throw asBrowserError(error, 'closePage');
          }
          const record = asRecord(result);
          const closedPageId = stringOr(record.closedPageId, '');
          forgetPage(closedPageId);
          if (activePageId === closedPageId) activePageId = '';
          const remaining = typeof record.remaining === 'number' && Number.isFinite(record.remaining) ? record.remaining : 0;
          return {
            summary: `🗑️ 已关闭页面 ${closedPageId}，剩余 ${remaining} 个`,
            closedPageId,
            remaining,
          };
        }
        const browser = await manager.browser();
        let targetId = nonEmptyString(args.pageId, '');
        if (targetId === '') {
          const page = await requirePage('');
          targetId = page.targetId;
        }
        try {
          await browser.closeTarget(targetId);
        } catch (error) {
          throw asBrowserError(error, `closeTarget(${targetId})`);
        }
        forgetPage(targetId);
        if (activePageId === targetId) activePageId = '';
        let remaining = 0;
        try {
          const targets = await browser.listTargets();
          remaining = Array.isArray(targets) ? targets.length : 0;
        } catch {
          remaining = 0;
        }
        return {
          summary: `🗑️ 已关闭页面 ${targetId}，剩余 ${remaining} 个`,
          closedPageId: targetId,
          remaining,
        };
      },
    }),
  );

  /* ---------------------------- 8. browser_screenshot --------------------------- */
  tools.push(
    defineTool({
      name: 'browser_screenshot',
      title: '页面截图',
      description:
        'Capture a screenshot of the page and save it to a file, returning the absolute path, byte size and pixel dimensions. Use it when visual layout matters (the user asks "what does it look like", or a visual bug must be checked). fullPage=true captures beyond the viewport. The image is NOT embedded in the tool result — read the returned path if you need the file. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        pageId: prop('string', 'Target page id. Omit for the current page.'),
        format: prop('string', 'Image format.', { enum: [...SCREENSHOT_FORMATS], default: 'png' }),
        fullPage: prop('boolean', 'Capture the full scrollable page instead of just the viewport.', { default: false }),
        path: prop('string', 'Absolute output file path. Omit to use the configured screenshot directory with a timestamped name.'),
      },
      required: [],
      output: {
        path: prop('string', 'Absolute path of the saved image.'),
        bytes: prop('number', 'File size in bytes.'),
        format: prop('string', 'Image format (png or jpeg).'),
        mounted: prop('boolean', 'Whether the image was written to disk successfully.'),
        pageUrl: prop('string', 'URL of the captured page.'),
        title: prop('string', 'Title of the captured page.'),
        note: prop('string', 'Where the file went / why it is not embedded.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const options = readOptions();
        const format = args.format === 'jpeg' || args.format === 'jpg' ? 'jpeg' : 'png';
        const explicitPath = nonEmptyString(args.path, '');
        const targetPath =
          explicitPath === ''
            ? path.join(resolveScreenshotDir(options.screenshotDir), screenshotFileName(new Date(), format))
            : path.resolve(explicitPath);
        const shot = await page.screenshot({ format, fullPage: args.fullPage === true, path: targetPath });
        const info = await page.pageInfo().catch(() => ({ url: '', title: '' }));
        const mounted = shot.bytes > 0;
        return {
          summary: `📷 已截图（${shot.width}x${shot.height}，${shot.bytes} 字节）→ ${shot.path}`,
          path: shot.path,
          bytes: shot.bytes,
          format,
          mounted,
          pageUrl: info.url,
          title: info.title,
          note: mounted
            ? `截图已保存到文件（${shot.width}x${shot.height}）；图片未内嵌到工具结果，需要时请按 path 读取。`
            : '截图数据为空，文件未写入有效内容。',
        };
      },
    }),
  );

  /* ----------------------------- 9. browser_snapshot ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_snapshot',
      title: '页面快照',
      description:
        'Return a model-readable snapshot of the page: the visible interactive elements (links, buttons, inputs, roles…) each with a stable CSS path, plus the page title, URL and a chunk of visible text. This is the primary way to find a CSS selector for browser_click / browser_fill — call it after browser_navigate and before any element action. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        pageId: prop('string', 'Target page id. Omit for the current page.'),
        maxChars: prop('number', 'Maximum characters of snapshot text to return.', { default: DEFAULT_SNAPSHOT_MAX_CHARS }),
      },
      required: [],
      output: {
        text: prop('string', 'The snapshot text: interactive elements with CSS paths plus visible page text.'),
        truncated: prop('boolean', 'Whether the snapshot was truncated to maxChars.'),
        pageUrl: prop('string', 'URL of the captured page.'),
        title: prop('string', 'Title of the captured page.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      render: renderWith((value) => value.text),
      async execute(args) {
        const page = await requirePage(args.pageId);
        const maxChars = clampInt(args.maxChars, DEFAULT_SNAPSHOT_MAX_CHARS, 200, 200_000);
        const snapshot = await page.snapshot({ maxChars });
        const pageUrl = stringOr(snapshot.url, '');
        const title = stringOr(snapshot.title, '');
        return {
          summary: `🔎 快照${snapshot.truncated === true ? '（已截断）' : ''} — ${title === '' ? '(无标题)' : title} ${pageUrl}`,
          text: snapshot.text,
          truncated: snapshot.truncated === true,
          pageUrl,
          title,
        };
      },
    }),
  );

  /* ----------------------------- 10. browser_console ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_console',
      title: '控制台消息',
      description:
        'Return recent console messages and uncaught exceptions from the page (buffered, last 200). Use it to diagnose why a page misbehaves in the browser (JS errors, failed assertions, CORS warnings). Capture starts when this tool is first called, so messages logged before that are not available. Filter with types=["error"] to see only errors. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        pageId: prop('string', 'Target page id. Omit for the current page.'),
        limit: prop('number', 'Maximum number of messages to return (1-200).', { default: 50 }),
        types: prop('array', 'Only return these message types.', {
          items: prop('string', 'One of log / info / warning / error / debug / exception.', { enum: [...CONSOLE_TYPES] }),
        }),
      },
      required: [],
      output: {
        count: prop('number', 'Number of messages returned.'),
        messages: prop('array', 'Recent console messages, oldest first.', {
          items: objectSchema({
            type: prop('string', 'Message type (log / info / warning / error / debug / exception).'),
            text: prop('string', 'Message text.'),
            url: prop('string', 'Source URL, or an empty string.'),
            line: prop('number', 'Source line (1-based), or 0.'),
          }),
        }),
        summary: prop('string', 'One-line human-readable result.'),
      },
      render: renderWith((value) =>
        (Array.isArray(value.messages) ? value.messages : [])
          .map((message) => `- [${message.type}] ${message.text}${message.url === '' ? '' : ` (${message.url}:${message.line})`}`)
          .join('\n'),
      ),
      async execute(args) {
        const page = await requirePage(args.pageId);
        await page.enableConsoleCapture();
        const limit = clampInt(args.limit, 50, 1, 200);
        const types = Array.isArray(args.types) ? args.types.filter((type) => typeof type === 'string' && type !== '') : [];
        const messages = page.consoleMessages({ limit, types }).map((message) => ({
          type: stringOr(message.type, ''),
          text: stringOr(message.text, ''),
          url: stringOr(message.url, ''),
          line: typeof message.line === 'number' && Number.isFinite(message.line) ? message.line : 0,
        }));
        return {
          summary:
            messages.length === 0
              ? '🖥️ 控制台暂无消息（采集从第一次调用 browser_console 开始，之后的消息才会被记录）'
              : `🖥️ 控制台最近 ${messages.length} 条消息`,
          count: messages.length,
          messages,
        };
      },
    }),
  );

  /* ----------------------------- 11. browser_network ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_network',
      title: '网络请求',
      description:
        'Return recent network requests (URL, method, status, resource type, failures) buffered from the page (last 200). Use it to diagnose failed API calls, 404/500 responses or blocked resources. Capture starts when this tool is first called (or when a networkidle0 navigation ran), so earlier requests may be missing. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        pageId: prop('string', 'Target page id. Omit for the current page.'),
        limit: prop('number', 'Maximum number of requests to return (1-200).', { default: 50 }),
      },
      required: [],
      output: {
        count: prop('number', 'Number of requests returned.'),
        requests: prop('array', 'Recent requests, oldest first.', {
          items: objectSchema({
            url: prop('string', 'Request URL.'),
            method: prop('string', 'HTTP method.'),
            status: prop('number', 'HTTP status (0 = no response).'),
            resourceType: prop('string', 'CDP resource type (Document / XHR / Fetch / Image / Script …).'),
            mimeType: prop('string', 'Response MIME type, or an empty string.'),
            failed: prop('boolean', 'Whether the request failed.'),
            errorText: prop('string', 'Failure text, or an empty string.'),
          }),
        }),
        summary: prop('string', 'One-line human-readable result.'),
      },
      render: renderWith((value) =>
        (Array.isArray(value.requests) ? value.requests : [])
          .map((request) => `- ${request.method} ${request.status} ${request.url}${request.failed ? ` ⚠️ ${request.errorText}` : ''}`)
          .join('\n'),
      ),
      async execute(args) {
        const page = await requirePage(args.pageId);
        await page.enableNetworkCapture();
        const limit = clampInt(args.limit, 50, 1, 200);
        const requests = page.networkRequests({ limit }).map((request) => ({
          url: stringOr(request.url, ''),
          method: stringOr(request.method, ''),
          status: typeof request.status === 'number' && Number.isFinite(request.status) ? request.status : 0,
          resourceType: stringOr(request.resourceType, ''),
          mimeType: stringOr(request.mimeType, ''),
          failed: request.failed === true,
          errorText: stringOr(request.errorText, ''),
        }));
        const failed = requests.filter((request) => request.failed).length;
        return {
          summary:
            requests.length === 0
              ? '🌐 网络暂无记录（采集从第一次调用 browser_network 开始，之后发出的请求才会被记录）'
              : `🌐 网络最近 ${requests.length} 个请求${failed > 0 ? `（${failed} 个失败）` : ''}`,
          count: requests.length,
          requests,
        };
      },
    }),
  );

  /* ------------------------------ 12. browser_click ----------------------------- */
  tools.push(
    defineTool({
      name: 'browser_click',
      title: '点击元素',
      description:
        'Click an element by CSS selector. The element is scrolled into view and a real mouse press/release is dispatched at its centre (not element.click()), so React/Vue event handling, hover states and default actions behave like a user click. Get the selector from browser_snapshot. Returns the URL/title change caused by the click. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        selector: prop('string', 'CSS selector of the element to click, e.g. "button[type=submit]" or "#login > button".'),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
        button: prop('string', 'Mouse button.', { enum: ['left', 'right', 'middle'], default: 'left' }),
        clickCount: prop('number', '2 for a double click.', { default: 1 }),
      },
      required: ['selector'],
      output: {
        ok: prop('boolean', 'Whether the click was dispatched.'),
        selector: prop('string', 'The selector that was clicked.'),
        deltaUrl: prop('string', 'New page URL when the click navigated, otherwise an empty string.'),
        deltaTitle: prop('string', 'New page title when the click changed it, otherwise an empty string.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const selector = nonEmptyString(args.selector, '');
        if (selector === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_click 需要 selector');
        const before = await page.pageInfo().catch(() => ({ url: '', title: '' }));
        await page.click(selector, {
          timeoutMs: actionTimeout(),
          button: args.button,
          clickCount: args.clickCount,
        });
        await sleep(120);
        const after = await page.pageInfo().catch(() => ({ url: '', title: '' }));
        const deltaUrl = after.url !== before.url ? after.url : '';
        const deltaTitle = after.title !== before.title ? after.title : '';
        return {
          summary: `🖱️ 已点击 ${selector}${deltaUrl === '' ? '' : ` → 跳转到 ${deltaUrl}`}`,
          ok: true,
          selector,
          deltaUrl,
          deltaTitle,
        };
      },
    }),
  );

  /* ------------------------------ 13. browser_fill ------------------------------ */
  tools.push(
    defineTool({
      name: 'browser_fill',
      title: '填写表单',
      description:
        'Set the value of an input/textarea/select (or a batch of fields) with a native setter plus bubbling input/change events, so React/Vue controlled components actually update. Use {selector, value} for one field or {fields:[{selector,value}]} for many; when both are given, fields wins. File inputs are not supported here — use browser_upload_file. Each field reports ok/error independently. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        selector: prop('string', 'CSS selector of a single field.'),
        value: prop('string', 'Value for the single field.'),
        fields: prop('array', 'Batch mode: fill several fields in one call (takes precedence over selector/value).', {
          items: objectSchema(
            {
              selector: prop('string', 'CSS selector of the field.'),
              value: prop('string', 'Value to set.'),
            },
            ['selector'],
          ),
        }),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
      },
      required: [],
      output: {
        filled: prop('number', 'Number of fields filled successfully.'),
        failed: prop('number', 'Number of fields that failed.'),
        results: prop('array', 'Per-field results.', {
          items: objectSchema({
            selector: prop('string', 'Field selector.'),
            ok: prop('boolean', 'Whether this field was filled.'),
            error: prop('string', 'Failure reason, or an empty string.'),
          }),
        }),
        summary: prop('string', 'One-line human-readable result.'),
      },
      render: renderWith((value) =>
        (Array.isArray(value.results) ? value.results : [])
          .map((result) => `- ${result.ok ? '✅' : '❌'} ${result.selector}${result.ok ? '' : `：${result.error}`}`)
          .join('\n'),
      ),
      async execute(args) {
        const page = await requirePage(args.pageId);
        const fields = [];
        if (Array.isArray(args.fields)) {
          for (const field of args.fields) {
            const record = asRecord(field);
            const selector = nonEmptyString(record.selector, '');
            if (selector === '') continue;
            const value = record.value === undefined || record.value === null ? '' : String(record.value);
            fields.push({ selector, value });
          }
        }
        if (fields.length === 0) {
          const selector = nonEmptyString(args.selector, '');
          if (selector === '') {
            throw new BrowserError('INVALID_ARGUMENT', 'browser_fill 需要 fields 数组，或 selector + value');
          }
          fields.push({ selector, value: args.value === undefined || args.value === null ? '' : String(args.value) });
        }
        const results = [];
        for (const field of fields) {
          try {
            await page.fill(field.selector, field.value, { timeoutMs: actionTimeout() });
            results.push({ selector: field.selector, ok: true, error: '' });
          } catch (error) {
            results.push({ selector: field.selector, ok: false, error: asBrowserError(error).message });
          }
        }
        const filled = results.filter((result) => result.ok).length;
        const failed = results.length - filled;
        return {
          summary:
            failed === 0
              ? `⌨️ 已填写 ${filled} 个字段`
              : `⌨️ 填写完成：${filled} 成功，${failed} 失败（详见 results）`,
          filled,
          failed,
          results,
        };
      },
    }),
  );

  /* ------------------------------ 14. browser_type ------------------------------ */
  tools.push(
    defineTool({
      name: 'browser_type',
      title: '输入文本',
      description:
        'Type text into the page using Input.insertText, character by character (real text input, so keyboard handlers and IME-aware widgets see it). With selector the element is focused first; focus it yourself (browser_click) when the field cannot be focused directly. Use browser_fill for setting a value in one shot, and browser_press_key for special keys. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        text: prop('string', 'Text to type.'),
        selector: prop('string', 'CSS selector to focus before typing.'),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
        delayMs: prop('number', 'Delay between characters in milliseconds.', { default: 0 }),
      },
      required: ['text'],
      output: {
        ok: prop('boolean', 'Whether typing completed.'),
        chars: prop('number', 'Number of characters inserted (code points).'),
        selector: prop('string', 'Selector that was focused, or an empty string.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const text = typeof args.text === 'string' ? args.text : '';
        if (text === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_type 需要非空 text');
        const selector = nonEmptyString(args.selector, '');
        const result = await page.type(text, {
          selector,
          delayMs: args.delayMs,
          timeoutMs: actionTimeout(),
        });
        return {
          summary: `⌨️ 已输入 ${result.chars} 个字符${selector === '' ? '' : ` 到 ${selector}`}`,
          ok: true,
          chars: result.chars,
          selector,
        };
      },
    }),
  );

  /* --------------------------- 15. browser_press_key ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_press_key',
      title: '按键',
      description:
        'Press a key or key combination: Enter, Tab, Escape, Backspace, Delete, Arrow*, Home, End, PageUp, PageDown, Space, letters, digits, F1-F12, and combos like Control+A / Shift+Tab. Dispatched as Input.dispatchKeyEvent keyDown+keyUp (with proper key/code/virtual key code), so form submit, focus traversal and shortcuts work. Optionally focus a selector first. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        key: prop('string', 'Key name or combo, e.g. "Enter", "Tab", "Control+A".'),
        selector: prop('string', 'CSS selector to focus before pressing.'),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
      },
      required: ['key'],
      output: {
        ok: prop('boolean', 'Whether the key events were dispatched.'),
        key: prop('string', 'The key/combo that was pressed.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const key = nonEmptyString(args.key, '');
        if (key === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_press_key 需要 key');
        await page.pressKey(key, {
          selector: nonEmptyString(args.selector, ''),
          timeoutMs: actionTimeout(),
        });
        return {
          summary: `⌨️ 已按键 ${key}`,
          ok: true,
          key,
        };
      },
    }),
  );

  /* ------------------------------ 16. browser_hover ----------------------------- */
  tools.push(
    defineTool({
      name: 'browser_hover',
      title: '悬停元素',
      description:
        'Move the mouse over an element (Input.dispatchMouseEvent mouseMoved at its centre), which triggers hover-only UI: dropdown menus, tooltips, reveal-on-hover buttons. Use browser_snapshot afterwards to see what appeared. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        selector: prop('string', 'CSS selector of the element to hover.'),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
      },
      required: ['selector'],
      output: {
        ok: prop('boolean', 'Whether the hover was dispatched.'),
        selector: prop('string', 'The selector that was hovered.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const selector = nonEmptyString(args.selector, '');
        if (selector === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_hover 需要 selector');
        await page.hover(selector, { timeoutMs: actionTimeout() });
        return {
          summary: `🖱️ 已悬停 ${selector}`,
          ok: true,
          selector,
        };
      },
    }),
  );

  /* ---------------------------- 17. browser_wait_for ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_wait_for',
      title: '等待条件',
      description:
        'Wait until a selector appears or a text appears on the page (both given = both must match), polling until timeoutMs. Use it after an action that triggers async rendering (click "load more", submit a form) before taking a snapshot or reading text. Returns matched/waitedMs/reason instead of throwing on timeout. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        selector: prop('string', 'Wait until this CSS selector exists.'),
        text: prop('string', 'Wait until this text appears in the page body.'),
        timeoutMs: prop('number', 'Maximum wait in milliseconds.', { default: DEFAULT_ACTION_TIMEOUT_MS }),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
      },
      required: [],
      output: {
        matched: prop('boolean', 'Whether the condition was met.'),
        waitedMs: prop('number', 'How long the wait took in milliseconds.'),
        reason: prop('string', 'What matched, or why it timed out.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const timeoutMs = clampInt(args.timeoutMs, actionTimeout(), 0, 300_000);
        const result = await page.waitFor({
          selector: nonEmptyString(args.selector, ''),
          text: nonEmptyString(args.text, ''),
          timeoutMs,
        });
        return {
          summary: result.matched
            ? `⏳ 等待成功（${result.waitedMs}ms）：${result.reason}`
            : `⏰ 等待超时（${result.waitedMs}ms）：${result.reason}`,
          matched: result.matched === true,
          waitedMs: result.waitedMs,
          reason: result.reason,
        };
      },
    }),
  );

  /* -------------------------- 18. browser_handle_dialog ------------------------- */
  tools.push(
    defineTool({
      name: 'browser_handle_dialog',
      title: '处理对话框',
      description:
        'Accept or dismiss a JavaScript dialog (alert / confirm / prompt) that is blocking the page. Unhandled dialogs block all page operations; other tools report it clearly, then you call this with accept=true/false. For prompt() pass promptText. If no dialog is open the call reports handled=false and explains why. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        accept: prop('boolean', 'true = OK/accept, false = Cancel/dismiss.'),
        promptText: prop('string', 'Text to enter for a prompt() dialog.'),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
      },
      required: ['accept'],
      output: {
        handled: prop('boolean', 'Whether a dialog was handled.'),
        dialogType: prop('string', 'Dialog type (alert/confirm/prompt), or an empty string.'),
        dialogMessage: prop('string', 'Dialog message, or an empty string.'),
        note: prop('string', 'Human-readable note / failure explanation.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const pending = page.pendingDialog;
        const accept = args.accept === true;
        try {
          const result = await page.handleDialog(accept, nonEmptyString(args.promptText, ''));
          return {
            summary: `💬 已${accept ? '接受' : '取消'} ${result.dialogType === '' ? '' : `${result.dialogType} `}对话框${result.dialogMessage === '' ? '' : `："${result.dialogMessage}"`}`,
            handled: result.handled === true,
            dialogType: result.dialogType,
            dialogMessage: result.dialogMessage,
            note: '对话框已处理，页面应已恢复响应。',
          };
        } catch (error) {
          const normalized = asBrowserError(error);
          const note = `处理失败：${normalized.message}`;
          return {
            summary: `💬 处理对话框失败：${normalized.message}`,
            handled: false,
            dialogType: pending === undefined ? '' : pending.type,
            dialogMessage: pending === undefined ? '' : pending.message,
            note,
          };
        }
      },
    }),
  );

  /* --------------------------- 19. browser_upload_file -------------------------- */
  tools.push(
    defineTool({
      name: 'browser_upload_file',
      title: '上传文件',
      description:
        'Set files on an <input type="file"> element (DOM.setFileInputFiles), which is the only reliable way to drive a file picker. Files must be absolute paths that exist on the machine running dsh. Use it after clicking a "choose file" button leaves an empty input, or directly when the input is in the page. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        selector: prop('string', 'CSS selector of the file input element.'),
        files: prop('array', 'Absolute file paths to attach.', { items: prop('string') }),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
      },
      required: ['selector', 'files'],
      output: {
        ok: prop('boolean', 'Whether the files were attached.'),
        selector: prop('string', 'The file input selector.'),
        files: prop('array', 'Attached file paths.', { items: prop('string') }),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const selector = nonEmptyString(args.selector, '');
        if (selector === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_upload_file 需要 selector');
        const files = Array.isArray(args.files) ? args.files.filter((file) => typeof file === 'string' && file.trim() !== '') : [];
        if (files.length === 0) throw new BrowserError('INVALID_ARGUMENT', 'browser_upload_file 需要非空 files 数组');
        await page.setFiles(selector, files);
        return {
          summary: `📎 已选择 ${files.length} 个文件到 ${selector}`,
          ok: true,
          selector,
          files,
        };
      },
    }),
  );

  /* ------------------------------ 20. browser_drag ------------------------------ */
  tools.push(
    defineTool({
      name: 'browser_drag',
      title: '拖拽',
      description:
        'Drag from one element to another with simulated mouse events (press at the source centre, move in steps, release at the target centre). Use it for drag-and-drop UIs: sortable lists, sliders, kanban boards, resizable panels. HTML5 native drag-and-drop (dataTransfer-based drop zones) may not trigger. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        fromSelector: prop('string', 'CSS selector of the element to drag.'),
        toSelector: prop('string', 'CSS selector of the drop target.'),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
      },
      required: ['fromSelector', 'toSelector'],
      output: {
        ok: prop('boolean', 'Whether the drag was dispatched.'),
        fromSelector: prop('string', 'Source selector.'),
        toSelector: prop('string', 'Target selector.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute(args) {
        const page = await requirePage(args.pageId);
        const fromSelector = nonEmptyString(args.fromSelector, '');
        const toSelector = nonEmptyString(args.toSelector, '');
        if (fromSelector === '' || toSelector === '') {
          throw new BrowserError('INVALID_ARGUMENT', 'browser_drag 需要 fromSelector 与 toSelector');
        }
        await page.drag(fromSelector, toSelector, { timeoutMs: actionTimeout() });
        return {
          summary: `🖱️ 已拖拽 ${fromSelector} → ${toSelector}`,
          ok: true,
          fromSelector,
          toSelector,
        };
      },
    }),
  );

  /* ---------------------------- 21. browser_evaluate ---------------------------- */
  tools.push(
    defineTool({
      name: 'browser_evaluate',
      title: '执行 JavaScript',
      description:
        'Evaluate a JavaScript expression in the page and return its value (JSON-encoded, truncated). Use it for things the other tools cannot express: reading computed state, scraping structured data, calling page APIs, or debugging. Exceptions are reported in the exception field with ok=false (they do not fail the tool call). awaitPromise=true (default) awaits returned promises. Requires Chrome — call browser_connect first if not connected.',
      parameters: {
        expression: prop('string', 'JavaScript expression to evaluate, e.g. "document.title" or "JSON.stringify([...document.querySelectorAll(\\"a\\")].map(a => a.href))".'),
        pageId: prop('string', 'Target page id. Omit for the current page.'),
        awaitPromise: prop('boolean', 'Await a returned Promise.', { default: true }),
      },
      required: ['expression'],
      output: {
        ok: prop('boolean', 'Whether the expression evaluated without throwing.'),
        result: prop('string', 'JSON-encoded result (truncated), or an empty string on error.'),
        resultType: prop('string', 'Result type reported by CDP (string/object/number/boolean/undefined/exception).'),
        exception: prop('string', 'Exception text when ok=false, otherwise an empty string.'),
        truncated: prop('boolean', 'Whether the result string was truncated.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      render: renderWith((value) => (value.ok === true && value.result !== '' ? value.result : '')),
      async execute(args) {
        const page = await requirePage(args.pageId);
        const expression = typeof args.expression === 'string' ? args.expression : '';
        if (expression.trim() === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_evaluate 需要非空 expression');
        const detail = await page.evaluateDetailed(expression, { awaitPromise: args.awaitPromise !== false });
        let text = '';
        if (detail.ok) {
          if (typeof detail.value === 'string') text = detail.value;
          else {
            try {
              const json = JSON.stringify(detail.value);
              text = json === undefined ? String(detail.value) : json;
            } catch {
              text = String(detail.value);
            }
          }
        }
        const truncated = truncateText(text, EVALUATE_RESULT_MAX_CHARS);
        return {
          summary: detail.ok
            ? `🧪 表达式执行成功（${detail.type}${truncated.truncated ? '，已截断' : ''}）`
            : `🧪 表达式执行失败：${detail.exception}`,
          ok: detail.ok,
          result: truncated.text,
          resultType: detail.type,
          exception: detail.exception,
          truncated: truncated.truncated,
        };
      },
    }),
  );

  /* ------------------------------- 22. browser_ping ----------------------------- */
  tools.push(
    defineTool({
      name: 'browser_ping',
      title: '连通性自检',
      description:
        'Cheap connectivity self-check: verifies that a browser round-trip works and reports latency plus the number of open pages. Use it before a long browser task to confirm the connection is alive, or when another tool failed and you want to distinguish "browser is gone" from "selector is wrong". Never throws — failures are reported as ok=false with the reason.',
      parameters: {},
      required: [],
      output: {
        ok: prop('boolean', 'Whether the browser round-trip succeeded.'),
        latencyMs: prop('number', 'Round-trip latency in milliseconds.'),
        note: prop('string', 'Human-readable detail.'),
        summary: prop('string', 'One-line human-readable result.'),
      },
      async execute() {
        const started = Date.now();
        try {
          const browser = await manager.browser();
          const targets = await browser.listTargets();
          const latencyMs = Date.now() - started;
          const status = statusSnapshot();
          const pageCount = Array.isArray(targets) ? targets.length : 0;
          return {
            summary: `🏓 连接正常（${latencyMs}ms，${pageCount} 个页面）`,
            ok: true,
            latencyMs,
            note: `已连接（${status.browserVersion === '' ? '未知版本' : status.browserVersion}，${pageCount} 个页面）`,
          };
        } catch (error) {
          const normalized = asBrowserError(error);
          return {
            summary: `🏓 连接失败：${normalized.message}`,
            ok: false,
            latencyMs: Date.now() - started,
            note: `连接失败：${normalized.message}`,
          };
        }
      },
    }),
  );

  const options = readOptions();
  if (options.toolset === 'slim') {
    return tools.filter((tool) => SLIM_TOOL_NAMES.includes(tool.name));
  }
  return tools;
}
