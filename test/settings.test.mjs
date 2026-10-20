/**
 * `lib/config.mjs` 与 `lib/settings.mjs` 的离线单测。
 *
 * 约定：
 * - 不启动 Chrome、不连网、不读本机 Chrome 目录；
 * - manager 一律用假对象，RPC handler 的探测实现用注入的 `probeAll`；
 * - `lib/schemes.mjs` / `lib/chrome.mjs` 由 T1 并行编写：存在时做一致性校验，
 *   不存在时跳过（不因此让本测试失败）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_IDS,
  Config,
  DEFAULT_BROWSER_URL,
  DEFAULT_SCHEME,
  DEFAULT_VIEWPORT,
  SCHEME_IDS,
  SCHEME_OPTIONS,
  TOOLSET_IDS,
  readOption,
  resolveOptions,
  schemeLabel,
} from '../lib/config.mjs';
import {
  ENDPOINTS,
  RPC_CHANNEL,
  createRpcHandler,
  installRpcChannel,
  maskUrl,
  normalizeProbeList,
} from '../lib/settings.mjs';
import { BrowserError } from '../lib/errors.mjs';

/** 契约 §5.1 的字段（顺序即 patch 里的顺序）。 */
const CONFIG_KEYS = [
  'scheme',
  'browserUrl',
  'wsEndpoint',
  'wsHeaders',
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
];

/** 契约 §5.1 的默认值。 */
const CONFIG_DEFAULTS = {
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
  connectTimeoutMs: 15_000,
  actionTimeoutMs: 10_000,
};

/** 造一个 volatile 引用（schemastery `.volatile()` 在 apply 里的实际形态）。 */
function liveRef(value) {
  return { get: () => value };
}

// ─── Config schema ─────────────────────────────────────────

test('Config 声明了契约 §5.1 的全部字段，且与 cordis.patch.yml 的键一一对应', () => {
  assert.deepEqual(Object.keys(Config.dict).sort(), CONFIG_KEYS.slice().sort());
  assert.equal(Object.keys(Config.dict).length, 14);
});

test('Config 的每个字段都是 .volatile()（否则设置页看不到、保存也不生效）', () => {
  for (const key of CONFIG_KEYS) {
    assert.equal(Config.dict[key].meta.volatile, true, `${key} 必须 .volatile()`);
  }
});

test('Config 的字段类型与默认值与契约 §5.1 一致', () => {
  assert.equal(Config.dict.scheme.type, 'string');
  assert.equal(Config.dict.browserUrl.type, 'string');
  assert.equal(Config.dict.wsEndpoint.type, 'string');
  assert.equal(Config.dict.wsHeaders.type, 'string');
  assert.equal(Config.dict.channel.type, 'string');
  assert.equal(Config.dict.executablePath.type, 'string');
  assert.equal(Config.dict.headless.type, 'boolean');
  assert.equal(Config.dict.isolated.type, 'boolean');
  assert.equal(Config.dict.userDataDir.type, 'string');
  assert.equal(Config.dict.viewport.type, 'string');
  assert.equal(Config.dict.toolset.type, 'string');
  assert.equal(Config.dict.screenshotDir.type, 'string');
  assert.equal(Config.dict.connectTimeoutMs.type, 'number');
  assert.equal(Config.dict.actionTimeoutMs.type, 'number');

  for (const key of CONFIG_KEYS) {
    assert.equal(Config.dict[key].meta.default, CONFIG_DEFAULTS[key], `${key} 默认值不对`);
  }
});

test('Config 解析后 volatile 字段是带 .get() 的活引用，readOption / resolveOptions 都能读', () => {
  const parsed = new Config({ scheme: 'launch', headless: true, connectTimeoutMs: 3000 });
  // 当前 schemastery 版本里，volatile 字段即使有默认值也会解析成引用（实测），
  // readOption 的 `.get()` 兼容分支就是为它写的。
  assert.equal(typeof parsed.scheme, 'object');
  assert.equal(typeof parsed.scheme.get, 'function');
  assert.equal(readOption(parsed, 'scheme', 'x'), 'launch');
  assert.equal(readOption(parsed, 'headless', false), true);
  assert.equal(readOption(parsed, 'connectTimeoutMs', 0), 3000);

  // 未显式给的字段从 schema 默认值读回。
  const defaults = new Config({});
  assert.equal(readOption(defaults, 'scheme', 'x'), DEFAULT_SCHEME);
  assert.equal(readOption(defaults, 'browserUrl', 'x'), DEFAULT_BROWSER_URL);
  assert.equal(readOption(defaults, 'headless', true), false);
  assert.equal(readOption(defaults, 'isolated', false), true);
  assert.equal(readOption(defaults, 'connectTimeoutMs', 0), 15_000);

  // resolveOptions 直接吃这份解析结果（Host 半 apply 里的真实用法）。
  assert.equal(resolveOptions(defaults).scheme, DEFAULT_SCHEME);
  assert.equal(resolveOptions(parsed).scheme, 'launch');
  assert.equal(resolveOptions(parsed).headless, true);
});

