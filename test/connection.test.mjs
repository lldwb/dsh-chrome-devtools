// lib/connection.mjs 的离线单测。
//
// 用**注入的 fake 依赖**（plan / launch / stop / openBrowser / createPage）替掉真实
// Chrome 与真实 CDP，验证生命周期逻辑：懒连接、方案切换、auto-connect 回落 launch、
// 只关闭自有 Chrome、dispose 清理、页面缓存与激活页选择。
import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserError } from '../lib/errors.mjs';
import { BrowserManager } from '../lib/connection.mjs';

/** fake TargetSession。 */
class FakeSession {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.detached = false;
    this.sent = [];
  }

  async send(method, params) {
    this.sent.push({ method, params });
    return {};
  }

  on() {
    return () => {};
  }

  async detach() {
    this.detached = true;
    this.browser.sessions.delete(this.targetId);
  }
}

/** fake CdpBrowser：页面列表、session、关闭/断开回调。 */
class FakeBrowser {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.version = { browser: 'Chrome/Fake-1.0', protocolVersion: '1.3', userAgent: 'FakeUA' };
    this.closed = false;
    this.closeCalls = 0;
    /** @type {Array<{ targetId: string, type: string, url: string, title: string, attached: boolean }>} */
    this.targets = [];
    this.sessions = new Map();
    this.closeListeners = new Set();
    this.nextId = 1;
  }

  /** 加一个页面 target，返回 targetId。 */
  addPage(url = 'about:blank') {
    const targetId = `target-${this.nextId}`;
    this.nextId += 1;
    this.targets.push({ targetId, type: 'page', url, title: `title-${targetId}`, attached: false });
    return targetId;
  }

  async listTargets() {
    if (this.closed) throw new Error('fake browser closed');
    return this.targets.map((target) => ({ ...target }));
  }

  async createTarget(url) {
    if (this.closed) throw new Error('fake browser closed');
    return { targetId: this.addPage(url) };
  }

  async closeTarget(targetId) {
    this.targets = this.targets.filter((target) => target.targetId !== targetId);
    this.sessions.delete(targetId);
  }

  async attach(targetId) {
    const session = new FakeSession(this, targetId, `session-${targetId}`);
    this.sessions.set(targetId, session);
    return session;
  }

  async detach(targetId) {
    const session = this.sessions.get(targetId);
    if (session !== undefined) session.detached = true;
    this.sessions.delete(targetId);
  }

  onClose(listener) {
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls += 1;
    this.#notifyClose();
  }

  /** 模拟服务端断开（进程还在，但 CDP 连接断了）。 */
  simulateDrop() {
    this.closed = true;
    this.#notifyClose();
  }

  #notifyClose() {
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch {
        // 忽略。
      }
    }
    this.closeListeners.clear();
  }
}

/** 一个默认的 launch 计划。 */
function launchPlan(overrides = {}) {
  return {
    kind: 'launch',
    scheme: 'launch',
    executablePath: undefined,
    channel: 'stable',
    headless: false,
    isolated: true,
    userDataDir: undefined,
    viewport: '1280x800',
    timeoutMs: 15000,
    ...overrides,
  };
}

/**
 * 建一套 manager + fake deps。
 *
 * @param {object} [config] - 配置快照（默认 scheme=launch）。
 */
