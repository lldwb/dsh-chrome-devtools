/**
 * 纯 CDP 协议层：WebSocket 连接、请求/响应配对、事件分发、target/session 管理。
 *
 * 这一层**不**涉及 Chrome 生命周期（寻找/启动/关闭进程在 lib/chrome.mjs），
 * 也**不**涉及工具语义（导航/点击/截图在 lib/page.mjs）。
 *
 * 只用 Node 内置能力：全局 `WebSocket`（Node 22+）与 `node:http`（仅测试用）。
 *
 * ## 关于自定义握手头（方案 D 鉴权）
 *
 * Node 的全局 `WebSocket` 构造签名是 `new WebSocket(url, protocols)`，**不支持 headers**。
 * 本实现的结论（实测 Node 22.23.3 / 24.21.0，见 {@link prepareWebSocketUrl}）：
 * - 传 headers 对象给构造函数会被**静默忽略**（不抛错），所以绝不这样做；
 * - URL 内嵌凭据（`ws://user:pass@host`）会被 undici **静默丢弃**，也不可用；
 * - 于是**需要鉴权的 ws 端点目前不支持**：传了 headers 或 URL 凭据一律抛
 *   `BrowserError('INVALID_ARGUMENT')` 并说明原因。带明确失败，胜过「连上了但没认证」。
 * - 不需要鉴权的 ws 端点（最常见）完全可用。
 *
 * 若将来必须支持自定义头，唯一零依赖路线是自写最小 WebSocket 帧协议；契约 §3.3
 * 明确指示不做，所以这里不做。
 *
 * @module lib/cdp
 */

import { BrowserError, ERROR_CODES } from './errors.mjs';
import { redactUrl } from './chrome.mjs';

/** 连接握手默认超时（毫秒）。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

/** 单条 CDP send 的默认超时（毫秒）。截图/导航这类慢方法可逐次覆盖。 */
export const DEFAULT_SEND_TIMEOUT_MS = 15000;

/** WebSocket readyState 数字常量，避免依赖全局 WebSocket 的静态属性写法差异。 */
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/**
 * 校验并归一化 ws 连接目标；遇到 Node 内置 WebSocket 表达不了的东西时**明确报错**。
 *
 * #### 实测结论（Node 22.23.3 与 Node 24.21.0 都验证过）
 *
 * 1. `new WebSocket(url, protocols)` 的第二参数只接受子协议：传 `{ headers: {...} }`
 *    **不会抛错，而是被静默忽略** —— 这是最危险的坑，绝不能把 headers 对象递进去。
 * 2. URL 里内嵌的 `user:pass@` 会被 undici **静默丢弃**，握手请求里不会出现
 *    `Authorization` 头（契约 §3.3 说的「用 ws://user:pass@host 形式」在 Node 上不成立）。
 *
 * 所以方案 D 的鉴权在零依赖前提下不可行：这里对「URL 带凭据」与「传了自定义头」都抛
 * `INVALID_ARGUMENT` 并说清原因，让用户看到明确失败，而不是「连上了但没认证」。
 * 不需要鉴权的 ws 端点（最常见情况）不受影响。
 *
 * @param {string} wsUrl - 目标 ws/wss URL。
 * @param {Record<string, string> | undefined} headers - 调用方想加的自定义头（目前一律不支持）。
 * @returns {string} 可直接交给 `new WebSocket()` 的 URL。
 * @throws {BrowserError} `INVALID_ARGUMENT`
 */
