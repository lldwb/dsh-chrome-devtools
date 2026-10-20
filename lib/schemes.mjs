/**
 * 四种浏览器连接方案的元数据、探测与连接计划解析。
 *
 * 这一层把「用户/设置页选了什么方案」翻译成 connection.mjs 能直接执行的东西：
 * - {@link SCHEMES}：静态元数据（顺序即界面顺序），设置页下拉与工具枚举都用它；
 * - {@link probeScheme}：轻量探测（不建 CDP 连接），永不抛错；
 * - {@link planScheme}：解析成 `{ kind: 'launch' | 'ws' | 'invalid' }` 连接计划；
 * - {@link probeAllSchemes}：一次探测四个方案，供 `browser_status` 用。
 *
 * @module lib/schemes
 */

import {
  defaultUserDataDir,
  normalizeBrowserUrl,
  probeBrowserUrl,
  readDevToolsActivePort,
  resolveChromeExecutable,
} from './chrome.mjs';

/**
 * 连接相关配置的默认值（与 docs/CONTRACT.md §5.1 一致）。
 *
 * 注意这里只是 connection/schemes 层的兜底：正式配置对象由 lib/config.mjs 的
 * `resolveOptions()` 产出；但本层不能假设调用方一定先跑过它（T1 单测与工具直连
 * 都会传部分对象），所以每个字段都要能缺省。
 *
 * @type {Readonly<Record<string, unknown>>}
 */
export const DEFAULT_CONFIG = Object.freeze({
  scheme: 'auto-connect',
  browserUrl: 'http://127.0.0.1:9222',
  wsEndpoint: '',
  wsHeaders: '',
  channel: 'stable',
  executablePath: '',
  headless: false,
  isolated: true,
  userDataDir: '',
  viewport: '1280x800',
  toolset: 'full',
  screenshotDir: '',
  connectTimeoutMs: 15000,
  actionTimeoutMs: 10000,
});

/**
 * 四方案的静态元数据（顺序即界面顺序）。
 *
 * `fields` 列出该方案真正会用到的配置字段，供设置页按方案显示/隐藏输入框；
 * `needsChrome` 表示是否需要本机能找到 Chrome 可执行文件。
 *
 * @type {ReadonlyArray<{ id: string, label: string, labelEn: string, description: string,
 *   descriptionEn: string, fields: string[], needsChrome: boolean }>}
 */
export const SCHEMES = Object.freeze([
  Object.freeze({
    id: 'launch',
    label: '方案 A：启动全新浏览器',
    labelEn: 'Launch a new browser',
    description: '启动一个全新的 Chrome 实例（独立 profile，可无头）。插件退出时关闭它，不影响你正在用的浏览器。',
    descriptionEn: 'Launch a fresh Chrome instance with its own profile; the plugin owns and closes it.',
    fields: ['channel', 'executablePath', 'headless', 'isolated', 'userDataDir', 'viewport'],
    needsChrome: true,
  }),
  Object.freeze({
    id: 'auto-connect',
    label: '方案 B：复用当前浏览器（autoConnect）',
    labelEn: 'Reuse the current browser (autoConnect)',
    description: '直接复用你正在用的 Chrome：保留 Cookie、登录态和已开标签页。需要 Chrome 144+ 并在 chrome://inspect/#remote-debugging 里允许过。',
    descriptionEn: 'Attach to your already-running Chrome, preserving cookies, logins and open tabs.',
    fields: ['channel', 'userDataDir'],
    needsChrome: false,
  }),
  Object.freeze({
    id: 'browser-url',
    label: '方案 C：连接调试端口（browser-url）',
    labelEn: 'Connect to a debug port (browser-url)',
    description: '连接一个已手动带 --remote-debugging-port=<port> 启动的 Chrome（例如 127.0.0.1:9222）。',
    descriptionEn: 'Connect to a Chrome started with --remote-debugging-port=<port>.',
    fields: ['browserUrl'],
    needsChrome: false,
  }),
  Object.freeze({
    id: 'ws-endpoint',
    label: '方案 D：WebSocket 直连（wsEndpoint）',
    labelEn: 'Connect to a WebSocket endpoint (wsEndpoint)',
    description: '直连一个 CDP WebSocket 端点（ws:// 或 wss://）。注意：Node 内置 WebSocket 不支持自定义鉴权头，需要鉴权的端点目前不可用。',
    descriptionEn: 'Connect directly to a CDP WebSocket endpoint. Custom auth headers are not supported by the built-in WebSocket.',
    fields: ['wsEndpoint', 'wsHeaders'],
    needsChrome: false,
  }),
]);