function createHarness(config = {}) {
  const state = {
    config: { scheme: 'launch', ...config },
    launchCalls: 0,
    launchOptions: [],
    stops: [],
    opens: [],
    planCalls: [],
    createdPages: [],
    disposedPages: 0,
    browsers: [],
    /** @type {Function | undefined} */
    planImpl: undefined,
    /** @type {Function | undefined} */
    launchImpl: undefined,
    /** @type {Function | undefined} */
    openImpl: undefined,
  };
  const deps = {
    async plan(scheme, resolvedConfig) {
      state.planCalls.push({ scheme, config: resolvedConfig });
      if (typeof state.planImpl === 'function') return state.planImpl(scheme, resolvedConfig);
      if (scheme === 'launch') return launchPlan();
      if (scheme === 'auto-connect') return { kind: 'invalid', reason: '测试里没有可复用的 Chrome' };
      if (scheme === 'browser-url') return { kind: 'ws', scheme, wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake', source: 'browser-url' };
      return { kind: 'ws', scheme, wsUrl: resolvedConfig.wsEndpoint, source: 'ws-endpoint' };
    },
    async launch(options) {
      state.launchCalls += 1;
      state.launchOptions.push(options);
      if (typeof state.launchImpl === 'function') return state.launchImpl(options);
      return {
        pid: 1000 + state.launchCalls,
        wsUrl: `ws://127.0.0.1:${9000 + state.launchCalls}/devtools/browser/fake`,
        userDataDir: `/tmp/fake-profile-${state.launchCalls}`,
        isolated: true,
        owned: true,
      };
    },
    async stop(pid) {
      state.stops.push(pid);
    },
    async openBrowser(wsUrl, options) {
      state.opens.push({ wsUrl, options });
      if (typeof state.openImpl === 'function') return state.openImpl(wsUrl, options);
      const browser = new FakeBrowser(wsUrl);
      browser.addPage('about:blank');
      state.browsers.push(browser);
      return browser;
    },
    createPage(session, targetId) {
      const page = {
        targetId,
        session,
        disposed: false,
        async url() {
          return 'about:blank';
        },
        async title() {
          return 'blank';
        },
        dispose() {
          this.disposed = true;
          state.disposedPages += 1;
        },
      };
      state.createdPages.push(page);
      return page;
    },
  };
  const logger = { info() {}, warn() {}, debug() {} };
  const manager = new BrowserManager(() => state.config, logger, deps);
  return { manager, state, deps };
}

/** 造一个 BrowserError 便捷函数。 */
function browserError(code, message, details = {}) {
  return new BrowserError(code, message, details);
}

test('constructor：getConfig 必须是函数', () => {
  assert.throws(
    () => new BrowserManager(undefined),
    (error) => error instanceof BrowserError && error.code === 'INVALID_ARGUMENT',
  );
  assert.throws(() => new BrowserManager('nope'), (error) => error.code === 'INVALID_ARGUMENT');
});

test('status()：未连接时用配置方案、launchedPid 为 0、lastError 为空', () => {
  const { manager } = createHarness({ scheme: 'auto-connect' });
  const status = manager.status();
  assert.deepEqual(status, {
    connected: false,
    scheme: 'auto-connect',
    wsUrl: '',
    browserVersion: '',
    launchedPid: 0,
    launchedUserDataDir: '',
    lastError: '',
    pageCount: 0,
  });
});

test('status()：getConfig 抛错时用默认配置兜底', () => {
  let broken = true;
  const manager = new BrowserManager(() => {
    if (broken) throw new Error('config broken');
    return { scheme: 'launch' };
  });
  assert.equal(manager.status().scheme, 'auto-connect', '默认配置的 scheme 是 auto-connect');
  broken = false;
  assert.equal(manager.status().scheme, 'launch');
});

test('connect：launch 方案建立连接并记录 pid / 版本 / 页面数', async () => {
  const { manager, state } = createHarness();
  const result = await manager.connect();
  assert.equal(result.scheme, 'launch');
  assert.equal(result.reused, false);
  assert.equal(result.browserVersion, 'Chrome/Fake-1.0');
  assert.equal(result.launchedPid, 1001);
  assert.equal(result.note, '');
  assert.equal(state.launchCalls, 1);
  assert.deepEqual(state.opens[0].wsUrl, 'ws://127.0.0.1:9001/devtools/browser/fake');

  const status = manager.status();
  assert.equal(status.connected, true);
  assert.equal(status.scheme, 'launch');
  assert.equal(status.browserVersion, 'Chrome/Fake-1.0');
  assert.equal(status.launchedPid, 1001);
  assert.equal(status.launchedUserDataDir, '/tmp/fake-profile-1');
  assert.equal(status.pageCount, 1);
  assert.equal(status.lastError, '');
});

test('connect：同方案重复调用复用连接（不重复 launch）', async () => {
  const { manager, state } = createHarness();
  const first = await manager.connect();
  const second = await manager.connect();
  assert.equal(second.reused, true);
  assert.equal(second.scheme, first.scheme);
  assert.equal(second.launchedPid, first.launchedPid);
  assert.equal(state.launchCalls, 1);
});

test('connect：切换方案时先断开旧连接，并关掉自有 Chrome', async () => {
  const { manager, state } = createHarness();
  await manager.connect({ scheme: 'launch' });
  const oldBrowser = state.browsers[0];
  const result = await manager.connect({ scheme: 'browser-url' });
  assert.equal(result.scheme, 'browser-url');
  assert.equal(result.launchedPid, 0, '非 launch 方案不记录 pid');
  assert.equal(oldBrowser.closeCalls, 1, '旧 CDP 连接应被关闭');
  assert.deepEqual(state.stops, [1001], '自有 Chrome 应被关闭，避免孤儿进程');
  assert.equal(manager.status().launchedPid, 0);
});

test('connect：非法方案抛 SCHEME_UNKNOWN（空串视为未指定，回落配置值）', async () => {
  const { manager } = createHarness();
  for (const bad of ['nope', 'Launch', 'AUTO-CONNECT']) {
    await assert.rejects(
      () => manager.connect({ scheme: bad }),
      (error) => {
        assert.ok(error instanceof BrowserError);
        assert.equal(error.code, 'SCHEME_UNKNOWN', '契约错误码拼写是 SCHEME_UNKNOWN');
        return true;
      },
    );
  }
  // scheme: '' 是「未指定」，应使用配置里的方案，不报错。
  const result = await manager.connect({ scheme: '' });
  assert.equal(result.scheme, 'launch');
});

test('connect：auto-connect 不可用时回落到 launch，note 说明原因', async () => {
  const { manager, state } = createHarness({ scheme: 'auto-connect' });
  state.planImpl = async (scheme) => {
    if (scheme === 'auto-connect') return { kind: 'invalid', reason: '没有找到 DevToolsActivePort' };
    return launchPlan();
  };
  const result = await manager.connect();
  assert.equal(result.scheme, 'launch', '实际方案应为回落后的 launch');
  assert.match(result.note, /auto-connect 不可用/);
  assert.match(result.note, /DevToolsActivePort/);
  assert.equal(state.launchCalls, 1, '应真的执行了 launch');
  assert.equal(manager.status().connected, true);
});

test('connect：auto-connect 与回落 launch 都失败时抛 CONNECT_FAILED，附两段错误', async () => {
  const { manager, state } = createHarness({ scheme: 'auto-connect' });
  state.planImpl = async (scheme) => {
    if (scheme === 'auto-connect') return { kind: 'invalid', reason: '没有 DevToolsActivePort' };
    return launchPlan();
  };
  state.openImpl = async () => {
    throw browserError('CONNECT_FAILED', 'ws 握手失败');
  };
  await assert.rejects(
    () => manager.connect(),
    (error) => {
      assert.equal(error.code, 'CONNECT_FAILED');
      assert.match(error.message, /auto-connect 不可用/);
      assert.match(error.message, /launch 也失败/);
      assert.equal(error.details.autoConnectError.code, 'NO_DEBUG_ENDPOINT');
      assert.equal(error.details.launchError.code, 'CONNECT_FAILED');
      return true;
    },
  );
  assert.deepEqual(state.stops, [1001], 'launch 成功但连接失败时应关掉刚启动的 Chrome');
  assert.equal(manager.status().connected, false);
  assert.match(manager.status().lastError, /auto-connect/);
});

test('connect：launch 成功但 CDP 连接失败时清理进程与临时 profile', async () => {
  const { manager, state } = createHarness();
  state.openImpl = async () => {
    throw browserError('CONNECT_FAILED', 'ws 握手失败');
  };
  await assert.rejects(
    () => manager.connect({ scheme: 'launch' }),
    (error) => error.code === 'CONNECT_FAILED',
  );
  assert.deepEqual(state.stops, [1001]);
  assert.equal(manager.status().connected, false);
  assert.match(manager.status().lastError, /握手失败/);
});

test('disconnect：未连接时调用不抛，返回 closedOwnedBrowser=false', async () => {
  const { manager, state } = createHarness();
  const result = await manager.disconnect();
  assert.deepEqual(result, { closedOwnedBrowser: false });
  assert.deepEqual(state.stops, []);
});

test('disconnect：closeBrowser=false 只断连接不 kill 自有 Chrome', async () => {
  const { manager, state } = createHarness();
  await manager.connect({ scheme: 'launch' });
  const browser = state.browsers[0];
  const result = await manager.disconnect();
  assert.equal(result.closedOwnedBrowser, false);
  assert.equal(browser.closeCalls, 1);
  assert.deepEqual(state.stops, [], '默认不 kill，交给后续 dispose');
  const status = manager.status();
  assert.equal(status.connected, false);
  assert.equal(status.launchedPid, 0);
  // dispose 时应补清理（不留孤儿进程）。
  await manager.dispose();
  assert.deepEqual(state.stops, [1001]);
});

test('disconnect：closeBrowser=true 且是自有 Chrome 时 kill 它', async () => {
  const { manager, state } = createHarness();
  await manager.connect({ scheme: 'launch' });
  const result = await manager.disconnect({ closeBrowser: true });
  assert.deepEqual(result, { closedOwnedBrowser: true });
  assert.deepEqual(state.stops, [1001]);
});

test('disconnect：auto-connect 的连接永远不 kill 别人的浏览器', async () => {
  const { manager, state } = createHarness({ scheme: 'browser-url' });
  await manager.connect({ scheme: 'browser-url' });
  const browser = state.browsers[0];
  const result = await manager.disconnect({ closeBrowser: true });
  assert.deepEqual(result, { closedOwnedBrowser: false });
  assert.equal(browser.closeCalls, 1, 'CDP 连接要断');
  assert.deepEqual(state.stops, [], '绝不能 kill 别人的浏览器');
});

test('browser()：懒连接 + 复用', async () => {
  const { manager, state } = createHarness();
  const first = await manager.browser();
  assert.equal(state.launchCalls, 1);
  const second = await manager.browser();
  assert.equal(first, second, '已连接时应返回同一个 CdpBrowser');
  assert.equal(state.launchCalls, 1);
});

test('browser()：连接掉线后自动重连一次', async () => {
  const { manager, state } = createHarness();
  const first = await manager.browser();
  first.simulateDrop();
  const second = await manager.browser();
  assert.notEqual(second, first);
  assert.equal(state.launchCalls, 2, '掉线后应重连');
  assert.deepEqual(state.stops, [1001], '重连前应关掉旧的自有 Chrome');
  assert.equal(manager.status().connected, true);
});

test('browser()：并发调用只触发一次连接', async () => {
  const { manager, state } = createHarness();
  const results = await Promise.all([manager.browser(), manager.browser(), manager.browser()]);
  assert.equal(results.length, 3);
  assert.equal(state.launchCalls, 1, '并发懒连接应去重');
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});

test('activePage()：没有页面时新建 about:blank 并缓存 PageHandle', async () => {
  const { manager, state } = createHarness();
  state.openImpl = async (wsUrl) => {
    const browser = new FakeBrowser(wsUrl);
    state.browsers.push(browser);
    return browser; // 故意不给页面
  };
  const first = await manager.activePage();
  assert.match(first.targetId, /^target-/);
  assert.ok(first.session instanceof FakeSession);
  assert.equal(first.page.targetId, first.targetId);
  assert.equal(state.createdPages.length, 1);

  const second = await manager.activePage();
  assert.equal(second.session, first.session, '同一 target 应复用 session');
  assert.equal(second.page, first.page, '同一 target 应复用 PageHandle');
  assert.equal(state.createdPages.length, 1);
});

test('activePage()：有页面时选第一个作为激活页', async () => {
  const { manager } = createHarness();
  const { targetId } = await manager.activePage();
  assert.equal(targetId, 'target-1');
});

test('pageFor()：指定存在的 pageId；不存在抛 TARGET_NOT_FOUND', async () => {
  const { manager } = createHarness();
  const page = await manager.pageFor('target-1');
  assert.equal(page.targetId, 'target-1');

  await assert.rejects(
    () => manager.pageFor('target-missing'),
    (error) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, 'TARGET_NOT_FOUND');
      assert.equal(error.details.pageId, 'target-missing');
      return true;
    },
  );
});