// ─── readOption ────────────────────────────────────────────

test('readOption 兼容普通值、volatile 引用、缺失与读取异常', () => {
  assert.equal(readOption({ a: 1 }, 'a', 2), 1);
  assert.equal(readOption({ a: 'x' }, 'a', 'y'), 'x');
  assert.equal(readOption({}, 'a', 2), 2);
  assert.equal(readOption(undefined, 'a', 2), 2);
  assert.equal(readOption(null, 'a', 2), 2);
  assert.equal(readOption({ a: null }, 'a', 2), 2);
  assert.equal(readOption({ a: liveRef(3) }, 'a', 2), 3);
  assert.equal(readOption({ a: liveRef(null) }, 'a', 2), 2);
  assert.equal(readOption({ a: liveRef(undefined) }, 'a', 2), 2);
  assert.equal(
    readOption(
      {
        a: {
          get: () => {
            throw new Error('引用已失效');
          },
        },
      },
      'a',
      2,
    ),
    2,
  );
  const throwing = Object.defineProperty({}, 'a', {
    get() {
      throw new Error('getter 抛错');
    },
  });
  assert.equal(readOption(throwing, 'a', 2), 2);
});

// ─── resolveOptions ────────────────────────────────────────

test('resolveOptions 无参 / 空对象都返回契约默认值', () => {
  assert.deepEqual(resolveOptions(), CONFIG_DEFAULTS);
  assert.deepEqual(resolveOptions(undefined), CONFIG_DEFAULTS);
  assert.deepEqual(resolveOptions({}), CONFIG_DEFAULTS);
  assert.deepEqual(resolveOptions(null), CONFIG_DEFAULTS);
});

test('resolveOptions 读取普通值并保留用户设置', () => {
  const options = resolveOptions({
    scheme: 'browser-url',
    browserUrl: '127.0.0.1:9333',
    wsEndpoint: 'ws://127.0.0.1:9333/devtools/browser/abc',
    wsHeaders: '{"Authorization":"Bearer t"}',
    channel: 'canary',
    executablePath: 'C:/Program Files/Chrome/chrome.exe',
    headless: true,
    isolated: false,
    userDataDir: 'C:/tmp/profile',
    viewport: '1920x1080',
    toolset: 'slim',
    screenshotDir: 'C:/tmp/shots',
    connectTimeoutMs: 3000,
    actionTimeoutMs: 2500,
  });
  assert.deepEqual(options, {
    scheme: 'browser-url',
    browserUrl: '127.0.0.1:9333',
    wsEndpoint: 'ws://127.0.0.1:9333/devtools/browser/abc',
    wsHeaders: '{"Authorization":"Bearer t"}',
    channel: 'canary',
    executablePath: 'C:/Program Files/Chrome/chrome.exe',
    headless: true,
    isolated: false,
    userDataDir: 'C:/tmp/profile',
    viewport: '1920x1080',
    toolset: 'slim',
    screenshotDir: 'C:/tmp/shots',
    connectTimeoutMs: 3000,
    actionTimeoutMs: 2500,
  });
});