export function prepareWebSocketUrl(wsUrl, headers) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(String(wsUrl));
  } catch {
    throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, `wsUrl 不是合法 URL：${redactUrl(String(wsUrl))}`, {
      wsUrl: redactUrl(String(wsUrl)),
    });
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new BrowserError(
      ERROR_CODES.INVALID_ARGUMENT,
      `wsUrl 必须以 ws:// 或 wss:// 开头（收到 ${parsed.protocol}//）；http 调试端点请用方案 C（browser-url）。`,
      { wsUrl: redactUrl(String(wsUrl)) },
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BrowserError(
      ERROR_CODES.INVALID_ARGUMENT,
      'Node 内置 WebSocket 会静默丢弃 URL 里的 user:pass@ 凭据（实测 Node 22/24 都不会发送 Authorization 头），' +
        '所以不能用 URL 内嵌凭据做鉴权。请去掉凭据；需要鉴权的端点目前不支持（见 wsHeaders 限制）。',
      { wsUrl: redactUrl(String(wsUrl)), reason: 'url-credentials-unsupported' },
    );
  }
  if (headers !== undefined && headers !== null && typeof headers === 'object') {
    const keys = Object.keys(headers).filter((key) => headers[key] !== undefined && headers[key] !== null && String(headers[key]) !== '');
    if (keys.length > 0) {
      throw new BrowserError(
        ERROR_CODES.INVALID_ARGUMENT,
        `Node 内置 WebSocket 不支持自定义握手头（${keys.join(', ')}）：构造函数第二参数只接受子协议，` +
          '传 headers 对象会被静默忽略。方案 D 的 wsHeaders 目前只能留空；需要鉴权的端点请改用其它连接方式' +
          '（例如本地转发端口后用 browser-url 方案）。',
        { unsupportedHeaders: keys, reason: 'headers-unsupported' },
      );
    }
  }
  return parsed.toString();
}

/**
 * 兼容别名：早期实现叫 `applyHeadersToUrl`。保持导出，行为同 {@link prepareWebSocketUrl}。
 *
 * @deprecated 用 {@link prepareWebSocketUrl}。
 */
export const applyHeadersToUrl = prepareWebSocketUrl;

/**
 * 一条 CDP WebSocket 连接。
 *
 * 构造即连接：用 {@link CdpConnection.open} 创建（它等握手完成）。
 * 内部维护 `id → pending` 映射；连接关闭时所有未完成请求 reject。
 */
export class CdpConnection {
  /** @type {WebSocket} */
  #ws;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>, method: string }>} */
  #pending = new Map();
  /** @type {Map<string, Set<(...args: any[]) => void>>} */
  #listeners = new Map();
  /** @type {Set<() => void>} */
  #closeListeners = new Set();
  #nextId = 0;
  #closed = false;
  /** @type {Record<string, unknown>} */
  #lastCloseEvent = {};
  #sendTimeoutMs;
  #url;

  /**
   * @param {WebSocket} ws - 已构造的 WebSocket（可能还在 CONNECTING）。
   * @param {{ url?: string, sendTimeoutMs?: number }} [options]
   */
  constructor(ws, options = {}) {
    this.#ws = ws;
    this.#url = typeof options.url === 'string' ? options.url : '';
    this.#sendTimeoutMs = Number.isFinite(options.sendTimeoutMs) && Number(options.sendTimeoutMs) > 0
      ? Number(options.sendTimeoutMs)
      : DEFAULT_SEND_TIMEOUT_MS;
    ws.addEventListener('message', (event) => this.#handleRawMessage(event.data));
    ws.addEventListener('close', (event) => {
      this.#lastCloseEvent = { code: event?.code, reason: event?.reason };
      this.#handleClose();
    });
    // error 在握手阶段由 open() 处理；连接建立后出现 error 通常紧跟 close，这里只记录。
    ws.addEventListener('error', () => {
      if (ws.readyState === WS_CLOSED) this.#handleClose();
    });
  }

  /**
   * 建立连接（等 WebSocket 握手完成）。
   *
   * @param {string} wsUrl - `ws://` 或 `wss://` 端点。
   * @param {{ headers?: Record<string, string>, timeoutMs?: number, sendTimeoutMs?: number }} [options]
   * @returns {Promise<CdpConnection>}
   * @throws {BrowserError} `CONNECT_FAILED`（握手失败/超时）、`INVALID_ARGUMENT`（headers 不支持）
   */
  static async open(wsUrl, options = {}) {
    if (typeof wsUrl !== 'string' || wsUrl.trim() === '') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'wsUrl 不能为空', { wsUrl: '' });
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_CONNECT_TIMEOUT_MS;
    const finalUrl = prepareWebSocketUrl(wsUrl.trim(), options.headers);
    /** @type {WebSocket} */
    let ws;
    try {
      ws = new WebSocket(finalUrl);
    } catch (error) {
      throw new BrowserError(
        ERROR_CODES.CONNECT_FAILED,
        `无法创建 WebSocket（${redactUrl(finalUrl)}）：${/** @type {Error} */ (error).message}`,
        { wsUrl: redactUrl(finalUrl) },
      );
    }
    const connection = new CdpConnection(ws, { url: redactUrl(finalUrl), sendTimeoutMs: options.sendTimeoutMs });
    await connection.#waitOpen(timeoutMs);
    return connection;
  }