test('listPages()：active 标记跟随当前激活页', async () => {
  const { manager } = createHarness();
  const browser = await manager.browser();
  const secondId = browser.addPage('https://example.test/b');
  const pages = await manager.listPages();
  assert.equal(pages.length, 2);
  assert.equal(pages[0].active, true, '未显式选择时第一个为激活页');
  assert.equal(pages[0].pageId, pages[0].targetId, 'pageId 就是 targetId');
  assert.equal(pages[1].active, false);

  await manager.selectPage(secondId);
  const afterSelect = await manager.listPages();
  assert.equal(afterSelect[0].active, false);
  assert.equal(afterSelect[1].active, true);
});

test('selectPage()：切换激活页并返回 url/title', async () => {
  const { manager } = createHarness();
  const browser = await manager.browser();
  const secondId = browser.addPage('https://example.test/b');
  const selected = await manager.selectPage(secondId);
  assert.deepEqual(selected, { pageId: secondId, url: 'about:blank', title: 'blank' });
  assert.equal(manager.activeTargetId, secondId);
});

test('newPage()：新建页面并设为激活页', async () => {
  const { manager } = createHarness();
  const created = await manager.newPage('https://example.test/new');
  assert.match(created.pageId, /^target-/);
  assert.equal(manager.activeTargetId, created.pageId);
  const pages = await manager.listPages();
  const active = pages.find((page) => page.active);
  assert.equal(active.pageId, created.pageId);
});