test('resolveOptions 兼容 volatile 引用（设置页保存后的形态）', () => {
  const options = resolveOptions({
    scheme: liveRef('ws-endpoint'),
    browserUrl: liveRef('http://127.0.0.1:9444'),
    wsEndpoint: liveRef('ws://127.0.0.1:9444/devtools/browser/x'),
    channel: liveRef('dev'),
    headless: liveRef(true),
    isolated: liveRef(false),
    viewport: liveRef('800x600'),
    toolset: liveRef('slim'),
    connectTimeoutMs: liveRef(9000),
    actionTimeoutMs: liveRef(4000),
  });
  assert.equal(options.scheme, 'ws-endpoint');
  assert.equal(options.browserUrl, 'http://127.0.0.1:9444');
  assert.equal(options.wsEndpoint, 'ws://127.0.0.1:9444/devtools/browser/x');
  assert.equal(options.channel, 'dev');
  assert.equal(options.headless, true);
  assert.equal(options.isolated, false);
  assert.equal(options.viewport, '800x600');
  assert.equal(options.toolset, 'slim');
  assert.equal(options.connectTimeoutMs, 9000);
  assert.equal(options.actionTimeoutMs, 4000);
});

test('resolveOptions 兼容 (ctx, config) 两参形态（与其它插件的调用习惯一致）', () => {
  const options = resolveOptions({ get: () => undefined }, { scheme: 'launch', headless: true });
  assert.equal(options.scheme, 'launch');
  assert.equal(options.headless, true);
});

test('resolveOptions 对非法值回落到默认值，不抛错', () => {
  const options = resolveOptions({
    scheme: 'not-a-scheme',
    browserUrl: '   ',
    channel: 'nightly',
    viewport: 'abc',
    toolset: 'tiny',
    connectTimeoutMs: -5,
    actionTimeoutMs: 'abc',
  });
  assert.equal(options.scheme, 'auto-connect');
  assert.equal(options.browserUrl, DEFAULT_BROWSER_URL);
  assert.equal(options.channel, 'stable');
  assert.equal(options.viewport, DEFAULT_VIEWPORT);
  assert.equal(options.toolset, 'full');
  assert.equal(options.connectTimeoutMs, 15_000);
  assert.equal(options.actionTimeoutMs, 10_000);
});

test('resolveOptions 把超时取整，避免表单里出现小数', () => {
  const options = resolveOptions({ connectTimeoutMs: 1500.7, actionTimeoutMs: '2000' });
  assert.equal(options.connectTimeoutMs, 1501);
  assert.equal(options.actionTimeoutMs, 2000);
});

// ─── 方案元数据 ────────────────────────────────────────────

test('SCHEME_IDS 与 SCHEME_OPTIONS 的顺序、内容一致', () => {
  assert.deepEqual(SCHEME_IDS, ['launch', 'auto-connect', 'browser-url', 'ws-endpoint']);
  assert.deepEqual(
    SCHEME_OPTIONS.map((item) => item.id),
    SCHEME_IDS,
  );
  for (const option of SCHEME_OPTIONS) {
    assert.ok(option.label.length > 0, `${option.id} 需要中文标签`);
    assert.ok(option.labelEn.length > 0, `${option.id} 需要英文标签`);
  }
  assert.match(schemeLabel('launch'), /方案 A/u);
  assert.equal(schemeLabel('unknown'), 'unknown');
});

test('CHANNEL_IDS / TOOLSET_IDS 与契约一致', () => {
  assert.deepEqual(CHANNEL_IDS, ['stable', 'beta', 'dev', 'canary']);
  assert.deepEqual(TOOLSET_IDS, ['full', 'slim']);
});

test('SCHEME_OPTIONS 与 lib/schemes.mjs 的 SCHEMES 顺序一致（该模块可加载时）', async () => {
  let schemes;
  try {
    schemes = await import('../lib/schemes.mjs');
  } catch {
    return; // T1 尚未交付：跳过，不制造跨 owner 的时序依赖
  }
  assert.ok(Array.isArray(schemes.SCHEMES), 'lib/schemes.mjs 应导出 SCHEMES 数组');
  assert.deepEqual(
    schemes.SCHEMES.map((item) => item.id),
    SCHEME_IDS,
  );
});

test('CHANNEL_IDS 与 lib/chrome.mjs 的 CHANNELS 一致（该模块可加载时）', async () => {
  let chrome;
  try {
    chrome = await import('../lib/chrome.mjs');
  } catch {
    return;
  }
  assert.ok(Array.isArray(chrome.CHANNELS), 'lib/chrome.mjs 应导出 CHANNELS 数组');
  assert.deepEqual(chrome.CHANNELS, CHANNEL_IDS);
});

// ─── 公共错误 / URL 打码 / 探测规整 ─────────────────────────