  /**
   * 等握手完成；失败/超时抛 `CONNECT_FAILED`。
   *
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  #waitOpen(timeoutMs) {
    const ws = this.#ws;
    if (ws.readyState === WS_OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (event) => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = /** @type {any} */ (event)?.error?.message ?? /** @type {any} */ (event)?.message ?? '';
        reject(new BrowserError(
          ERROR_CODES.CONNECT_FAILED,
          `连接 ${this.#url === '' ? 'CDP WebSocket' : this.#url} 失败${detail === '' ? '' : `：${detail}`}`,
          { wsUrl: this.#url },
        ));
      };
      const onClose = (event) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new BrowserError(
          ERROR_CODES.CONNECT_FAILED,
          `连接 ${this.#url === '' ? 'CDP WebSocket' : this.#url} 在握手完成前被关闭（code ${String(/** @type {any} */ (event)?.code ?? '')}）`,
          { wsUrl: this.#url },
        ));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          // 已关闭：忽略。
        }
        reject(new BrowserError(
          ERROR_CODES.CONNECT_FAILED,
          `连接 ${this.#url === '' ? 'CDP WebSocket' : this.#url} 超时（${timeoutMs}ms）`,
          { wsUrl: this.#url, timeoutMs },
        ));
      }, timeoutMs);
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    });
  }

  /** 脱敏后的 ws URL（不含凭据）。 */
  get url() {
    return this.#url;
  }

  /** 连接是否已关闭。 */
  get closed() {
    return this.#closed || this.#ws.readyState === WS_CLOSED;
  }

  /** 最近一次 close 事件的 `{ code, reason }`（诊断用）。 */
  get lastCloseEvent() {
    return { ...this.#lastCloseEvent };
  }

  /** 连接是否可发请求（已 open 且未关闭）。 */
  get opened() {
    return !this.closed && this.#ws.readyState === WS_OPEN;
  }

  /** 当前默认 send 超时（毫秒）。 */
  get sendTimeoutMs() {
    return this.#sendTimeoutMs;
  }

  /** 修改默认 send 超时；截图/导航可临时调大。 */
  set sendTimeoutMs(value) {
    if (Number.isFinite(value) && Number(value) > 0) this.#sendTimeoutMs = Number(value);
  }

  /**
   * 发一条 CDP 命令。
   *
   * @param {string} method - 例如 `'Browser.getVersion'`。
   * @param {object} [params={}]
   * @param {string} [sessionId] - flat session 模式下附带的会话 id。
   * @param {{ timeoutMs?: number }} [options] - 逐次覆盖超时（截图/导航用更长）。
   * @returns {Promise<any>} CDP 的 `result`；错误响应 reject 成 `BrowserError('CDP_ERROR')`。
   */
  send(method, params = {}, sessionId, options = {}) {
    if (typeof sessionId === 'object' && sessionId !== null) {
      options = sessionId;
      sessionId = undefined;
    }
    if (typeof method !== 'string' || method === '') {
      return Promise.reject(new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'CDP method 不能为空', {}));
    }
    if (this.closed || this.#ws.readyState !== WS_OPEN) {
      return Promise.reject(new BrowserError(
        ERROR_CODES.NOT_CONNECTED,
        `CDP 连接${this.closed ? '已关闭' : '尚未握手完成'}，不能发送 ${method}`,
        { method },
      ));
    }
    const timeoutMs = Number.isFinite(options?.timeoutMs) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : this.#sendTimeoutMs;
    const id = this.#nextId + 1;
    this.#nextId = id;
    /** @type {Record<string, unknown>} */
    const payload = { id, method, params: params === null || params === undefined ? {} : params };
    if (typeof sessionId === 'string' && sessionId !== '') payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrowserError(
          ERROR_CODES.TIMEOUT,
          `CDP 方法 ${method} 超时（${timeoutMs}ms）`,
          { method, id, timeoutMs },
        ));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new BrowserError(
          ERROR_CODES.CONNECT_FAILED,
          `发送 CDP 方法 ${method} 失败：${/** @type {Error} */ (error).message}`,
          { method },
        ));
      }
    });
  }

  /**
   * 订阅 CDP 事件；返回取消函数。
   *
   * listener 收到 `(params, sessionId)`，`sessionId` 对浏览器级事件为 `undefined`。
   *
   * @param {string} eventName - 例如 `'Runtime.consoleAPICalled'`。
   * @param {(params: any, sessionId?: string) => void} listener
   * @returns {() => void} 取消订阅
   */
  on(eventName, listener) {
    if (typeof eventName !== 'string' || eventName === '') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'on() 的 eventName 不能为空', {});
    }
    if (typeof listener !== 'function') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, `on(${eventName}) 需要 listener 函数`, { event: eventName });
    }
    let set = this.#listeners.get(eventName);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(eventName, set);
    }
    set.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(eventName);
    };
  }

  /**
   * 等一个事件（一次性）。超时抛 `TIMEOUT`，连接关闭抛 `CONNECT_FAILED`。
   *
   * @param {string} eventName
   * @param {number} [timeoutMs] - 默认用连接的 sendTimeoutMs。
   * @returns {Promise<any>} 事件 params（没有 params 时是 undefined）
   */
  once(eventName, timeoutMs) {
    const budget = Number.isFinite(timeoutMs) && Number(timeoutMs) > 0 ? Number(timeoutMs) : this.#sendTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const cleanup = () => {
        offEvent();
        offClose();
        if (timer !== undefined) clearTimeout(timer);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const offEvent = this.on(eventName, (params) => finish(resolve, params));
      const offClose = this.onClose(() => finish(reject, new BrowserError(
        ERROR_CODES.CONNECT_FAILED,
        `等待 CDP 事件 ${eventName} 时连接已关闭`,
        { event: eventName },
      )));
      timer = setTimeout(() => finish(reject, new BrowserError(
        ERROR_CODES.TIMEOUT,
        `等待 CDP 事件 ${eventName} 超时（${budget}ms）`,
        { event: eventName, timeoutMs: budget },
      )), budget);
    });
  }

  /**
   * 订阅连接关闭；已关闭时异步立即回调一次。返回取消函数。
   *
   * @param {() => void} listener
   * @returns {() => void}
   */
  onClose(listener) {
    if (typeof listener !== 'function') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'onClose() 需要 listener 函数', {});
    }
    if (this.closed) {
      queueMicrotask(() => {
        try {
          listener();
        } catch {
          // 监听器异常不影响连接状态。
        }
      });
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /**
   * 关闭连接并 reject 所有未完成请求。幂等。
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#ws.readyState === WS_CLOSED) {
      this.#handleClose();
      return;
    }
    if (this.#ws.readyState === WS_CLOSING) {
      // 已在关闭中：等 close 事件，最多 1s。
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
        this.#ws.addEventListener('close', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      this.#handleClose();
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref?.();
      this.#ws.addEventListener('close', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      try {
        this.#ws.close(1000, 'client close');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.#handleClose();
  }

  /** 处理原始 message 数据（文本帧是 string；Blob 转文本）。 */
  #handleRawMessage(data) {
    if (typeof data === 'string') {
      this.#handleMessageText(data);
      return;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      try {
        const text = new TextDecoder().decode(data);
        this.#handleMessageText(text);
      } catch {
        // 非 UTF-8：忽略（CDP 不会发二进制）。
      }
      return;
    }
    if (typeof (/** @type {any} */ (data))?.text === 'function') {
      Promise.resolve(/** @type {any} */ (data).text())
        .then((text) => this.#handleMessageText(text))
        .catch(() => {});
    }
  }

  /** 解析并分发一条文本消息。 */
  #handleMessageText(text) {
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#emit('protocol.error', { detail: 'CDP 返回了非 JSON 消息', snippet: String(text).slice(0, 200) });
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const id = parsed.id;
    if (typeof id === 'number' || typeof id === 'string') {
      const pending = this.#pending.get(id);
      if (pending === undefined) return; // 超时后才到的响应：丢弃。
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (parsed.error !== undefined && parsed.error !== null) {
        const cdpError = /** @type {any} */ (parsed.error);
        pending.reject(new BrowserError(
          ERROR_CODES.CDP_ERROR,
          `${pending.method} 失败：${typeof cdpError.message === 'string' ? cdpError.message : 'CDP error'}`,
          {
            method: pending.method,
            code: typeof cdpError.code === 'number' ? cdpError.code : null,
            data: cdpError.data === undefined ? null : cdpError.data,
          },
        ));
      } else {
        pending.resolve(parsed.result === undefined ? {} : parsed.result);
      }
      return;
    }
    if (typeof parsed.method === 'string' && parsed.method !== '') {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
      this.#emit(parsed.method, parsed.params === undefined ? {} : parsed.params, sessionId);
    }
  }

  /** 向监听器分发事件（复制一份，避免监听器在回调里取消订阅导致遍历错乱）。 */
  #emit(eventName, params, sessionId) {
    const set = this.#listeners.get(eventName);
    if (set === undefined || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(params, sessionId);
      } catch {
        // 一个监听器抛错不应该影响其它监听器与协议状态。
      }
    }
  }

  /** 连接关闭：reject 全部 pending、通知 close 监听器。幂等。 */
  #handleClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new BrowserError(
        ERROR_CODES.CONNECT_FAILED,
        `CDP 连接已关闭，未完成的 ${pending.method} 被取消`,
        { method: pending.method },
      ));
    }
    this.#pending.clear();
    for (const listener of [...this.#closeListeners]) {
      try {
        listener();
      } catch {
        // 监听器异常不影响连接状态。
      }
    }
    this.#closeListeners.clear();
  }
}

