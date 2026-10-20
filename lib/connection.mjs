/**
 * 浏览器连接的生命周期中枢（`BrowserManager`）。
 *
 * 工具层（lib/tools.mjs）只通过它拿 `CdpBrowser` / `TargetSession` / `PageHandle`，
 * 设置页（lib/settings.mjs）只通过它做 status / probe / connect / disconnect。
 *
 * 关键约定：
 * - **懒连接**：第一次用 `browser()` / `activePage()` 时才建立连接；
 * - **切换方案先断开旧连接**（旧的 authed ws 不能复用）；
 * - **只 kill 自己启动的 Chrome**：`launch` 方案记录 pid；其它方案永不 kill 别人的浏览器；
 * - 日志与 status 里的 wsUrl 一律脱敏（`redactUrl`），不泄漏 URL 里的凭据；
 * - `page.mjs` 属于 T2，这里**动态**加载，避免 T1 单独交付时因文件不存在而整个模块加载失败。
 *
 * @module lib/connection
 */

import { BrowserError, ERROR_CODES, toPublicError } from './errors.mjs';
import { launchChrome, redactUrl, stopChrome } from './chrome.mjs';
import { CdpBrowser } from './cdp.mjs';
import { DEFAULT_CONFIG, getScheme, isSchemeId, normalizeConfig, planScheme } from './schemes.mjs';

/** 临时目录清理：失败不抛。 */
async function removeDirQuietly(dir) {
  if (typeof dir !== 'string' || dir === '') return;
  try {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 清理失败只影响磁盘，不影响连接状态。
  }
}

/** 动态加载 T2 的 PageHandle；缓存模块引用避免重复 import 开销。 */
let pageModulePromise;
async function defaultCreatePage(session, targetId) {
  if (pageModulePromise === undefined) pageModulePromise = import('./page.mjs');
  const module = await pageModulePromise;
  const PageHandle = module.PageHandle;
  if (typeof PageHandle !== 'function') {
    throw new BrowserError(
      ERROR_CODES.PROTOCOL_ERROR,
      'lib/page.mjs 没有导出 PageHandle 类（页面语义层未正确安装）',
      { module: 'lib/page.mjs' },
    );
  }
  return new PageHandle(session, targetId);
}

/**
 * 浏览器连接管理器。
 *
 * @example
 * const manager = new BrowserManager(() => config, ctx.logger);
 * const { page } = await manager.activePage();
 * await page.navigate('https://example.com');
 */
export class BrowserManager {
  /** @type {() => unknown} */
  #getConfig;
  /** @type {{ info?: Function, warn?: Function, debug?: Function } | undefined} */
  #logger;
  /**
   * 可注入的依赖：单测里替换成 fake，生产代码用默认实现。
   * @type {{ openBrowser: Function, launch: Function, stop: Function, plan: Function, createPage: Function }}
   */
  #deps;
  /** @type {CdpBrowser | undefined} */
  #browser;
  /** @type {string | undefined} 实际连接使用的方案 id。 */
  #scheme;
  #wsUrl = '';
  /** @type {{ browser: string, protocolVersion: string, userAgent: string } | undefined} */
  #version;
  #pid = 0;
  #userDataDir = '';
  #isolated = false;
  #lastError = '';
  #pageCount = 0;
  /** @type {string | undefined} 当前激活页 targetId。 */
  #activeTargetId;
  /** @type {Map<string, { session: import('./cdp.mjs').TargetSession, page: any }>} */
  #pages = new Map();
  /** @type {Promise<void> | undefined} 并发 connect 去重。 */
  #pendingConnect;
  /** @type {Array<{ pid: number, userDataDir: string, isolated: boolean }>} 断开但未关闭的自有 Chrome。 */
  #pendingCleanup = [];
  #disposed = false;