test('closePage()：关闭指定页 / 缺省关闭激活页，remaining 正确', async () => {
  const { manager, state } = createHarness();
  const browser = await manager.browser();
  browser.addPage('https://example.test/b');
  await manager.activePage(); // 激活 target-1
  const first = await manager.closePage();
  assert.equal(first.closedPageId, 'target-1');
  assert.equal(first.remaining, 1);
  assert.equal(state.disposedPages, 1, '关闭页面时应 dispose 缓存的 PageHandle');

  await manager.selectPage('target-2');
  const second = await manager.closePage('target-2');
  assert.equal(second.closedPageId, 'target-2');
  assert.equal(second.remaining, 0);
});

test('closePage()：没有页面时抛 TARGET_NOT_FOUND', async () => {
  const { manager, state } = createHarness();
  state.openImpl = async (wsUrl) => {
    const browser = new FakeBrowser(wsUrl);
    state.browsers.push(browser);
    return browser; // 无页面
  };
  await assert.rejects(
    () => manager.closePage(),
    (error) => error instanceof BrowserError && error.code === 'TARGET_NOT_FOUND',
  );
});

test('status()：wsUrl 脱敏，不泄漏 URL 里的凭据', async () => {
  const { manager, state } = createHarness({ scheme: 'ws-endpoint', wsEndpoint: 'ws://user:secret@127.0.0.1:9222/devtools/browser/x' });
  state.planImpl = async () => ({
    kind: 'ws',
    scheme: 'ws-endpoint',
    wsUrl: 'ws://user:secret@127.0.0.1:9222/devtools/browser/x',
    source: 'ws-endpoint',
  });
  await manager.connect({ scheme: 'ws-endpoint' });
  const status = manager.status();
  assert.ok(!status.wsUrl.includes('secret'), `status.wsUrl 不应含密码：${status.wsUrl}`);
  assert.ok(!JSON.stringify(status).includes('secret'));
});

