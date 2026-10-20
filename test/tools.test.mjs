/**
 * `lib/tools.mjs` 的单测：22 个工具的名字、slim 过滤与每个工具的实际行为。
 *
 * 全部用假 manager / fake browser / 假 session（不启动 Chrome）：断言的重点是
 * 「工具层到底把什么参数交给了 manager 和 CDP」以及「返回值结构」（严格的 schema
 * 校验在 `tool-schema.test.mjs` 里独立做一遍）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PageHandle } from '../lib/page.mjs';
import { SLIM_TOOL_NAMES, TOOL_NAMES, buildTools } from '../lib/tools.mjs';

/** 1x1 透明 PNG。 */
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 完整配置（等价的 resolveOptions 结果）。 */
const FULL_CONFIG = Object.freeze({
  scheme: 'auto-connect',
  browserUrl: 'http://127.0.0.1:9222',
  wsEndpoint: '',
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
});

/** 默认方案探测结果（注入 deps.schemes，避免触发真实探测）。 */
const DEFAULT_SCHEMES = [
  { id: 'launch', label: '方案 A：启动全新浏览器', available: true, detail: 'Chrome 已安装', isCurrent: false },
  { id: 'auto-connect', label: '方案 B：复用当前浏览器（autoConnect）', available: true, detail: 'DevToolsActivePort 存在', isCurrent: true },
  { id: 'browser-url', label: '方案 C：连接调试端口（browser-url）', available: false, detail: '端口未监听', isCurrent: false },
  { id: 'ws-endpoint', label: '方案 D：WebSocket 直连（wsEndpoint）', available: false, detail: '未配置', isCurrent: false },
];