/**
 * 浏览器级会话：管理 target/tab，并在其之上提供命名空间的 session 封装。
 *
 * 内部持有一条 {@link CdpConnection}；`version` 来自 `Browser.getVersion`。
 */
export class CdpBrowser {
  /** @type {CdpConnection} */
  #connection;
  /** @type {{ browser: string, protocolVersion: string, userAgent: string }} */
  #version;
  /** @type {Map<string, TargetSession>} 显式 attach 的会话（每个 target 一个）。 */
  #sessions = new Map();
  /** @type {Map<string, string>} targetId → 自动 attach 得到的 sessionId。 */
  #autoSessions = new Map();
  #disposed = false;
  #closeListeners = new Set();
  /** @type {string[]} */
  #warnings = [];

  /**
   * @param {CdpConnection} connection
   * @param {{ browser: string, protocolVersion: string, userAgent: string }} version
   */
  constructor(connection, version) {
    this.#connection = connection;
    this.#version = version;
    connection.on('Target.attachedToTarget', (params) => this.#handleAttachedToTarget(params));
    connection.on('Target.detachedFromTarget', (params) => this.#handleDetachedFromTarget(params));
    connection.onClose(() => {
      this.#sessions.clear();
      this.#autoSessions.clear();
      this.#notifyClose();
    });
  }

  /**
   * 打开一个浏览器级 CDP 会话。
   *
   * @param {string} wsUrl
   * @param {{ headers?: Record<string, string>, timeoutMs?: number, sendTimeoutMs?: number, autoAttach?: boolean,
   *   discoverTargets?: boolean }} [options]
   * @returns {Promise<CdpBrowser>}
   * @throws {BrowserError} `CONNECT_FAILED` / `INVALID_ARGUMENT` / `CDP_ERROR`
   */
  static async open(wsUrl, options = {}) {
    const connection = await CdpConnection.open(wsUrl, options);
    try {
      const info = await connection.send('Browser.getVersion');
      /** @type {{ browser: string, protocolVersion: string, userAgent: string }} */
      const version = {
        browser: String(info?.product ?? ''),
        protocolVersion: String(info?.protocolVersion ?? ''),
        userAgent: String(info?.userAgent ?? ''),
      };
      const browser = new CdpBrowser(connection, version);
      if (options.discoverTargets !== false) {
        try {
          await connection.send('Target.setDiscoverTargets', { discover: true });
        } catch (error) {
          browser.#warnings.push(`Target.setDiscoverTargets 失败：${/** @type {Error} */ (error).message}`);
        }
      }
      if (options.autoAttach !== false) {
        try {
          await connection.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          });
        } catch (error) {
          browser.#warnings.push(`Target.setAutoAttach 失败：${/** @type {Error} */ (error).message}`);
        }
      }
      return browser;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  /** 底层连接（连接管理器用它判断连接是否还活着）。 */
  get connection() {
    return this.#connection;
  }

  /** 浏览器版本信息（`Browser.getVersion` 的子集）。 */
  get version() {
    return { ...this.#version };
  }

  /** 连接是否已关闭。 */
  get closed() {
    return this.#disposed || this.#connection.closed;
  }

  /** 非致命告警（例如某些浏览器不支持 setAutoAttach）。 */
  get warnings() {
    return [...this.#warnings];
  }

  /**
   * 订阅连接关闭；已关闭时异步立即回调一次。返回取消函数。
   *
   * @param {() => void} listener
   * @returns {() => void}
   */
  onClose(listener) {
    if (typeof listener !== 'function') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'onClose() 需要 listener 函数', {});
    }
    if (this.closed) {
      queueMicrotask(() => {
        try {
          listener();
        } catch {
          // 忽略监听器异常。
        }
      });
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /**
   * 列出页面 target（只返回 `type === 'page'`）。
   *
   * @returns {Promise<Array<{ targetId: string, type: 'page', url: string, title: string, attached: boolean, openerId?: string }>>}
   */
  async listTargets() {
    const result = await this.#connection.send('Target.getTargets');
    /** @type {any[]} */
    const infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
    /** @type {Array<{ targetId: string, type: 'page', url: string, title: string, attached: boolean, openerId?: string }>} */
    const pages = [];
    for (const info of infos) {
      if (info === null || typeof info !== 'object') continue;
      if (String(info.type) !== 'page') continue;
      /** @type {{ targetId: string, type: 'page', url: string, title: string, attached: boolean, openerId?: string }} */
      const page = {
        targetId: String(info.targetId),
        type: 'page',
        url: typeof info.url === 'string' ? info.url : '',
        title: typeof info.title === 'string' ? info.title : '',
        attached: info.attached === true,
      };
      if (typeof info.openerId === 'string' && info.openerId !== '') page.openerId = info.openerId;
      pages.push(page);
    }
    return pages;
  }

  /**
   * 新建一个页面 target。
   *
   * @param {string} [url='about:blank']
   * @returns {Promise<{ targetId: string }>}
   */
  async createTarget(url = 'about:blank') {
    const result = await this.#connection.send('Target.createTarget', { url: String(url) });
    const targetId = typeof result?.targetId === 'string' ? result.targetId : '';
    if (targetId === '') {
      throw new BrowserError(ERROR_CODES.PROTOCOL_ERROR, 'Target.createTarget 没有返回 targetId', { url });
    }
    return { targetId };
  }

  /**
   * 关闭一个页面 target。target 已不存在时静默返回。
   *
   * @param {string} targetId
   * @returns {Promise<void>}
   */
  async closeTarget(targetId) {
    if (typeof targetId !== 'string' || targetId === '') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'closeTarget 需要非空 targetId', {});
    }
    try {
      await this.#connection.send('Target.closeTarget', { targetId });
    } catch (error) {
      if (!isTargetGoneError(error)) throw error;
      return;
    }
    this.#forgetTarget(targetId);
  }

  /**
   * 为一个 target 建 flat session；已存在则复用。
   *
   * @param {string} targetId
   * @returns {Promise<TargetSession>}
   */
  async attach(targetId) {
    if (typeof targetId !== 'string' || targetId === '') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, 'attach 需要非空 targetId', {});
    }
    const existing = this.#sessions.get(targetId);
    if (existing !== undefined) {
      if (!existing.detached) return existing;
      this.#sessions.delete(targetId);
    }
    const autoSessionId = this.#autoSessions.get(targetId);
    if (typeof autoSessionId === 'string' && autoSessionId !== '') {
      const session = new TargetSession(this, targetId, autoSessionId);
      this.#sessions.set(targetId, session);
      return session;
    }
    let result;
    try {
      result = await this.#connection.send('Target.attachToTarget', { targetId, flatten: true });
    } catch (error) {
      if (isTargetGoneError(error)) {
        throw new BrowserError(
          ERROR_CODES.TARGET_NOT_FOUND,
          `target ${targetId} 不存在或已关闭，无法附着`,
          { targetId },
        );
      }
      throw error;
    }
    const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : '';
    if (sessionId === '') {
      throw new BrowserError(ERROR_CODES.PROTOCOL_ERROR, `Target.attachToTarget 没有返回 sessionId（target ${targetId}）`, { targetId });
    }
    const session = new TargetSession(this, targetId, sessionId);
    this.#sessions.set(targetId, session);
    return session;
  }