test('RPC 失败信封复用 lib/errors.mjs 的统一错误码（普通 Error 落到 UNKNOWN）', async () => {
  // 设置层不自己造错误映射：manager 抛 BrowserError 时保留 code/details，抛普通
  // Error 时落到团队统一的兜底码 UNKNOWN。
  const manager = fakeManager({
    status() {
      throw new Error('普通错误');
    },
  });
  const result = await createRpcHandler(fakeCtx(), {}, manager)('status', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNKNOWN');
  assert.equal(result.error.message, '普通错误');
  assert.deepEqual(result.error.details, {});
});

test('maskUrl 把 URL 内嵌凭据打码，其余原样', () => {
  assert.equal(maskUrl('ws://user:pass@127.0.0.1:9222/devtools/browser/x'), 'ws://***@127.0.0.1:9222/devtools/browser/x');
  assert.equal(maskUrl('ws://127.0.0.1:9222/devtools/browser/x'), 'ws://127.0.0.1:9222/devtools/browser/x');
  assert.equal(maskUrl(''), '');
  assert.equal(maskUrl(undefined), '');
  assert.equal(maskUrl(42), '');
});

test('normalizeProbeList 按方案顺序补齐缺失项并标记当前方案', () => {
  const list = normalizeProbeList(
    [
      { id: 'launch', available: true, detail: 'chrome 已找到', label: '方案 A：启动全新浏览器' },
      { id: 'browser-url', available: false, detail: '端口不可达' },
      { id: 'unknown-scheme', available: true },
    ],
    'auto-connect',
  );
  assert.deepEqual(
    list.map((item) => item.id),
    SCHEME_IDS,
  );
  assert.equal(list[0].available, true);
  assert.equal(list[0].detail, 'chrome 已找到');
  assert.equal(list[1].available, false);
  // auto-connect 没出现在探测结果里 → 补成不可用，并说明原因。
  assert.match(list[1].detail, /探测不可用/u);
  assert.equal(list[2].detail, '端口不可达');
  assert.equal(list[2].available, false);
  assert.equal(list[1].isCurrent, true);
  assert.equal(normalizeProbeList(undefined, 'launch').length, 4);
  assert.equal(normalizeProbeList('garbage', 'launch').every((item) => item.available === false), true);
});

// ─── RPC handler ───────────────────────────────────────────

/** 假的 BrowserManager；`calls` 记录调用参数。 */
function fakeManager(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    status() {
      calls.push(['status']);
      return {
        connected: true,
        scheme: 'auto-connect',
        wsUrl: 'ws://user:pass@127.0.0.1:9222/devtools/browser/x',
        browserVersion: 'Chrome/155.0',
        launchedPid: 0,
        launchedUserDataDir: '',
        lastError: '',
        pageCount: 2,
      };
    },
    async connect(options) {
      calls.push(['connect', options]);
      return {
        scheme: options.scheme,
        wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
        browserVersion: 'Chrome/155.0',
        reused: true,
        launchedPid: 0,
      };
    },
    async disconnect(options) {
      calls.push(['disconnect', options]);
      return { closedOwnedBrowser: false };
    },
    async browser() {
      calls.push(['browser']);
      return {
        createTarget: async (url) => {
          calls.push(['createTarget', url]);
          return { targetId: 'page-1', url };
        },
      };
    },
  };
  return Object.assign(base, overrides);
}

/** 一个只有 logger 的假 ctx。 */
function fakeCtx() {
  return { logger: { debug: () => {}, info: () => {}, warn: () => {} } };
}

test('ENDPOINTS 覆盖契约 §3.10 的五个端点', () => {
  assert.deepEqual([...ENDPOINTS].sort(), ['connect', 'disconnect', 'openBrowserPage', 'probe', 'status']);
});

test('status 端点返回 manager 状态，并给 WS URL 打码', async () => {
  const manager = fakeManager();
  const handler = createRpcHandler(fakeCtx(), {}, manager);
  const result = await handler('status', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.connected, true);
  assert.equal(result.value.scheme, 'auto-connect');
  assert.equal(result.value.schemeLabel, '方案 B：复用当前浏览器（autoConnect）');
  assert.equal(result.value.browserVersion, 'Chrome/155.0');
  assert.equal(result.value.pageCount, 2);
  assert.equal(result.value.wsUrl, 'ws://***@127.0.0.1:9222/devtools/browser/x');
  assert.equal(result.value.configScheme, 'auto-connect');
  assert.equal(result.value.toolset, 'full');
});