/**
 * 是否是合法的方案 id。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSchemeId(value) {
  return typeof value === 'string' && SCHEMES.some((scheme) => scheme.id === value);
}

/**
 * 按 id 取方案元数据。
 *
 * @param {unknown} value
 * @returns {{ id: string, label: string, labelEn: string, description: string, descriptionEn: string, fields: string[], needsChrome: boolean } | undefined}
 */
export function getScheme(value) {
  return SCHEMES.find((scheme) => scheme.id === value);
}

/**
 * 把部分/空配置补齐成连接层需要的纯对象。
 *
 * 只处理 connection/schemes 关心的字段；未知字段原样保留（设置页可能传了别的）。
 *
 * @param {unknown} config
 * @returns {Record<string, any>}
 */
export function normalizeConfig(config) {
  /** @type {Record<string, any>} */
  const source = config !== null && typeof config === 'object' ? { ...config } : {};
  /** @type {Record<string, any>} */
  const result = { ...DEFAULT_CONFIG, ...source };
  for (const key of ['scheme', 'browserUrl', 'wsEndpoint', 'wsHeaders', 'channel', 'executablePath', 'userDataDir', 'viewport', 'toolset', 'screenshotDir']) {
    if (typeof result[key] !== 'string') result[key] = DEFAULT_CONFIG[key];
    else result[key] = result[key].trim();
  }
  if (result.scheme === '') result.scheme = DEFAULT_CONFIG.scheme;
  if (result.channel === '') result.channel = DEFAULT_CONFIG.channel;
  if (result.viewport === '') result.viewport = DEFAULT_CONFIG.viewport;
  result.headless = result.headless === true;
  result.isolated = result.isolated !== false;
  for (const key of ['connectTimeoutMs', 'actionTimeoutMs']) {
    const numeric = Number(result[key]);
    result[key] = Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : DEFAULT_CONFIG[key];
  }
  return result;
}

/**
 * 解析 `wsHeaders`（JSON 字符串）成对象。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, headers: Record<string, string> } | { ok: false, reason: string }}
 */