  /**
   * 断开一个 target 的 session。
   *
   * @param {string} targetId
   * @returns {Promise<void>}
   */
  async detach(targetId) {
    const session = this.#sessions.get(targetId);
    if (session === undefined) return;
    this.#sessions.delete(targetId);
    const sessionId = session.sessionId;
    session.markDetached();
    // 自动 attach 得到的 session 也一并摘掉，避免后续 attach 复用一个不可用会话。
    this.#autoSessions.delete(targetId);
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        await this.#connection.send('Target.detachFromTarget', { sessionId });
      } catch {
        // target 已关闭 / session 已失效：detach 的目标状态已经达成。
      }
    }
  }

  /** 关闭浏览器级连接（不关闭浏览器进程本身）。 */
  async close() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of this.#sessions.values()) session.markDetached();
    this.#sessions.clear();
    this.#autoSessions.clear();
    await this.#connection.close();
    this.#notifyClose();
  }

  /** 处理 browser 级 `Target.attachedToTarget`。 */
  #handleAttachedToTarget(params) {
    const targetInfo = params?.targetInfo;
    const sessionId = params?.sessionId;
    if (targetInfo === null || typeof targetInfo !== 'object') return;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const targetId = String(targetInfo.targetId ?? '');
    if (targetId === '') return;
    if (this.#sessions.has(targetId)) return; // 已有显式会话：不要被自动会话覆盖。
    this.#autoSessions.set(targetId, sessionId);
    // waitForDebuggerOnStart 已设为 false，理论上不会出现；万一出现，必须放行，否则页面卡死。
    if (params?.waitingForDebugger === true) {
      void this.#connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  }

  /** 处理 browser 级 `Target.detachedFromTarget`。 */
  #handleDetachedFromTarget(params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    if (sessionId === '') return;
    for (const [targetId, autoSessionId] of this.#autoSessions) {
      if (autoSessionId === sessionId) this.#autoSessions.delete(targetId);
    }
    for (const [targetId, session] of this.#sessions) {
      if (session.sessionId === sessionId) {
        session.markDetached();
        this.#sessions.delete(targetId);
      }
    }
  }

  /** 清理某 target 的会话记录。 */
  #forgetTarget(targetId) {
    const session = this.#sessions.get(targetId);
    if (session !== undefined) {
      session.markDetached();
      this.#sessions.delete(targetId);
    }
    this.#autoSessions.delete(targetId);
  }

  /** 通知 close 监听器。 */
  #notifyClose() {
    for (const listener of [...this.#closeListeners]) {
      try {
        listener();
      } catch {
        // 忽略监听器异常。
      }
    }
    this.#closeListeners.clear();
  }
}