test('status 端点尊重已保存的配置方案（configScheme）', async () => {
  const handler = createRpcHandler(fakeCtx(), { scheme: liveRef('browser-url') }, fakeManager());
  const result = await handler('status', {});
  assert.equal(result.value.configScheme, 'browser-url');
  assert.equal(result.value.configSchemeLabel, '方案 C：连接调试端口（browser-url）');
});

test('status 端点把 manager 抛出的 BrowserError 转成失败信封', async () => {
  const manager = fakeManager({
    status() {
      throw new BrowserError('CDP_ERROR', 'CDP 挂了', { method: 'Browser.getVersion' });
    },
  });
  const handler = createRpcHandler(fakeCtx(), {}, manager);
  const result = await handler('status', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CDP_ERROR');
  assert.equal(result.error.message, 'CDP 挂了');
  assert.deepEqual(result.error.details, { method: 'Browser.getVersion' });
});

test('probe 端点转发注入的探测实现，并规整成四方案列表', async () => {
  const seen = [];
  const deps = {
    probeAll: async (config, currentScheme) => {
      seen.push([config, currentScheme]);
      return [
        { id: 'launch', available: true, detail: 'chrome.exe 已找到' },
        { id: 'auto-connect', available: false, detail: 'DevToolsActivePort 不存在' },
      ];
    },
  };
  const handler = createRpcHandler(fakeCtx(), { scheme: 'launch' }, fakeManager(), deps);
  const result = await handler('probe', {});
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].scheme, 'launch');
  assert.equal(seen[0][1], 'launch');
  assert.equal(result.value.currentScheme, 'launch');
  assert.equal(result.value.schemes.length, 4);
  assert.equal(result.value.schemes[0].available, true);
  assert.equal(result.value.schemes[0].detail, 'chrome.exe 已找到');
  assert.equal(result.value.schemes[1].isCurrent, false);
  assert.equal(result.value.schemes[0].isCurrent, true);
});

test('probe 端点允许 payload 指定要探测的方案', async () => {
  const seen = [];
  const deps = {
    probeAll: async (config, currentScheme) => {
      seen.push(currentScheme);
      return [];
    },
  };
  const handler = createRpcHandler(fakeCtx(), { scheme: 'launch' }, fakeManager(), deps);
  const result = await handler('probe', { scheme: 'ws-endpoint' });
  assert.equal(result.ok, true);
  assert.equal(seen[0], 'ws-endpoint');
  assert.equal(result.value.currentScheme, 'ws-endpoint');
  assert.equal(result.value.schemes[3].isCurrent, true);
});

test('probe 端点在探测实现缺失或抛错时降级为「全部不可用」，不整体失败', async () => {
  const noProbe = createRpcHandler(fakeCtx(), {}, fakeManager(), { probeAll: null });
  const degraded = await noProbe('probe', {});
  assert.equal(degraded.ok, true);
  assert.equal(degraded.value.schemes.length, 4);
  assert.equal(degraded.value.schemes.every((item) => item.available === false), true);

  const throwing = createRpcHandler(fakeCtx(), {}, fakeManager(), {
    probeAll: async () => {
      throw new BrowserError('PROBE_FAILED', '探测炸了');
    },
  });
  const failedProbe = await throwing('probe', {});
  assert.equal(failedProbe.ok, true);
  assert.equal(failedProbe.value.schemes.every((item) => item.detail === '探测炸了'), true);
});

test('connect 端点按 payload 指定方案调用 manager，并返回连接摘要字段', async () => {
  const manager = fakeManager();
  const handler = createRpcHandler(fakeCtx(), { scheme: 'launch' }, manager);
  const result = await handler('connect', { scheme: 'browser-url' });
  assert.equal(result.ok, true);
  assert.equal(result.value.connected, true);
  assert.equal(result.value.scheme, 'browser-url');
  assert.equal(result.value.schemeLabel, '方案 C：连接调试端口（browser-url）');
  assert.equal(result.value.browserVersion, 'Chrome/155.0');
  assert.equal(result.value.reused, true);
  assert.deepEqual(
    manager.calls.filter((item) => item[0] === 'connect'),
    [['connect', { scheme: 'browser-url' }]],
  );
});