  /**
   * @param {() => unknown} getConfig - 每次调用返回最新配置快照（设置页可能改过）。
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [logger] - Cordis logger（可选）。
   * @param {{ openBrowser?: Function, launch?: Function, stop?: Function, plan?: Function, createPage?: Function }} [deps]
   *   **仅供单测注入**；正常调用只用前两个参数。
   */
  constructor(getConfig, logger, deps = {}) {
    if (typeof getConfig !== 'function') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'BrowserManager 需要一个返回配置的函数', {});
    }
    this.#getConfig = getConfig;
    this.#logger = logger;
    this.#deps = {
      openBrowser: deps.openBrowser ?? ((wsUrl, options) => CdpBrowser.open(wsUrl, options)),
      launch: deps.launch ?? launchChrome,
      stop: deps.stop ?? stopChrome,
      plan: deps.plan ?? planScheme,
      createPage: deps.createPage ?? defaultCreatePage,
    };
  }

  /** 当前配置快照（已补齐默认值；getConfig 抛错时用默认值兜底）。 */
  get config() {
    try {
      return normalizeConfig(this.#getConfig());
    } catch (error) {
      this.#logger?.warn?.(`读取插件配置失败，使用默认值：${error instanceof Error ? error.message : String(error)}`);
      return { ...DEFAULT_CONFIG };
    }
  }

  /**
   * 当前状态（**不**建立连接，快速返回）。
   *
   * @returns {{ connected: boolean, scheme: string, wsUrl: string, browserVersion: string,
   *   launchedPid: number, launchedUserDataDir: string, lastError: string, pageCount: number }}
   */
  status() {
    const config = this.config;
    const connected = this.#browser !== undefined && !this.#browser.closed;
    return {
      connected,
      scheme: connected && this.#scheme !== undefined ? this.#scheme : config.scheme,
      wsUrl: connected ? this.#wsUrl : '',
      browserVersion: connected && this.#version !== undefined ? this.#version.browser : '',
      launchedPid: this.#pid,
      launchedUserDataDir: this.#userDataDir,
      lastError: this.#lastError,
      pageCount: connected ? this.#pageCount : 0,
    };
  }

  /**
   * 切换方案并（可选）连接。
   *
   * `auto-connect` 不可用时自动回落到 `launch`（契约 §5.1），返回值里的 `scheme`
   * 是**实际**使用的方案，`note` 说明回落原因。
   *
   * @param {{ scheme?: string, overrides?: object, timeoutMs?: number }} [options]
   * @returns {Promise<{ scheme: string, wsUrl: string, browserVersion: string, reused: boolean,
   *   launchedPid: number, note: string }>}
   * @throws {BrowserError}
   */
  async connect(options = {}) {
    if (this.#disposed) {
      throw new BrowserError(ERROR_CODES.NOT_CONNECTED, 'BrowserManager 已 dispose，不能再次连接', {});
    }
    const base = this.config;
    const overrides = options.overrides !== null && typeof options.overrides === 'object' ? options.overrides : {};
    const config = normalizeConfig({ ...base, ...overrides });
    const targetScheme = typeof options.scheme === 'string' && options.scheme !== '' ? options.scheme : config.scheme;
    if (!isSchemeId(targetScheme)) {
      throw new BrowserError(
        ERROR_CODES.SCHEME_UNKNOWN,
        `未知连接方案 "${String(targetScheme)}"（可用：launch / auto-connect / browser-url / ws-endpoint）`,
        { scheme: String(targetScheme) },
      );
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : config.connectTimeoutMs;

    // 已有连接且方案没变：直接复用。
    if (this.#browser !== undefined && !this.#browser.closed && this.#scheme === targetScheme) {
      return {
        scheme: this.#scheme,
        wsUrl: this.#wsUrl,
        browserVersion: this.#version?.browser ?? '',
        reused: true,
        launchedPid: this.#pid,
        note: '',
      };
    }
    // 切换方案 / 旧连接已断：先断开（旧 ws 不能复用；自己的 Chrome 由本管理器负责关掉，避免孤儿进程）。
    if (this.#browser !== undefined) {
      await this.disconnect({ closeBrowser: true });
    }

    let result;
    let note = '';
    try {
      result = await this.#connectScheme(targetScheme, config, timeoutMs);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      // 方案 B 不可用 → 回落到方案 A（契约 §5.1）。回落只做一层，不会递归。
      if (targetScheme !== 'auto-connect') throw error;
      this.#logger?.warn?.(`auto-connect 不可用，回落到 launch：${this.#lastError}`);
      try {
        const fallback = await this.#connectScheme('launch', config, timeoutMs);
        result = fallback;
        note = `auto-connect 不可用（${this.#lastError}），已自动回落到 launch 方案。`;
      } catch (fallbackError) {
        const launchError = toPublicError(fallbackError);
        const composed = new BrowserError(
          ERROR_CODES.CONNECT_FAILED,
          `auto-connect 不可用（${this.#lastError}），回落到 launch 也失败（${launchError.message}）`,
          { autoConnectError: toPublicError(error), launchError },
        );
        // status() 的 lastError 要给用户完整原因（含回落失败信息），不能只留第一段。
        this.#lastError = composed.message;
        throw composed;
      }
    }

    this.#browser = result.browser;
    this.#scheme = result.scheme;
    this.#wsUrl = redactUrl(result.wsUrl);
    this.#version = result.browser.version;
    this.#pid = result.pid;
    this.#userDataDir = result.userDataDir;
    this.#isolated = result.isolated;
    this.#activeTargetId = undefined;
    this.#pages.clear();
    this.#lastError = '';
    // 刷新一次页面数（失败不影响连接本身）。
    try {
      const pages = await result.browser.listTargets();
      this.#pageCount = pages.length;
    } catch (error) {
      this.#logger?.debug?.(`连接后列页面失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.#logger?.info?.(
      `已连接浏览器：scheme=${result.scheme} version=${this.#version?.browser ?? 'unknown'} pid=${this.#pid}`,
    );
    return {
      scheme: result.scheme,
      wsUrl: this.#wsUrl,
      browserVersion: this.#version?.browser ?? '',
      reused: false,
      launchedPid: this.#pid,
      note,
    };
  }

  /**
   * 按方案建立一条新连接（不碰已有状态；失败时清理自己刚启动的 Chrome）。
   *
   * @returns {Promise<{ browser: CdpBrowser, scheme: string, wsUrl: string, pid: number, userDataDir: string, isolated: boolean }>}
   */
  async #connectScheme(scheme, config, timeoutMs) {
    const plan = await this.#deps.plan(scheme, config);
    if (plan === null || typeof plan !== 'object' || plan.kind === 'invalid') {
      const reason = typeof plan?.reason === 'string' ? plan.reason : `无法解析连接方案 ${scheme}`;
      throw new BrowserError(ERROR_CODES.NO_DEBUG_ENDPOINT, reason, { scheme });
    }
    if (plan.kind === 'launch') {
      const launched = await this.#deps.launch({
        executablePath: plan.executablePath,
        channel: plan.channel,
        headless: plan.headless,
        isolated: plan.isolated,
        userDataDir: plan.userDataDir,
        viewport: plan.viewport,
        timeoutMs: Number.isFinite(plan.timeoutMs) && plan.timeoutMs > 0 ? plan.timeoutMs : timeoutMs,
      });
      try {
        const browser = await this.#deps.openBrowser(launched.wsUrl, { timeoutMs });
        return {
          browser,
          scheme,
          wsUrl: launched.wsUrl,
          pid: typeof launched.pid === 'number' ? launched.pid : 0,
          userDataDir: typeof launched.userDataDir === 'string' ? launched.userDataDir : '',
          isolated: launched.isolated === true,
        };
      } catch (error) {
        // launch 成功但 CDP 连接失败：关掉刚启动的进程并删临时 profile，不留孤儿。
        if (typeof launched.pid === 'number' && launched.pid > 0) {
          await this.#deps.stop(launched.pid);
        }
        if (launched.isolated === true && typeof launched.userDataDir === 'string') {
          await removeDirQuietly(launched.userDataDir);
        }
        throw error;
      }
    }
    // plan.kind === 'ws'
    const openOptions = { timeoutMs };
    if (plan.headers !== undefined && Object.keys(plan.headers).length > 0) openOptions.headers = plan.headers;
    const browser = await this.#deps.openBrowser(plan.wsUrl, openOptions);
    if (plan.source === 'auto-connect') {
      this.#logger?.info?.(`已复用当前 Chrome（auto-connect，${redactUrl(plan.wsUrl)}）`);
    }
    return { browser, scheme, wsUrl: plan.wsUrl, pid: 0, userDataDir: plan.userDataDir ?? '', isolated: false };
  }

  /**
   * 断开连接。
   *
   * 默认只断开 CDP 连接、**不关闭浏览器**（`browser_disconnect` 的 closeBrowser 控制）；
   * 只有 `closeBrowser: true` 且浏览器是本管理器启动的，才会 kill 它并删临时 profile。
   *
   * @param {{ closeBrowser?: boolean }} [options]
   * @returns {Promise<{ closedOwnedBrowser: boolean }>}
   */
  async disconnect(options = {}) {
    const closeBrowser = options.closeBrowser === true;
    const browser = this.#browser;
    const pid = this.#pid;
    const userDataDir = this.#userDataDir;
    const isolated = this.#isolated;

    this.#browser = undefined;
    this.#scheme = undefined;
    this.#wsUrl = '';
    this.#version = undefined;
    this.#pid = 0;
    this.#userDataDir = '';
    this.#isolated = false;
    this.#activeTargetId = undefined;
    this.#pageCount = 0;
    this.#pages.clear();

    if (browser !== undefined) {
      try {
        await browser.close();
      } catch (error) {
        this.#logger?.debug?.(`关闭 CDP 连接时出错（忽略）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let closedOwnedBrowser = false;
    if (pid > 0) {
      if (closeBrowser) {
        try {
          await this.#deps.stop(pid);
          closedOwnedBrowser = true;
        } catch (error) {
          this.#logger?.warn?.(`关闭自有 Chrome（pid=${pid}）失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (isolated) await removeDirQuietly(userDataDir);
      } else {
        // 保留记录，dispose 时再清理，避免留下孤儿进程。
        this.#pendingCleanup.push({ pid, userDataDir, isolated });
      }
    }
    this.#logger?.info?.(`已断开浏览器连接（closedOwnedBrowser=${closedOwnedBrowser}）`);
    return { closedOwnedBrowser };
  }

  /**
   * 懒连接：工具调用前确保已连接，返回 `CdpBrowser`。
   *
   * 发现连接已关闭时自动重连一次。
   *
   * @returns {Promise<CdpBrowser>}
   */
  async browser() {
    if (this.#disposed) {
      throw new BrowserError(ERROR_CODES.NOT_CONNECTED, 'BrowserManager 已 dispose，不能继续使用浏览器', {});
    }
    if (this.#browser !== undefined && !this.#browser.closed) return this.#browser;
    if (this.#pendingConnect !== undefined) {
      await this.#pendingConnect;
      return await this.browser();
    }
    this.#pendingConnect = (async () => {
      if (this.#browser !== undefined && this.#browser.closed) {
        this.#logger?.debug?.('CDP 连接已关闭，自动重连一次');
        // 必须走 disconnect 而不是直接置空：否则旧的自有 Chrome（launch 方案）会变成孤儿进程。
        await this.disconnect({ closeBrowser: true });
      }
      await this.connect();
    })().finally(() => {
      this.#pendingConnect = undefined;
    });
    await this.#pendingConnect;
    if (this.#browser === undefined) {
      throw new BrowserError(ERROR_CODES.NOT_CONNECTED, '连接后仍没有可用的 CdpBrowser', {});
    }
    return this.#browser;
  }

  /**
   * 当前激活页的 session 与 PageHandle；没有激活页时新建一个 `about:blank`。
   *
   * @returns {Promise<{ session: import('./cdp.mjs').TargetSession, page: any, targetId: string }>}
   */
  async activePage() {
    const browser = await this.browser();
    const pages = await browser.listTargets();
    this.#pageCount = pages.length;
    let targetId = this.#activeTargetId;
    if (targetId === undefined || !pages.some((entry) => entry.targetId === targetId)) {
      targetId = pages.length > 0 ? pages[0].targetId : undefined;
    }
    if (targetId === undefined) {
      const created = await browser.createTarget('about:blank');
      targetId = created.targetId;
      this.#pageCount = 1;
      this.#logger?.debug?.(`没有可用页面，已新建 about:blank（targetId=${targetId}）`);
    }
    this.#activeTargetId = targetId;
    const entry = await this.#handleFor(browser, targetId);
    return { session: entry.session, page: entry.page, targetId };
  }

  /**
   * 取指定 pageId 的页面（缺省 = 激活页）。供工具层的 `pageId?` 参数使用。
   *
   * pageId 就是 CDP 的 targetId（稳定、跨工具调用有效）。
   *
   * @param {string} [pageId]
   * @returns {Promise<{ session: import('./cdp.mjs').TargetSession, page: any, targetId: string }>}
   */
  async pageFor(pageId) {
    const wanted = typeof pageId === 'string' ? pageId.trim() : '';
    if (wanted === '') return await this.activePage();
    const browser = await this.browser();
    const pages = await browser.listTargets();
    if (!pages.some((entry) => entry.targetId === wanted)) {
      throw new BrowserError(
        ERROR_CODES.TARGET_NOT_FOUND,
        `没有 pageId 为 "${wanted}" 的页面。当前页面：${pages.map((entry) => entry.targetId).join(', ') || '（无）'}`,
        { pageId: wanted, pages: pages.map((entry) => entry.targetId) },
      );
    }
    this.#activeTargetId = wanted;
    const entry = await this.#handleFor(browser, wanted);
    return { session: entry.session, page: entry.page, targetId: wanted };
  }

  /**
   * 列出所有页面（供 `browser_list_pages`）。
   *
   * @returns {Promise<Array<{ pageId: string, targetId: string, url: string, title: string, active: boolean }>>}
   */
  async listPages() {
    const browser = await this.browser();
    const pages = await browser.listTargets();
    this.#pageCount = pages.length;
    const activeTargetId = this.#activeTargetId;
    return pages.map((entry, index) => ({
      pageId: entry.targetId,
      targetId: entry.targetId,
      url: entry.url,
      title: entry.title,
      active: activeTargetId !== undefined ? entry.targetId === activeTargetId : index === 0,
    }));
  }

  /**
   * 选中一个页面（供 `browser_select_page`）。
   *
   * @param {string} pageId
   * @returns {Promise<{ pageId: string, url: string, title: string }>}
   */
  async selectPage(pageId) {
    const { targetId, page } = await this.pageFor(pageId);
    let url = '';
    let title = '';
    try {
      url = typeof page?.url === 'function' ? await page.url() : '';
      title = typeof page?.title === 'function' ? await page.title() : '';
    } catch (error) {
      this.#logger?.debug?.(`读取选中页面标题失败（忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
    return { pageId: targetId, url, title };
  }

  /**
   * 新建页面（供 `browser_navigate` 的 newTab 与 `browser_close_page` 之外的新建需求）。
   *
   * @param {string} [url='about:blank']
   * @returns {Promise<{ pageId: string, url: string, title: string }>}
   */
  async newPage(url = 'about:blank') {
    const browser = await this.browser();
    const created = await browser.createTarget(url);
    this.#activeTargetId = created.targetId;
    const pages = await browser.listTargets();
    this.#pageCount = pages.length;
    const info = pages.find((entry) => entry.targetId === created.targetId);
    return { pageId: created.targetId, url: info?.url ?? url, title: info?.title ?? '' };
  }

  /**
   * 关闭页面（供 `browser_close_page`；pageId 缺省 = 激活页）。
   *
   * @param {string} [pageId]
   * @returns {Promise<{ closedPageId: string, remaining: number }>}
   */
  async closePage(pageId) {
    const browser = await this.browser();
    let targetId = typeof pageId === 'string' ? pageId.trim() : '';
    if (targetId === '') {
      const pages = await browser.listTargets();
      targetId = this.#activeTargetId !== undefined && pages.some((entry) => entry.targetId === this.#activeTargetId)
        ? this.#activeTargetId
        : pages.length > 0
          ? pages[0].targetId
          : '';
      if (targetId === '') {
        throw new BrowserError(ERROR_CODES.TARGET_NOT_FOUND, '当前没有可关闭的页面', {});
      }
    }
    await browser.closeTarget(targetId);
    const cached = this.#pages.get(targetId);
    if (cached !== undefined) {
      try {
        cached.page?.dispose?.();
      } catch {
        // PageHandle.dispose 失败不影响关闭动作。
      }
      this.#pages.delete(targetId);
    }
    if (this.#activeTargetId === targetId) this.#activeTargetId = undefined;
    const pages = await browser.listTargets();
    this.#pageCount = pages.length;
    return { closedPageId: targetId, remaining: pages.length };
  }

  /**
   * 进程退出 / 插件卸载时调用：断开连接、关闭自有 Chrome、删临时 profile。
   *
   * 幂等。
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [, entry] of this.#pages) {
      try {
        entry.page?.dispose?.();
      } catch {
        // 忽略。
      }
    }
    this.#pages.clear();
    try {
      await this.disconnect({ closeBrowser: true });
    } catch (error) {
      this.#logger?.warn?.(`dispose 时断开连接失败（忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
    const pending = this.#pendingCleanup.splice(0, this.#pendingCleanup.length);
    for (const item of pending) {
      try {
        await this.#deps.stop(item.pid);
      } catch {
        // 忽略。
      }
      if (item.isolated) await removeDirQuietly(item.userDataDir);
    }
    this.#logger?.info?.('BrowserManager 已释放');
  }

  /**
   * 取（或创建并缓存）某 target 的 session + PageHandle。
   *
   * @param {CdpBrowser} browser
   * @param {string} targetId
   * @returns {Promise<{ session: import('./cdp.mjs').TargetSession, page: any }>}
   */
  async #handleFor(browser, targetId) {
    const cached = this.#pages.get(targetId);
    if (cached !== undefined && !cached.session.detached) return cached;
    const session = await browser.attach(targetId);
    const page = await this.#deps.createPage(session, targetId);
    const entry = { session, page };
    this.#pages.set(targetId, entry);
    return entry;
  }

  /** 当前激活页 targetId（诊断用；未连接时为 undefined）。 */
  get activeTargetId() {
    return this.#activeTargetId;
  }

  /** 当前实际连接的方案 id（未连接时为 undefined）。 */
  get scheme() {
    return this.#scheme;
  }

  /** 方案元数据，供工具层把 id 翻成 label。 */
  labelOf(scheme) {
    return getScheme(scheme)?.label ?? String(scheme ?? '');
  }
}