/**
 * 单个 target 的 session 封装：`send` 自动带 sessionId，事件只收本 session 的。
 */
export class TargetSession {
  /** @type {CdpBrowser} */
  #browser;
  #targetId;
  #sessionId;
  #detached = false;

  /**
   * 一般由 {@link CdpBrowser.attach} 创建，不要直接 new（需要 browser 才能发浏览器级命令）。
   *
   * @param {CdpBrowser} browser
   * @param {string} targetId
   * @param {string} sessionId
   */
  constructor(browser, targetId, sessionId) {
    this.#browser = browser;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
  }

  /** 该 session 对应的 target id。 */
  get targetId() {
    return this.#targetId;
  }

  /** CDP sessionId。 */
  get sessionId() {
    return this.#sessionId;
  }

  /** 是否已 detach（显式 detach、target 关闭或连接断开都会置位）。 */
  get detached() {
    return this.#detached;
  }

  /** 底层连接（T2 的事件订阅有时需要直接用它）。 */
  get connection() {
    return this.#browser.connection;
  }

  /** 所属浏览器。 */
  get browser() {
    return this.#browser;
  }

  /**
   * 在 session 上发 CDP 命令（自动带 sessionId）。
   *
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  send(method, params = {}, options = {}) {
    if (this.#detached) {
      return Promise.reject(new BrowserError(
        ERROR_CODES.NOT_CONNECTED,
        `session ${this.#sessionId} 已 detach，不能发送 ${method}`,
        { method, targetId: this.#targetId },
      ));
    }
    return this.#browser.connection.send(method, params, this.#sessionId, options);
  }

  /**
   * 订阅本 session 的事件；返回取消函数。
   *
   * @param {string} eventName - 例如 `'Page.loadEventFired'`。
   * @param {(params: any) => void} listener
   * @returns {() => void}
   */
  on(eventName, listener) {
    if (typeof listener !== 'function') {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, `on(${eventName}) 需要 listener 函数`, { event: eventName });
    }
    return this.#browser.connection.on(eventName, (params, sessionId) => {
      if (sessionId === this.#sessionId) listener(params);
    });
  }

  /**
   * 等本 session 的一个事件。
   *
   * 签名容错：`waitFor(name, timeoutMs)` 与 `waitFor(name, predicate, timeoutMs)` 都支持。
   *
   * @param {string} eventName
   * @param {((params: any) => boolean) | number} [predicate]
   * @param {number} [timeoutMs] - 默认用连接的 sendTimeoutMs。
   * @returns {Promise<any>} 满足 predicate 的事件 params
   */
  waitFor(eventName, predicate, timeoutMs) {
    let test = predicate;
    let budget = timeoutMs;
    if (typeof test === 'number' && budget === undefined) {
      budget = test;
      test = undefined;
    }
    const effectiveTimeout = Number.isFinite(budget) && Number(budget) > 0
      ? Number(budget)
      : this.#browser.connection.sendTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const cleanup = () => {
        offEvent();
        offClose();
        if (timer !== undefined) clearTimeout(timer);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const offEvent = this.on(eventName, (params) => {
        if (typeof test !== 'function') {
          finish(resolve, params);
          return;
        }
        let matched = false;
        try {
          matched = test(params) === true;
        } catch {
          matched = false;
        }
        if (matched) finish(resolve, params);
      });
      const offClose = this.#browser.onClose(() => finish(reject, new BrowserError(
        ERROR_CODES.CONNECT_FAILED,
        `等待 session 事件 ${eventName} 时连接已关闭`,
        { event: eventName, targetId: this.#targetId },
      )));
      timer = setTimeout(() => finish(reject, new BrowserError(
        ERROR_CODES.TIMEOUT,
        `等待 session 事件 ${eventName} 超时（${effectiveTimeout}ms）`,
        { event: eventName, timeoutMs: effectiveTimeout, targetId: this.#targetId },
      )), effectiveTimeout);
    });
  }

  /**
   * 断开本 session。
   *
   * 契约把返回值写成 `void`；实现返回 Promise 以便调用方按需等待，
   * 不 await 也安全（内部已吞掉失效错误）。
   *
   * @returns {Promise<void>}
   */
  async detach() {
    if (this.#detached) return;
    this.#detached = true;
    await this.#browser.detach(this.#targetId);
  }

  /** 标记 detach（由 CdpBrowser 在连接关闭/target 关闭时调用）。 */
  markDetached() {
    this.#detached = true;
  }
}

/** 判断 CDP 错误是否属于「target 已经不存在」。 */
function isTargetGoneError(error) {
  if (!(error instanceof BrowserError) || error.code !== ERROR_CODES.CDP_ERROR) return false;
  return /no target|target.*(not found|closed|gone)|session.*(not found|closed)|inspected target navigated/i.test(error.message);
}