test('connect 端点缺省使用已保存配置的方案', async () => {
  const manager = fakeManager();
  const handler = createRpcHandler(fakeCtx(), { scheme: liveRef('launch') }, manager);
  const result = await handler('connect', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.scheme, 'launch');
});

test('connect 端点拒绝未知方案，且不调用 manager', async () => {
  const manager = fakeManager();
  const handler = createRpcHandler(fakeCtx(), {}, manager);
  const result = await handler('connect', { scheme: 'nope' });
  assert.equal(result.ok, false);
  // 契约 §3.1 的稳定码：未知方案用 SCHEME_UNKNOWN（原文拼写，见 lib/errors.mjs）。
  assert.equal(result.error.code, 'SCHEME_UNKNOWN');
  assert.deepEqual(result.error.details.allowed, SCHEME_IDS);
  assert.equal(manager.calls.length, 0);
});

test('connect 端点把连接失败转成带稳定错误码的失败信封', async () => {
  const manager = fakeManager({
    async connect() {
      throw new BrowserError('CONNECT_FAILED', '目标端口不可达', { port: 9222 });
    },
  });
  const handler = createRpcHandler(fakeCtx(), {}, manager);
  const result = await handler('connect', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONNECT_FAILED');
  assert.equal(result.error.message, '目标端口不可达');
  assert.deepEqual(result.error.details, { port: 9222 });
});

test('connect 端点在 manager 缺能力时返回 NOT_AVAILABLE', async () => {
  const handler = createRpcHandler(fakeCtx(), {}, {});
  const result = await handler('connect', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_AVAILABLE');
});

test('disconnect 端点透传 closeBrowser 并报告是否关闭了自有浏览器', async () => {
  const manager = fakeManager();
  const handler = createRpcHandler(fakeCtx(), {}, manager);
  const result = await handler('disconnect', { closeBrowser: true });
  assert.equal(result.ok, true);
  assert.equal(result.value.disconnected, true);
  assert.equal(result.value.closedOwnedBrowser, false);
  assert.deepEqual(
    manager.calls.filter((item) => item[0] === 'disconnect'),
    [['disconnect', { closeBrowser: true }]],
  );

  const closing = fakeManager({
    async disconnect(options) {
      return { closedOwnedBrowser: options.closeBrowser === true };
    },
  });
  const closingResult = await createRpcHandler(fakeCtx(), {}, closing)('disconnect', { closeBrowser: true });
  assert.equal(closingResult.value.closedOwnedBrowser, true);
});

test('openBrowserPage 端点在已连接的浏览器里开新标签页，默认 about:blank', async () => {
  const manager = fakeManager();
  const handler = createRpcHandler(fakeCtx(), {}, manager);
  const explicit = await handler('openBrowserPage', { url: 'https://example.com' });
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.value, { targetId: 'page-1', url: 'https://example.com' });

  const fallback = await handler('openBrowserPage', {});
  assert.equal(fallback.ok, true);
  assert.equal(fallback.value.url, 'about:blank');
  assert.equal(manager.calls.filter((item) => item[0] === 'createTarget').length, 2);
});

test('未知端点 / 缺少端点名 / 已取消的请求都返回失败信封', async () => {
  const handler = createRpcHandler(fakeCtx(), {}, fakeManager());
  const unknown = await handler('whatever', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_ENDPOINT');
  assert.deepEqual(unknown.error.details.allowed, ENDPOINTS);

  const missing = await handler('', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'UNKNOWN_ENDPOINT');

  const controller = new AbortController();
  controller.abort();
  const aborted = await handler('status', {}, controller.signal);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, 'ABORTED');
});

test('RPC handler 的返回值始终是 { ok, value } 或 { ok, error: { code, message, details } }', async () => {
  const handler = createRpcHandler(fakeCtx(), {}, fakeManager());
  for (const endpoint of ['status', 'probe', 'connect', 'disconnect', 'openBrowserPage']) {
    const result = await handler(endpoint, {});
    if (result.ok === true) {
      assert.ok('value' in result, `${endpoint} 成功时应带 value`);
    } else {
      assert.equal(typeof result.error.code, 'string');
      assert.equal(typeof result.error.message, 'string');
      assert.equal(typeof result.error.details, 'object');
      assert.equal(Array.isArray(result.error.details), false);
    }
  }
});

// ─── prefix 路由注册（HTTP 405 的根因） ──────────────────────

/** 假 ctx：记录 inject 的服务、effect 与 webServer.register 收到的路由。 */
function fakeRpcCtx() {
  const state = { injected: null, effects: 0, registered: null, disposed: 0 };
  const rpcCtx = {
    connection: {
      admit: () => ({ peer: { kind: 'test' } }),
      rpc: {
        handle: () => {
          throw new Error('prefix 路由可用时不应回退到 rpc.handle');
        },
      },
    },
    webServer: {
      register: (route) => {
        state.registered = route;
        return () => {
          state.disposed += 1;
        };
      },
    },
    effect: (fn) => {
      state.effects += 1;
      return fn();
    },
  };
  const ctx = {
    inject: (deps, callback) => {
      state.injected = deps;
      callback(rpcCtx);
    },
    logger: { debug: () => {}, warn: () => {} },
  };
  return { ctx, state, rpcCtx };
}

test('installRpcChannel 同时 inject connection 与 webServer，并注册 prefix 路由', () => {
  const { ctx, state } = fakeRpcCtx();
  installRpcChannel(ctx, {}, fakeManager());
  assert.deepEqual(state.injected, ['connection', 'webServer']);
  assert.equal(state.effects, 1);
  assert.equal(state.registered.kind, 'prefix');
  assert.equal(state.registered.path, RPC_CHANNEL);
  assert.equal(RPC_CHANNEL, '/dsh-chrome-devtools');
  assert.equal(typeof state.registered.handler, 'function');
});

test('installRpcChannel 在 connection / webServer 缺失时不崩，也不注册路由', () => {
  const state = { injected: null, registered: null };
  const ctx = {
    inject: (deps, callback) => {
      state.injected = deps;
      callback({ effect: (fn) => fn() });
    },
    logger: { debug: () => {}, warn: () => {} },
  };
  assert.doesNotThrow(() => installRpcChannel(ctx, {}, fakeManager()));
  assert.equal(state.registered, null);
});

/** 假的 http 请求对象（带 async iterator）。 */
function fakeRequest({ method = 'POST', url = `${RPC_CHANNEL}/status`, body = '{}' } = {}) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8');
    },
    on() {},
  };
}