export function parseWsHeaders(raw) {
  if (raw === undefined || raw === null) return { ok: true, headers: {} };
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: true, headers: {} };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `wsHeaders 不是合法 JSON：${/** @type {Error} */ (error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'wsHeaders 必须是 JSON 对象，例如 {"Authorization":"Basic ..."}' };
  }
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) continue;
    headers[key] = String(value);
  }
  return { ok: true, headers };
}

/** 取 auto-connect 要读的 profile 目录：显式 userDataDir 优先，否则按 channel 推断。 */
function autoConnectUserDataDir(config) {
  if (typeof config.userDataDir === 'string' && config.userDataDir !== '') return config.userDataDir;
  return defaultUserDataDir(config.channel);
}

/** probeBrowserUrl 的探测预算：设置页/status 要快，最多 5s。 */
function probeTimeout(config) {
  const configured = Number(config?.connectTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) return Math.min(configured, 5000);
  return 3000;
}

/**
 * 探测某方案在当前配置下是否可用（不建立 CDP 连接，只做轻量探测）。
 *
 * 永不抛错：任何异常都折成 `{ available: false, detail }`。
 *
 * @param {unknown} scheme - 方案 id。
 * @param {unknown} config - 配置快照（可只给部分字段）。
 * @returns {Promise<{ available: boolean, detail: string, target?: string }>}
 */
export async function probeScheme(scheme, config) {
  try {
    if (!isSchemeId(scheme)) {
      return { available: false, detail: `未知连接方案 "${String(scheme)}"（可用：${SCHEMES.map((entry) => entry.id).join(', ')}）` };
    }
    const resolved = normalizeConfig(config);
    if (scheme === 'launch') {
      const executablePath = resolveChromeExecutable({
        executablePath: resolved.executablePath,
        channel: resolved.channel,
      });
      if (executablePath === undefined) {
        return {
          available: false,
          detail: '找不到 Chrome 可执行文件：请安装 Chrome，或在设置里填写 executablePath。',
        };
      }
      const mode = resolved.headless === true ? '无头' : '有窗口';
      return { available: true, detail: `将启动${mode} Chrome：${executablePath}`, target: executablePath };
    }
    if (scheme === 'auto-connect') {
      const userDataDir = autoConnectUserDataDir(resolved);
      const activePort = readDevToolsActivePort(userDataDir);
      if (activePort === undefined) {
        return {
          available: false,
          detail:
            `在 profile 目录里没有找到 DevToolsActivePort（${userDataDir}）。` +
            '请确认：Chrome 144+ 正在运行 → 打开 chrome://inspect/#remote-debugging → 允许远程调试。',
          target: userDataDir,
        };
      }
      return { available: true, detail: `将复用当前 Chrome（调试端口 ${activePort.port}）`, target: activePort.wsUrl };
    }
    if (scheme === 'browser-url') {
      const browserUrl = normalizeBrowserUrl(resolved.browserUrl);
      if (browserUrl === undefined) {
        return { available: false, detail: `browserUrl 不是合法地址："${resolved.browserUrl}"（应形如 http://127.0.0.1:9222）` };
      }
      const info = await probeBrowserUrl(browserUrl, probeTimeout(resolved));
      if (info === undefined) {
        return {
          available: false,
          detail: `在 ${browserUrl} 上探测 /json/version 失败。请确认 Chrome 是以 --remote-debugging-port 启动的，且端口可达。`,
          target: browserUrl,
        };
      }
      return {
        available: true,
        detail: `调试端点可用：${info.browser === '' ? browserUrl : info.browser}（${browserUrl}）`,
        target: info.webSocketDebuggerUrl !== '' ? info.webSocketDebuggerUrl : browserUrl,
      };
    }
    // ws-endpoint
    const wsEndpoint = resolved.wsEndpoint;
    if (wsEndpoint === '') {
      return { available: false, detail: '未配置 wsEndpoint：请填写以 ws:// 或 wss:// 开头的 CDP WebSocket 地址。' };
    }
    if (!/^wss?:\/\//i.test(wsEndpoint)) {
      return { available: false, detail: `wsEndpoint 必须以 ws:// 或 wss:// 开头："${wsEndpoint}"` };
    }
    const parsedHeaders = parseWsHeaders(resolved.wsHeaders);
    if (!parsedHeaders.ok) return { available: false, detail: parsedHeaders.reason };
    if (Object.keys(parsedHeaders.headers).length > 0) {
      return {
        available: false,
        detail:
          'Node 内置 WebSocket 不支持自定义握手头（实测会被静默忽略），wsHeaders 必须留空。' +
          '需要鉴权的端点请改用本地端口转发 + browser-url 方案。',
        target: wsEndpoint,
      };
    }
    return { available: true, detail: `将直连 WebSocket 端点：${wsEndpoint}`, target: wsEndpoint };
  } catch (error) {
    return { available: false, detail: `探测失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 把一个方案解析成连接计划，供 connection.mjs 执行。
 *
 * - `launch`：`{ kind: 'launch', executablePath, channel, headless, userDataDir, viewport, isolated, timeoutMs }`
 * - `ws`：`{ kind: 'ws', wsUrl, source: 'auto-connect' | 'browser-url' | 'ws-endpoint', headers? }`
 * - 无法解析：`{ kind: 'invalid', reason }`
 *
 * @param {unknown} scheme - 方案 id。
 * @param {unknown} config - 配置快照（可只给部分字段）。
 * @returns {Promise<object>}
 */
export async function planScheme(scheme, config) {
  if (!isSchemeId(scheme)) {
    return { kind: 'invalid', reason: `未知连接方案 "${String(scheme)}"（可用：${SCHEMES.map((entry) => entry.id).join(', ')}）` };
  }
  const resolved = normalizeConfig(config);
  if (scheme === 'launch') {
    return {
      kind: 'launch',
      scheme,
      executablePath: resolved.executablePath !== '' ? resolved.executablePath : undefined,
      channel: resolved.channel,
      headless: resolved.headless,
      isolated: resolved.isolated,
      userDataDir: resolved.userDataDir !== '' ? resolved.userDataDir : undefined,
      viewport: resolved.viewport,
      timeoutMs: resolved.connectTimeoutMs,
    };
  }
  if (scheme === 'auto-connect') {
    const userDataDir = autoConnectUserDataDir(resolved);
    const activePort = readDevToolsActivePort(userDataDir);
    if (activePort === undefined) {
      return {
        kind: 'invalid',
        reason:
          `没有找到可复用的 Chrome 调试端点（${userDataDir}/DevToolsActivePort 不存在或无效）。` +
          '需要 Chrome 144+ 运行中，并在 chrome://inspect/#remote-debugging 里允许远程调试。',
      };
    }
    return { kind: 'ws', scheme, wsUrl: activePort.wsUrl, source: 'auto-connect', userDataDir };
  }
  if (scheme === 'browser-url') {
    const browserUrl = normalizeBrowserUrl(resolved.browserUrl);
    if (browserUrl === undefined) {
      return { kind: 'invalid', reason: `browserUrl 不是合法地址："${resolved.browserUrl}"（应形如 http://127.0.0.1:9222）` };
    }
    const info = await probeBrowserUrl(browserUrl, probeTimeout(resolved));
    if (info === undefined) {
      return {
        kind: 'invalid',
        reason: `连接 ${browserUrl} 的 /json/version 失败：请确认 Chrome 以 --remote-debugging-port 启动且端口可达。`,
      };
    }
    if (info.webSocketDebuggerUrl === '') {
      return { kind: 'invalid', reason: `${browserUrl} 的 /json/version 没有返回 webSocketDebuggerUrl。` };
    }
    return { kind: 'ws', scheme, wsUrl: info.webSocketDebuggerUrl, source: 'browser-url', browserUrl };
  }
  // ws-endpoint
  const wsEndpoint = resolved.wsEndpoint;
  if (wsEndpoint === '') {
    return { kind: 'invalid', reason: '未配置 wsEndpoint：请填写以 ws:// 或 wss:// 开头的 CDP WebSocket 地址。' };
  }
  if (!/^wss?:\/\//i.test(wsEndpoint)) {
    return { kind: 'invalid', reason: `wsEndpoint 必须以 ws:// 或 wss:// 开头："${wsEndpoint}"` };
  }
  const parsedHeaders = parseWsHeaders(resolved.wsHeaders);
  if (!parsedHeaders.ok) return { kind: 'invalid', reason: parsedHeaders.reason };
  const plan = { kind: 'ws', scheme, wsUrl: wsEndpoint, source: 'ws-endpoint' };
  if (Object.keys(parsedHeaders.headers).length > 0) plan.headers = parsedHeaders.headers;
  return plan;
}

/**
 * 一次性探测四个方案，供 `browser_status` 用。
 *
 * 返回值严格是契约 §3.4 的形状（不含额外字段），避免工具层 output schema 校验失败。
 *
 * @param {unknown} config - 配置快照。
 * @param {unknown} [currentScheme] - 当前方案 id，用于标记 `isCurrent`。
 * @returns {Promise<Array<{ id: string, label: string, available: boolean, detail: string, isCurrent: boolean }>>}
 */
export async function probeAllSchemes(config, currentScheme) {
  return await Promise.all(
    SCHEMES.map(async (scheme) => {
      const probe = await probeScheme(scheme.id, config);
      return {
        id: scheme.id,
        label: scheme.label,
        available: probe.available === true,
        detail: typeof probe.detail === 'string' ? probe.detail : '',
        isCurrent: scheme.id === currentScheme,
      };
    }),
  );
}