/** 建一个假 session（与 page.test 同构，按标记返回结构化结果）。 */
function createFakeSession(options = {}) {
  const calls = [];
  const listeners = new Map();
  const session = {
    targetId: options.targetId ?? 'PAGE-1',
    sessionId: 'SESSION-1',
    calls,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (typeof options.onSend === 'function') {
        const custom = options.onSend(method, params);
        if (custom !== undefined) return custom;
      }
      return fakeResponse(method, params);
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    async waitFor() {
      return {};
    },
    detach() {},
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
  return session;
}

/** 按表达式标记返回默认结果（标记与 lib/page.mjs 的 EXPRESSION_MARKS 一致）。 */
function fakeResponse(method, params = {}) {
  if (method === 'Runtime.evaluate') {
    const expression = typeof params.expression === 'string' ? params.expression : '';
    if (expression.includes('dsh-cdp:locate')) {
      return { result: { type: 'object', value: { found: true, visible: true, error: '', x: 50, y: 60, width: 100, height: 20, tag: 'button' } } };
    }
    if (expression.includes('dsh-cdp:page-info')) {
      return { result: { type: 'object', value: { url: 'https://example.test/page', title: 'Example Page' } } };
    }
    if (expression.includes('dsh-cdp:fill')) return { result: { type: 'object', value: { ok: true, error: '', value: 'filled' } } };
    if (expression.includes('dsh-cdp:focus')) return { result: { type: 'object', value: { ok: true, error: '' } } };
    if (expression.includes('dsh-cdp:snapshot')) {
      return {
        result: {
          type: 'object',
          value: {
            url: 'https://example.test/',
            title: 'Example',
            items: [{ tag: 'button', type: 'submit', text: 'Go', path: '#go' }],
            text: 'hello world',
          },
        },
      };
    }
    if (expression.includes('dsh-cdp:wait-selector')) return { result: { type: 'object', value: { found: true, error: '' } } };
    if (expression.includes('dsh-cdp:wait-text')) return { result: { type: 'object', value: { found: true, error: '' } } };
    if (expression.includes('dsh-cdp:element-object')) return { result: { type: 'object', objectId: 'OBJ-1' } };
    return { result: { type: 'number', value: 42 } };
  }
  if (method === 'Page.captureScreenshot') return { data: ONE_PIXEL_PNG_BASE64 };
  if (method === 'Page.getLayoutMetrics') {
    return { cssContentSize: { width: 1280, height: 2400 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
  }
  if (method === 'Page.navigate') return { frameId: 'FRAME-1', loaderId: 'LOADER-1' };
  if (method === 'Page.handleJavaScriptDialog') return {};
  return {};
}

/**
 * 建一套假依赖。
 *
 * @param {{ config?: object, connected?: boolean, session?: object, schemes?: object, closedOwnedBrowser?: boolean }} [options]
 *   覆盖项。
 * @returns {object} `{ deps, manager, browser, session, config, targets }`。
 */
function createHarness(options = {}) {
  const session = createFakeSession(options.session);
  const targets = [
    { targetId: 'PAGE-1', type: 'page', url: 'https://example.test/', title: 'Example', attached: true },
    { targetId: 'PAGE-2', type: 'page', url: 'https://example.test/two', title: 'Two', attached: true },
  ];
  const calls = { createTarget: [], closeTarget: [], attach: [] };
  const browser = {
    version: { browser: 'Chrome/155.0.0', protocolVersion: '1.3', userAgent: 'fake' },
    async listTargets() {
      return targets.map((target) => ({ ...target }));
    },
    async createTarget(url) {
      calls.createTarget.push(url);
      targets.push({ targetId: 'PAGE-NEW', type: 'page', url, title: '', attached: true });
      return { targetId: 'PAGE-NEW' };
    },
    async closeTarget(targetId) {
      calls.closeTarget.push(targetId);
      const index = targets.findIndex((target) => target.targetId === targetId);
      if (index >= 0) targets.splice(index, 1);
    },
    async attach(targetId) {
      calls.attach.push(targetId);
      if (!targets.some((target) => target.targetId === targetId)) {
        const error = new Error(`no target ${targetId}`);
        error.code = 'TARGET_NOT_FOUND';
        throw error;
      }
      return session;
    },
    async detach() {},
    async close() {},
  };
  const state = { connected: options.connected !== false };
  const manager = {
    status() {
      return {
        connected: state.connected,
        scheme: 'launch',
        wsUrl: 'ws://user:secret@127.0.0.1:9222/devtools/browser/x',
        browserVersion: state.connected ? 'Chrome/155.0.0' : '',
        launchedPid: 4321,
        launchedUserDataDir: 'C:\\temp\\profile',
        lastError: state.connected ? '' : 'not connected',
        pageCount: targets.length,
      };
    },
    async connect(connectOptions = {}) {
      state.connected = true;
      return {
        scheme: connectOptions.scheme ?? 'launch',
        wsUrl: 'ws://user:secret@127.0.0.1:9222/devtools/browser/x',
        browserVersion: 'Chrome/155.0.0',
        reused: false,
        launchedPid: 4321,
      };
    },
    async disconnect() {
      state.connected = false;
      return { closedOwnedBrowser: options.closedOwnedBrowser === true };
    },
    async browser() {
      return browser;
    },
    async activePage() {
      return { session, page: new PageHandle(session, 'PAGE-1') };
    },
    async dispose() {},
  };
  const config = { ...FULL_CONFIG, ...(options.config ?? {}) };
  const deps = {
    manager,
    getConfig: () => config,
    logger: undefined,
    schemes: options.schemes ?? { probeAllSchemes: async () => DEFAULT_SCHEMES.map((scheme) => ({ ...scheme })) },
  };
  return { deps, manager, browser, session, config, targets, calls, state };
}

/** 各工具的冒烟参数（全部合法）。 */
function smokeArgs(uploadFile) {
  return {
    browser_status: {},
    browser_connect: { scheme: 'launch' },
    browser_disconnect: { closeBrowser: false },
    browser_navigate: { url: 'https://target.test/landing' },
    browser_list_pages: {},
    browser_select_page: { pageId: 'PAGE-2' },
    browser_close_page: { pageId: 'PAGE-2' },
    browser_screenshot: {},
    browser_snapshot: {},
    browser_console: {},
    browser_network: {},
    browser_click: { selector: 'button.submit' },
    browser_fill: { selector: '#email', value: 'user@example.test' },
    browser_type: { text: 'abc', selector: '#q' },
    browser_press_key: { key: 'Enter' },
    browser_hover: { selector: 'nav a' },
    browser_wait_for: { selector: '#done' },
    browser_handle_dialog: { accept: true },
    browser_upload_file: { selector: 'input[type=file]', files: [uploadFile] },
    browser_drag: { fromSelector: '#from', toSelector: '#to' },
    browser_evaluate: { expression: '1 + 1' },
    browser_ping: {},
  };
}

test('buildTools：22 个工具名与顺序精确等于契约 §5.2', () => {
  const harness = createHarness();
  const tools = buildTools(harness.deps);
  assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES]);
  assert.equal(tools.length, 22);
  assert.equal(new Set(TOOL_NAMES).size, 22, '工具名不能重复');
});

test('buildTools：toolset=slim 只返回 5 个 ★ 工具', () => {
  const harness = createHarness({ config: { toolset: 'slim' } });
  const tools = buildTools(harness.deps);
  assert.deepEqual(tools.map((tool) => tool.name), [...SLIM_TOOL_NAMES]);
  assert.deepEqual(tools.map((tool) => tool.name), ['browser_status', 'browser_connect', 'browser_navigate', 'browser_screenshot', 'browser_ping']);
});

test('buildTools：缺少 deps.manager 抛 TypeError；缺少 getConfig 也能构建', () => {
  assert.throws(() => buildTools({}), TypeError);
  assert.throws(() => buildTools(), TypeError);
  const harness = createHarness();
  const tools = buildTools({ manager: harness.manager });
  assert.equal(tools.length, 22, '缺 getConfig 时用默认配置构建');
});

test('每个工具都声明了英文 description / parameters / output.schema / render / presentCall', () => {
  const harness = createHarness();
  for (const tool of buildTools(harness.deps)) {
    assert.ok(tool.description.length > 20, `${tool.name}: description 太短`);
    assert.match(tool.description, /[A-Za-z]{5}/u, `${tool.name}: description 应为英文`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(tool.output.schema.additionalProperties, false);
    assert.ok(Object.hasOwn(tool.output.schema.properties, 'summary'), `${tool.name}: 必须有 summary 字段`);
    assert.ok((tool.output.schema.required ?? []).includes('summary'), `${tool.name}: summary 必须在 required 里`);
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.presentCall, 'function');
    const present = tool.presentCall({});
    assert.equal(present.card, 'generic');
    assert.equal(present.kind, 'read');
    assert.ok(present.title.length > 0);
  }
});

test('每个工具 execute 都能用假 manager 跑通：返回值含 summary 且 render 返回 text 块', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-smoke-'));
  try {
    const uploadFile = path.join(directory, 'upload.txt');
    writeFileSync(uploadFile, 'hello', 'utf8');
    const harness = createHarness({ config: { screenshotDir: directory } });
    const tools = buildTools(harness.deps);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const args = smokeArgs(uploadFile);
    for (const name of TOOL_NAMES) {
      await t.test(name, async () => {
        const tool = byName.get(name);
        assert.ok(tool !== undefined, `${name} 未注册`);
        const value = await tool.execute(args[name], {});
        assert.equal(typeof value.summary, 'string', `${name}: 返回值必须有 summary`);
        assert.ok(value.summary.length > 0, `${name}: summary 不能为空`);
        // 返回值必须是干净 JSON（render 与 dsh 的 lossless 校验都依赖这一点）
        assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${name}: 返回值必须是 lossless JSON`);
        // render 必须吃掉自己 execute 的返回值
        const rendered = tool.output.render(args[name], value);
        assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name}: render 必须返回非空数组`);
        for (const block of rendered) {
          assert.equal(block.type, 'text', `${name}: render 只能返回 text 块`);
          assert.equal(typeof block.text, 'string');
        }
        assert.ok(rendered.some((block) => block.text.length > 0), `${name}: render 文本不能全空`);
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('browser_status：状态、方案探测、config 脱敏', async () => {
  const harness = createHarness();
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_status');
  const value = await tool.execute({}, {});
  assert.equal(value.connected, true);
  assert.equal(value.scheme, 'launch');
  assert.ok(value.schemeLabel.includes('方案'));
  assert.equal(value.wsUrl, 'ws://user:***@127.0.0.1:9222/devtools/browser/x', 'status 的 wsUrl 必须脱敏');
  assert.equal(value.browserVersion, 'Chrome/155.0.0');
  assert.equal(value.launchedPid, 4321);
  assert.equal(value.pageCount, 2);
  assert.equal(value.availableSchemes.length, 4);
  assert.equal(value.availableSchemes[1].available, true);
  assert.equal(value.availableSchemes[1].isCurrent, true);
  assert.equal(value.config.scheme, 'auto-connect');
  assert.equal(value.config.toolset, 'full');
  assert.equal(value.config.wsEndpoint, '');
  assert.match(value.summary, /已连接/u);

  // 未连接：返回数据而不是抛错
  const offline = createHarness({ connected: false });
  const offlineTool = buildTools(offline.deps).find((entry) => entry.name === 'browser_status');
  const offlineValue = await offlineTool.execute({}, {});
  assert.equal(offlineValue.connected, false);
  assert.equal(offlineValue.lastError, 'not connected');
  assert.match(offlineValue.summary, /未连接/u);
});

test('browser_status：注入 schemes 抛错时降级，不整体失败', async () => {
  const harness = createHarness({
    schemes: {
      probeAllSchemes: async () => {
        throw new Error('probe exploded');
      },
    },
  });
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_status');
  const value = await tool.execute({}, {});
  assert.equal(value.availableSchemes.length, 4);
  for (const scheme of value.availableSchemes) {
    assert.equal(typeof scheme.id, 'string');
    assert.ok(scheme.id !== '');
    assert.equal(typeof scheme.label, 'string');
    assert.equal(typeof scheme.available, 'boolean');
    assert.equal(typeof scheme.detail, 'string');
    assert.equal(typeof scheme.isCurrent, 'boolean');
  }
  assert.match(value.summary, /方案/u, '探测失败不影响状态与摘要');
});

test('browser_connect / browser_disconnect', async () => {
  const harness = createHarness();
  const tools = buildTools(harness.deps);
  const connect = await tools.find((entry) => entry.name === 'browser_connect').execute({ scheme: 'browser-url' }, {});
  assert.equal(connect.connected, true);
  assert.equal(connect.scheme, 'browser-url');
  assert.equal(connect.reused, false);
  assert.equal(connect.wsUrl, 'ws://user:***@127.0.0.1:9222/devtools/browser/x');
  assert.equal(connect.launchedPid, 4321);

  const invalid = await tools.find((entry) => entry.name === 'browser_connect').execute({ scheme: 'browser-url' }, {});
  assert.equal(invalid.connected, true);

  await assert.rejects(
    () => tools.find((entry) => entry.name === 'browser_connect').execute({ scheme: 'nope' }, {}),
    (error) => error.code === 'INVALID_ARGUMENT',
  );

  const disconnect = await tools.find((entry) => entry.name === 'browser_disconnect').execute({}, {});
  assert.equal(disconnect.disconnected, true);
  assert.equal(disconnect.closedOwnedBrowser, false);
});

test('browser_disconnect：closeBrowser=true 且 manager 报告关闭了自有浏览器', async () => {
  const harness = createHarness({ closedOwnedBrowser: true });
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_disconnect');
  const value = await tool.execute({ closeBrowser: true }, {});
  assert.equal(value.closedOwnedBrowser, true);
  assert.match(value.summary, /关闭/u);
});

test('browser_navigate：当前页导航；newTab 走 createTarget + attach', async () => {
  const harness = createHarness();
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_navigate');
  const value = await tool.execute({ url: 'https://target.test/landing' }, {});
  assert.equal(value.isNewTab, false);
  assert.equal(value.url, 'https://example.test/page');
  assert.equal(value.title, 'Example Page');
  const navigates = harness.session.calls.filter((call) => call.method === 'Page.navigate');
  assert.equal(navigates[0].params.url, 'https://target.test/landing');

  const newTab = await tool.execute({ url: 'https://target.test/new', newTab: true }, {});
  assert.equal(newTab.isNewTab, true);
  assert.equal(newTab.pageId, 'PAGE-NEW');
  assert.deepEqual(harness.calls.createTarget, ['about:blank']);
  assert.ok(harness.calls.attach.includes('PAGE-NEW'));

  await assert.rejects(
    () => tool.execute({ url: '' }, {}),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('browser_list_pages / browser_select_page / browser_close_page', async () => {
  const harness = createHarness();
  const tools = buildTools(harness.deps);
  const list = await tools.find((entry) => entry.name === 'browser_list_pages').execute({}, {});
  assert.equal(list.count, 2);
  assert.deepEqual(list.pages.map((page) => page.id), ['PAGE-1', 'PAGE-2']);
  assert.equal(list.pages[0].active, true);
  assert.equal(list.pages[1].active, false);

  const select = await tools.find((entry) => entry.name === 'browser_select_page').execute({ pageId: 'PAGE-2' }, {});
  assert.equal(select.pageId, 'PAGE-2');
  assert.equal(select.url, 'https://example.test/two');
  assert.equal(select.title, 'Two');
  const listedAgain = await tools.find((entry) => entry.name === 'browser_list_pages').execute({}, {});
  assert.equal(listedAgain.pages[1].active, true, 'select 之后当前页应变成 PAGE-2');

  await assert.rejects(
    () => tools.find((entry) => entry.name === 'browser_select_page').execute({ pageId: 'MISSING' }, {}),
    (error) => error.code === 'TARGET_NOT_FOUND',
  );

  const closed = await tools.find((entry) => entry.name === 'browser_close_page').execute({ pageId: 'PAGE-2' }, {});
  assert.equal(closed.closedPageId, 'PAGE-2');
  assert.equal(closed.remaining, 1);
  assert.deepEqual(harness.calls.closeTarget, ['PAGE-2']);
});

test('browser_screenshot：落盘到 config.screenshotDir，返回 path/bytes/mounted', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-shot-'));
  try {
    const harness = createHarness({ config: { screenshotDir: directory } });
    const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_screenshot');
    const value = await tool.execute({}, {});
    assert.equal(value.format, 'png');
    assert.equal(value.mounted, true);
    assert.ok(value.bytes > 0);
    assert.equal(path.dirname(value.path), path.resolve(directory));
    assert.equal(existsSync(value.path), true);
    assert.match(value.note, /path/u);
    // fullPage + jpeg 参数透传
    const jpeg = await tool.execute({ format: 'jpeg', fullPage: true }, {});
    assert.equal(jpeg.format, 'jpeg');
    const params = harness.session.calls.filter((call) => call.method === 'Page.captureScreenshot').at(-1).params;
    assert.equal(params.format, 'jpeg');
    assert.equal(params.captureBeyondViewport, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('browser_snapshot：text 含元素清单与 CSS path，输出 pageUrl/title', async () => {
  const harness = createHarness();
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_snapshot');
  const value = await tool.execute({}, {});
  assert.equal(value.pageUrl, 'https://example.test/');
  assert.equal(value.title, 'Example');
  assert.equal(value.truncated, false);
  assert.ok(value.text.includes('- button[submit] "Go" => #go'));
  assert.ok(value.text.includes('hello world'));
  assert.ok(value.text.includes('可交互元素：1'));
});

test('browser_console / browser_network：采集启动后能读到事件', async () => {
  const harness = createHarness();
  const tools = buildTools(harness.deps);
  const consoleTool = tools.find((entry) => entry.name === 'browser_console');
  const empty = await consoleTool.execute({}, {});
  assert.equal(empty.count, 0);
  harness.session.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] });
  const messages = await consoleTool.execute({ limit: 10 }, {});
  assert.equal(messages.count, 1);
  assert.deepEqual(messages.messages[0], { type: 'error', text: 'boom', url: '', line: 0 });
  const filtered = await consoleTool.execute({ types: ['log'] }, {});
  assert.equal(filtered.count, 0, 'types 过滤应生效');

  const networkTool = tools.find((entry) => entry.name === 'browser_network');
  await networkTool.execute({}, {});
  harness.session.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    type: 'Document',
    request: { url: 'https://example.test/', method: 'GET' },
  });
  harness.session.emit('Network.responseReceived', { requestId: 'R1', response: { status: 200, mimeType: 'text/html' } });
  const network = await networkTool.execute({}, {});
  assert.equal(network.count, 1);
  assert.deepEqual(network.requests[0], {
    url: 'https://example.test/',
    method: 'GET',
    status: 200,
    resourceType: 'Document',
    mimeType: 'text/html',
    failed: false,
    errorText: '',
  });
});

test('browser_click：返回 ok/selector/deltaUrl，点击前后 URL 相同时 deltaUrl 为空', async () => {
  const harness = createHarness();
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_click');
  const value = await tool.execute({ selector: 'button.submit' }, {});
  assert.equal(value.ok, true);
  assert.equal(value.selector, 'button.submit');
  assert.equal(value.deltaUrl, '');
  assert.equal(value.deltaTitle, '');
  const mouse = harness.session.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouse.map((call) => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(mouse[1].params.x, 50);

  await assert.rejects(
    () => tool.execute({ selector: '  ' }, {}),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('browser_fill：单字段、fields 批量、部分失败', async () => {
  const harness = createHarness();
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_fill');
  const single = await tool.execute({ selector: '#email', value: 'user@example.test' }, {});
  assert.equal(single.filled, 1);
  assert.equal(single.failed, 0);
  assert.deepEqual(single.results, [{ selector: '#email', ok: true, error: '' }]);

  const batch = await tool.execute(
    { fields: [{ selector: '#email', value: 'a@b.c' }, { selector: '#password', value: 'secret' }] },
    {},
  );
  assert.equal(batch.filled, 2);
  assert.equal(batch.failed, 0);

  // fields 优先于 selector/value
  const precedence = await tool.execute({ selector: '#ignored', value: 'x', fields: [{ selector: '#only', value: 'y' }] }, {});
  assert.deepEqual(precedence.results.map((result) => result.selector), ['#only']);

  // 一个字段失败不影响另一个
  const partial = createHarness({
    session: {
      onSend: (method, params) => {
        if (method !== 'Runtime.evaluate' || typeof params.expression !== 'string') return undefined;
        if (params.expression.includes('dsh-cdp:fill') && params.expression.includes('"#bad"')) {
          return { result: { type: 'object', value: { ok: false, error: 'element is not fillable' } } };
        }
        return undefined;
      },
    },
  });
  const partialTool = buildTools(partial.deps).find((entry) => entry.name === 'browser_fill');
  const mixed = await partialTool.execute({ fields: [{ selector: '#good', value: '1' }, { selector: '#bad', value: '2' }] }, {});
  assert.equal(mixed.filled, 1);
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.results[1].ok, false);
  assert.match(mixed.results[1].error, /not fillable/u);

  await assert.rejects(
    () => tool.execute({}, {}),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('browser_type / browser_press_key / browser_hover', async () => {
  const harness = createHarness();
  const tools = buildTools(harness.deps);
  const typed = await tools.find((entry) => entry.name === 'browser_type').execute({ text: 'abc', selector: '#q' }, {});
  assert.equal(typed.ok, true);
  assert.equal(typed.chars, 3);
  assert.equal(typed.selector, '#q');
  assert.equal(harness.session.calls.filter((call) => call.method === 'Input.insertText').length, 3);

  const pressed = await tools.find((entry) => entry.name === 'browser_press_key').execute({ key: 'Enter' }, {});
  assert.equal(pressed.ok, true);
  assert.equal(pressed.key, 'Enter');
  const keyEvents = harness.session.calls.filter((call) => call.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(keyEvents.map((call) => call.params.type), ['keyDown', 'keyUp']);
  assert.equal(keyEvents[0].params.windowsVirtualKeyCode, 13);

  const hovered = await tools.find((entry) => entry.name === 'browser_hover').execute({ selector: 'nav a' }, {});
  assert.equal(hovered.ok, true);
  assert.equal(hovered.selector, 'nav a');
});

test('browser_wait_for：匹配/超时都以数据返回', async () => {
  const harness = createHarness();
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_wait_for');
  const matched = await tool.execute({ selector: '#done' }, {});
  assert.equal(matched.matched, true);
  assert.ok(matched.waitedMs >= 0);

  const nothing = await tool.execute({}, {});
  assert.equal(nothing.matched, false);
  assert.ok(nothing.reason.includes('selector'));
});

test('browser_handle_dialog：接受/取消并回填 dialogType/dialogMessage', async () => {
  const harness = createHarness();
  const tool = buildTools(harness.deps).find((entry) => entry.name === 'browser_handle_dialog');
  // 先触发 dialog 事件（PageHandle 需要在采集/操作后挂上监听）
  await tool.execute({ accept: true }, {});
  const handled = await tool.execute({ accept: true }, {});
  assert.equal(handled.handled, true);

  // 无对话框（CDP 报错）时返回 handled=false 而不是抛错
  const failing = createHarness({
    session: {
      onSend: (method) =>
        method === 'Page.handleJavaScriptDialog'
          ? Promise.reject(Object.assign(new Error('No dialog is showing'), { code: 'CDP_ERROR' }))
          : undefined,
    },
  });
  const failingTool = buildTools(failing.deps).find((entry) => entry.name === 'browser_handle_dialog');
  const failed = await failingTool.execute({ accept: false }, {});
  assert.equal(failed.handled, false);
  assert.match(failed.note, /No dialog/u);
});

test('browser_upload_file / browser_drag / browser_evaluate / browser_ping', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-upload-'));
  try {
    const uploadFile = path.join(directory, 'resume.txt');
    writeFileSync(uploadFile, 'hello', 'utf8');
    const harness = createHarness();
    const tools = buildTools(harness.deps);

    const uploaded = await tools.find((entry) => entry.name === 'browser_upload_file').execute(
      { selector: 'input[type=file]', files: [uploadFile] },
      {},
    );
    assert.equal(uploaded.ok, true);
    assert.deepEqual(uploaded.files, [uploadFile]);
    const setFiles = harness.session.calls.filter((call) => call.method === 'DOM.setFileInputFiles');
    assert.deepEqual(setFiles[0].params.files, [path.resolve(uploadFile)]);

    const dragged = await tools.find((entry) => entry.name === 'browser_drag').execute({ fromSelector: '#a', toSelector: '#b' }, {});
    assert.equal(dragged.ok, true);
    assert.equal(dragged.fromSelector, '#a');
    assert.equal(dragged.toSelector, '#b');

    const evaluated = await tools.find((entry) => entry.name === 'browser_evaluate').execute({ expression: '1 + 1' }, {});
    assert.equal(evaluated.ok, true);
    assert.equal(evaluated.result, '42');
    assert.equal(evaluated.resultType, 'number');
    assert.equal(evaluated.exception, '');

    await assert.rejects(
      () => tools.find((entry) => entry.name === 'browser_evaluate').execute({ expression: '' }, {}),
      (error) => error.code === 'INVALID_ARGUMENT',
    );

    const ping = await tools.find((entry) => entry.name === 'browser_ping').execute({}, {});
    assert.equal(ping.ok, true);
    assert.ok(ping.latencyMs >= 0);
    assert.match(ping.note, /Chrome/u);

    // ping 失败时不抛错
    const offline = createHarness();
    offline.manager.browser = async () => {
      throw Object.assign(new Error('no connection'), { code: 'NOT_CONNECTED' });
    };
    const offlinePing = await buildTools(offline.deps).find((entry) => entry.name === 'browser_ping').execute({}, {});
    assert.equal(offlinePing.ok, false);
    assert.match(offlinePing.note, /no connection/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('工具层不读全局状态：两次 buildTools 得到独立定义，互不影响', () => {
  const first = createHarness();
  const second = createHarness({ config: { toolset: 'slim' } });
  const firstTools = buildTools(first.deps);
  const secondTools = buildTools(second.deps);
  assert.equal(firstTools.length, 22);
  assert.equal(secondTools.length, 5);
  assert.notEqual(firstTools[0], secondTools[0]);
});

test('优先使用 manager 的扩展页面 API（pageFor/listPages/selectPage/closePage/newPage/labelOf）', async () => {
  const harness = createHarness();
  const sharedPages = new Map();
  const calls = { pageFor: [], listPages: 0, selectPage: [], closePage: [], newPage: [] };
  /** 与 T1 BrowserManager 同形：同一 target 复用同一个 PageHandle。 */
  const pageFor = async (pageId) => {
    const id = pageId === undefined || pageId === '' ? 'PAGE-1' : String(pageId);
    calls.pageFor.push(id);
    let page = sharedPages.get(id);
    if (page === undefined) {
      page = new PageHandle(harness.session, id);
      sharedPages.set(id, page);
    }
    return { session: harness.session, page, targetId: id };
  };
  const richManager = {
    ...harness.manager,
    labelOf: (scheme) => `权威标签：${scheme}`,
    pageFor,
    async listPages() {
      calls.listPages += 1;
      return [
        { pageId: 'PAGE-1', targetId: 'PAGE-1', url: 'https://example.test/', title: 'Example', active: true },
        { pageId: 'PAGE-2', targetId: 'PAGE-2', url: 'https://example.test/two', title: 'Two', active: false },
      ];
    },
    async selectPage(pageId) {
      calls.selectPage.push(pageId);
      return { pageId, url: 'https://example.test/two', title: 'Two' };
    },
    async closePage(pageId) {
      calls.closePage.push(pageId === undefined ? '<default>' : pageId);
      return { closedPageId: pageId ?? 'PAGE-1', remaining: 1 };
    },
    async newPage(url) {
      calls.newPage.push(url);
      return { pageId: 'PAGE-NEW', url, title: '' };
    },
  };
  const tools = buildTools({ ...harness.deps, manager: richManager });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // browser_status 的方案标签优先用 manager.labelOf
  const status = await byName.get('browser_status').execute({}, {});
  assert.equal(status.schemeLabel, '权威标签：launch');

  // browser_click：不带 pageId → pageFor(undefined 语义的激活页)
  await byName.get('browser_click').execute({ selector: 'button' }, {});
  assert.deepEqual(calls.pageFor, ['PAGE-1']);

  // 同一 target 只有一个 PageHandle：控制台缓冲跨工具调用连续
  const consoleTool = byName.get('browser_console');
  await consoleTool.execute({}, {});
  harness.session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hi' }] });
  const messages = await consoleTool.execute({}, {});
  assert.equal(messages.count, 1, '共享 PageHandle 才能跨调用读到控制台缓冲');

  // browser_list_pages 走 manager.listPages（active 标记由 manager 决定）
  const list = await byName.get('browser_list_pages').execute({}, {});
  assert.equal(calls.listPages, 1);
  assert.deepEqual(list.pages.map((page) => [page.id, page.active]), [['PAGE-1', true], ['PAGE-2', false]]);

  // browser_select_page 走 manager.selectPage
  const selected = await byName.get('browser_select_page').execute({ pageId: 'PAGE-2' }, {});
  assert.deepEqual(calls.selectPage, ['PAGE-2']);
  assert.equal(selected.pageId, 'PAGE-2');
  assert.equal(selected.title, 'Two');

  // browser_navigate newTab 走 manager.newPage，再通过 pageFor 取新页句柄
  const navigated = await byName.get('browser_navigate').execute({ url: 'https://target.test/new', newTab: true }, {});
  assert.deepEqual(calls.newPage, ['about:blank']);
  assert.equal(navigated.pageId, 'PAGE-NEW');
  assert.ok(calls.pageFor.includes('PAGE-NEW'), 'newPage 之后应通过 pageFor 取新页句柄');

  // browser_close_page 走 manager.closePage
  const closed = await byName.get('browser_close_page').execute({ pageId: 'PAGE-2' }, {});
  assert.deepEqual(calls.closePage, ['PAGE-2']);
  assert.equal(closed.closedPageId, 'PAGE-2');
  assert.equal(closed.remaining, 1);

  // selectPage 抛 TARGET_NOT_FOUND 时错误原样上抛（不吞）
  const failing = buildTools({
    ...harness.deps,
    manager: {
      ...richManager,
      async selectPage() {
        throw Object.assign(new Error('no such page'), { code: 'TARGET_NOT_FOUND' });
      },
    },
  });
  await assert.rejects(
    () => failing.find((tool) => tool.name === 'browser_select_page').execute({ pageId: 'GHOST' }, {}),
    (error) => error.code === 'TARGET_NOT_FOUND',
  );
});