/** 假的 http 响应对象。 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? null;
    },
    end(text) {
      this.body = text ?? '';
    },
  };
}

test('prefix 路由返回 Connection 信封：POST /dsh-chrome-devtools/status', async () => {
  const { ctx, state } = fakeRpcCtx();
  installRpcChannel(ctx, {}, fakeManager());
  const response = fakeResponse();
  await state.registered.handler(
    fakeRequest({ body: JSON.stringify({ rpcId: 'rpc-1', payload: {} }) }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/json');
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, 'rpc-1');
  assert.equal(parsed.result.ok, true);
  assert.equal(parsed.result.value.connected, true);
});

test('prefix 路由从 body.method 取端点，并拒绝非 POST / 非法 JSON / 未认证请求', async () => {
  const { ctx, state } = fakeRpcCtx();
  installRpcChannel(ctx, {}, fakeManager());

  const viaBody = fakeResponse();
  await state.registered.handler(
    fakeRequest({ url: RPC_CHANNEL, body: JSON.stringify({ method: 'disconnect', payload: { closeBrowser: true } }) }),
    viaBody,
  );
  assert.equal(viaBody.statusCode, 200);
  assert.equal(JSON.parse(viaBody.body).result.value.disconnected, true);

  const getResponse = fakeResponse();
  await state.registered.handler(fakeRequest({ method: 'GET' }), getResponse);
  assert.equal(getResponse.statusCode, 404);

  const badJson = fakeResponse();
  await state.registered.handler(fakeRequest({ body: 'not-json' }), badJson);
  assert.equal(badJson.statusCode, 400);

  // 未认证：admit 返回 rejection 时应回 401，而不是继续处理请求。
  const rejecting = fakeRpcCtx();
  rejecting.rpcCtx.connection.admit = () => ({ rejection: 401 });
  installRpcChannel(rejecting.ctx, {}, fakeManager());
  const rejected = fakeResponse();
  await rejecting.state.registered.handler(fakeRequest(), rejected);
  assert.equal(rejected.statusCode, 401);
});