test('lastError：连接失败记录，后续连接成功清空', async () => {
  const { manager, state } = createHarness();
  state.openImpl = async () => {
    throw browserError('CONNECT_FAILED', '第一连接失败');
  };
  await assert.rejects(() => manager.connect({ scheme: 'launch' }));
  assert.equal(manager.status().lastError, '第一连接失败');

  state.openImpl = undefined; // 恢复默认成功实现
  await manager.connect({ scheme: 'launch' });
  assert.equal(manager.status().lastError, '');
});

test('dispose()：幂等、断开连接、stop 自有 Chrome、dispose 所有 PageHandle', async () => {
  const { manager, state } = createHarness();
  await manager.activePage();
  const browser = state.browsers[0];
  await manager.dispose();
  assert.equal(browser.closeCalls, 1);
  assert.deepEqual(state.stops, [1001]);
  assert.equal(state.disposedPages, 1, 'dispose 应释放 PageHandle');
  await manager.dispose(); // 第二次不应有任何动作
  assert.equal(state.stops.length, 1);
  await assert.rejects(
    () => manager.browser(),
    (error) => error instanceof BrowserError && error.code === 'NOT_CONNECTED',
  );
});

test('dispose()：清理 disconnect(closeBrowser:false) 留下的自有 Chrome', async () => {
  const { manager, state } = createHarness();
  await manager.connect({ scheme: 'launch' });
  await manager.disconnect({ closeBrowser: false });
  assert.deepEqual(state.stops, []);
  await manager.dispose();
  assert.deepEqual(state.stops, [1001], 'dispose 必须补清理孤儿 Chrome');
});
