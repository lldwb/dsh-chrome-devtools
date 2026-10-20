/**
 * 页面观测层：控制台消息与网络请求的环形缓冲。
 *
 * ## 为什么单独一个模块
 *
 * `PageHandle` 已经够大（元素定位、鼠标/键盘原语、截图、对话框），而「把 CDP 事件
 * 变成模型可读的记录」是纯数据逻辑：它只依赖 `session.on` 与事件 payload 的形状，
 * 不碰 DOM、不碰元素定位。拆出来之后这部分可以在 Node 里用假 session 直接单测——
 * 这也是契约 §3.7 把它列为独立模块的原因。
 *
 * ## 两个容易踩的坑
 *
 * 1. **事件只在 `Runtime.enable` / `Network.enable` 之后才来**。Registry 只负责挂监听，
 *    domain 的 enable 由 `PageHandle` 在第一次操作前统一做（见 `PageHandle#_ensureEnabled`）。
 *    所以单独 new 一个 Registry 不 enable 是收不到任何消息的——这是设计，不是 bug。
 * 2. **缓冲必须是有上限的**。控制台/网络在一个长会话里可以产生数万条记录，全部留住
 *    只会把插件内存拖爆。契约 §3.6 明确「缓冲每页最近 200 条」，这里用数组/Map 的
 *    最旧淘汰实现，两条路径都不做无界增长。
 *
 * @module lib/observe
 */

/** 默认缓冲条数（契约 §3.6）。 */
export const DEFAULT_BUFFER_SIZE = 200;

/** `Runtime.consoleAPICalled.type` 的常见取值，用于归一化。 */
const CONSOLE_TYPE_ALIASES = Object.freeze({
  warn: 'warning',
  err: 'error',
  info: 'info',
  log: 'log',
  debug: 'debug',
  dir: 'dir',
  dirxml: 'dirxml',
  table: 'table',
  trace: 'trace',
  clear: 'clear',
  startGroup: 'group',
  startGroupCollapsed: 'group',
  endGroup: 'group',
  assert: 'assert',
  profile: 'profile',
  profileEnd: 'profile',
  count: 'count',
  timeEnd: 'time',
});

/**
 * 归一化控制台消息类型（`warn` / `warning` 视为同一类）。
 *
 * @param {unknown} type - 原始类型字符串。
 * @returns {string} 归一化后的小写类型；无法识别时原样返回字符串。
 */
export function normalizeConsoleType(type) {
  const text = typeof type === 'string' ? type.trim() : '';
  if (text === '') return 'log';
  if (Object.prototype.hasOwnProperty.call(CONSOLE_TYPE_ALIASES, text)) return CONSOLE_TYPE_ALIASES[text];
  const lower = text.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CONSOLE_TYPE_ALIASES, lower)) return CONSOLE_TYPE_ALIASES[lower];
  return lower;
}

/**
 * 把一个 CDP `RemoteObject` 转成可读文本。
 *
 * `Runtime.consoleAPICalled` 的 `args` 是 RemoteObject 数组：字符串在 `value` 里，
 * 数字/布尔也在 `value`，`NaN`/`Infinity` 这类在 `unserializableValue`，DOM 节点/函数
 * 这类没有 value 的只有 `description`。逐个分支取，取不到时退化成类型名，绝不抛错
 * ——一条奇怪的控制台消息不该让整个 `browser_console` 失败。
 *
 * @param {unknown} remote - CDP RemoteObject。
 * @returns {string} 可读文本。
 */
export function remoteObjectText(remote) {
  if (remote === null || remote === undefined) return '';
  if (typeof remote !== 'object') return String(remote);
  const object = /** @type {Record<string, unknown>} */ (remote);
  if (typeof object.value === 'string') return object.value;
  if (typeof object.value === 'number' || typeof object.value === 'boolean') return String(object.value);
  if (object.value !== undefined && object.value !== null) {
    try {
      const json = JSON.stringify(object.value);
      return json === undefined ? String(object.value) : json;
    } catch {
      return String(object.value);
    }
  }
  if (typeof object.unserializableValue === 'string') return object.unserializableValue;
  if (typeof object.description === 'string') return object.description;
  if (typeof object.type === 'string') return object.type;
  return '';
}

/**
 * 从 `Runtime.exceptionThrown` 的 payload 提取一条可读异常。
 *
 * @param {unknown} payload - CDP 事件 payload。
 * @returns {{ text: string, url: string, line: number }} 异常记录。
 */
export function exceptionRecord(payload) {
  const details = payload !== null && typeof payload === 'object'
    ? /** @type {Record<string, unknown>} */ (payload).exceptionDetails
    : undefined;
  const record = details !== null && typeof details === 'object' ? /** @type {Record<string, unknown>} */ (details) : {};
  const exception = record.exception !== null && typeof record.exception === 'object'
    ? /** @type {Record<string, unknown>} */ (record.exception)
    : {};
  const text = typeof exception.description === 'string' && exception.description !== ''
    ? exception.description
    : typeof record.text === 'string'
      ? record.text
      : remoteObjectText(record.exception);
  const url = typeof record.url === 'string' ? record.url : '';
  const lineNumber = typeof record.lineNumber === 'number' && Number.isFinite(record.lineNumber) ? record.lineNumber : -1;
  return { text, url, line: lineNumber >= 0 ? lineNumber + 1 : 0 };
}

/** 取一个安全的整数上限。 */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 取消一个监听函数，容忍任何异常。 */
function safeUnsubscribe(unsubscribe) {
  try {
    if (typeof unsubscribe === 'function') unsubscribe();
  } catch {
    // 取消监听失败不影响观测层继续工作。
  }
}

/**
 * 控制台消息环形缓冲。
 *
 * @example
 * const registry = new ConsoleRegistry(session).start();
 * // … 页面运行 …
 * registry.list({ limit: 20, types: ['error'] });
 */
export class ConsoleRegistry {
  /**
   * @param {object} session - `TargetSession`（只需要 `on(event, listener)`）。
   * @param {{ bufferSize?: number }} [options] - 缓冲上限，默认 200。
   */
  constructor(session, options = {}) {
    /** @type {object} */
    this.session = session;
    /** 缓冲上限（契约 §3.6 默认 200）。 */
    this.bufferSize = clampInt(options.bufferSize, DEFAULT_BUFFER_SIZE, 1, 1000);
    /** @type {{ type: string, text: string, url: string, line: number }[]} */
    this.messages = [];
    /** @type {(() => void)[]} */
    this._unsubscribers = [];
    this._started = false;
  }

  /** 是否已挂上监听。 */
  get started() {
    return this._started;
  }

  /**
   * 开始监听 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`。
   *
   * 幂等；`Runtime.enable` 由 PageHandle 负责，不在这里做（Registry 可以脱离 PageHandle
   * 单独用，enable 的时机属于调用方）。
   *
   * @returns {this} 便于链式调用。
   */
  start() {
    if (this._started) return this;
    this._started = true;
    if (this.session === null || typeof this.session !== 'object') return this;
    if (typeof this.session.on === 'function') {
      this._unsubscribers.push(
        this.session.on('Runtime.consoleAPICalled', (payload) => {
          this._pushConsole(payload);
        }),
      );
      this._unsubscribers.push(
        this.session.on('Runtime.exceptionThrown', (payload) => {
          const record = exceptionRecord(payload);
          this._push({ type: 'exception', text: record.text, url: record.url, line: record.line });
        }),
      );
    }
    return this;
  }

  /** 停止监听并清空未读监听器（已缓冲的消息保留，便于 stop 之后仍能读取）。 */
  stop() {
    for (const unsubscribe of this._unsubscribers.splice(0)) safeUnsubscribe(unsubscribe);
    this._started = false;
  }

  /**
   * 列出最近的控制台消息。
   *
   * @param {{ limit?: number, types?: string[] }} [options] - 条数上限（默认 50）与类型过滤。
   * @returns {{ type: string, text: string, url: string, line: number }[]} 按时间顺序，最多 limit 条。
   */
  list(options = {}) {
    const limit = clampInt(options.limit, 50, 0, this.bufferSize);
    const wanted = Array.isArray(options.types)
      ? options.types.filter((type) => typeof type === 'string' && type.trim() !== '').map((type) => normalizeConsoleType(type))
      : [];
    const filtered = wanted.length === 0
      ? this.messages.slice()
      : this.messages.filter((message) => wanted.includes(normalizeConsoleType(message.type)));
    const sliced = limit === 0 ? [] : filtered.slice(Math.max(0, filtered.length - limit));
    return sliced.map((message) => ({ ...message }));
  }

  /** 清空缓冲。 */
  clear() {
    this.messages.length = 0;
  }

  /**
   * 把一条 `Runtime.consoleAPICalled` payload 转成记录并压入缓冲。
   *
   * @param {unknown} payload - CDP 事件 payload。
   * @returns {void}
   */
  _pushConsole(payload) {
    const record = payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
    const args = Array.isArray(record.args) ? record.args : [];
    const text = args.map((entry) => remoteObjectText(entry)).join(' ').trim();
    const stack = record.stackTrace !== null && typeof record.stackTrace === 'object'
      ? /** @type {Record<string, unknown>} */ (record.stackTrace)
      : {};
    const frames = Array.isArray(stack.callFrames) ? stack.callFrames : [];
    const frame = frames.length > 0 && frames[0] !== null && typeof frames[0] === 'object'
      ? /** @type {Record<string, unknown>} */ (frames[0])
      : {};
    const url = typeof frame.url === 'string' ? frame.url : '';
    const line = typeof frame.lineNumber === 'number' && Number.isFinite(frame.lineNumber) ? frame.lineNumber + 1 : 0;
    this._push({ type: normalizeConsoleType(record.type), text, url, line });
  }

  /**
   * 压入一条记录，超出缓冲上限时淘汰最旧的一条。
   *
   * @param {{ type: string, text: string, url: string, line: number }} message - 记录。
   * @returns {void}
   */
  _push(message) {
    this.messages.push(message);
    if (this.messages.length > this.bufferSize) {
      this.messages.splice(0, this.messages.length - this.bufferSize);
    }
  }
}

/**
 * 网络请求环形缓冲，按 `requestId` 合并同一请求的多个生命周期事件。
 *
 * 一个请求至少会来 `requestWillBeSent`，通常还有 `responseReceived`，失败时是
 * `loadingFailed`。三种事件都带着同一个 `requestId`，所以用 Map 合并；Map 的插入
 * 顺序在覆盖已有 key 时不变，因此列表顺序仍是「请求发起顺序」。
 */
export class NetworkRegistry {
  /**
   * @param {object} session - `TargetSession`（只需要 `on(event, listener)`）。
   * @param {{ bufferSize?: number }} [options] - 缓冲上限，默认 200。
   */
  constructor(session, options = {}) {
    /** @type {object} */
    this.session = session;
    /** 缓冲上限（契约 §3.6 默认 200）。 */
    this.bufferSize = clampInt(options.bufferSize, DEFAULT_BUFFER_SIZE, 1, 1000);
    /** @type {Map<string, { url: string, method: string, status: number, resourceType: string, mimeType: string, failed: boolean, errorText: string }>} */
    this.requests = new Map();
    /** @type {(() => void)[]} */
    this._unsubscribers = [];
    this._started = false;
  }

  /** 是否已挂上监听。 */
  get started() {
    return this._started;
  }

  /**
   * 开始监听 `Network.requestWillBeSent` / `responseReceived` / `loadingFailed`。
   *
   * 幂等；`Network.enable` 由调用方负责。
   *
   * @returns {this} 便于链式调用。
   */
  start() {
    if (this._started) return this;
    this._started = true;
    if (this.session === null || typeof this.session !== 'object') return this;
    if (typeof this.session.on === 'function') {
      this._unsubscribers.push(
        this.session.on('Network.requestWillBeSent', (payload) => {
          this._onRequest(payload);
        }),
      );
      this._unsubscribers.push(
        this.session.on('Network.responseReceived', (payload) => {
          this._onResponse(payload);
        }),
      );
      this._unsubscribers.push(
        this.session.on('Network.loadingFailed', (payload) => {
          this._onFailed(payload);
        }),
      );
    }
    return this;
  }

  /** 停止监听（已缓冲的请求保留）。 */
  stop() {
    for (const unsubscribe of this._unsubscribers.splice(0)) safeUnsubscribe(unsubscribe);
    this._started = false;
  }

  /**
   * 列出最近的请求。
   *
   * @param {{ limit?: number }} [options] - 条数上限（默认 50）。
   * @returns {{ url: string, method: string, status: number, resourceType: string, mimeType: string, failed: boolean, errorText: string }[]}
   *   按请求发起顺序，最多 limit 条。
   */
  list(options = {}) {
    const limit = clampInt(options.limit, 50, 0, this.bufferSize);
    const entries = [...this.requests.values()];
    const sliced = limit === 0 ? [] : entries.slice(Math.max(0, entries.length - limit));
    return sliced.map((entry) => ({ ...entry }));
  }

  /** 清空缓冲。 */
  clear() {
    this.requests.clear();
  }

  /**
   * 记录请求发起。
   *
   * @param {unknown} payload - CDP 事件 payload。
   * @returns {void}
   */
  _onRequest(payload) {
    const record = payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    if (requestId === '') return;
    const request = record.request !== null && typeof record.request === 'object'
      ? /** @type {Record<string, unknown>} */ (record.request)
      : {};
    this._set(requestId, {
      url: typeof request.url === 'string' ? request.url : '',
      method: typeof request.method === 'string' ? request.method : '',
      status: 0,
      resourceType: typeof record.type === 'string' ? record.type : '',
      mimeType: '',
      failed: false,
      errorText: '',
    });
  }

  /**
   * 记录响应到达（覆盖同一 requestId 的 status / mimeType / resourceType）。
   *
   * @param {unknown} payload - CDP 事件 payload。
   * @returns {void}
   */
  _onResponse(payload) {
    const record = payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    if (requestId === '') return;
    const response = record.response !== null && typeof record.response === 'object'
      ? /** @type {Record<string, unknown>} */ (record.response)
      : {};
    const existing = this.requests.get(requestId);
    const status = typeof response.status === 'number' && Number.isFinite(response.status) ? response.status : 0;
    this._set(requestId, {
      url: typeof response.url === 'string' && response.url !== '' ? response.url : (existing?.url ?? ''),
      method: existing?.method ?? '',
      status,
      resourceType: typeof record.type === 'string' && record.type !== '' ? record.type : (existing?.resourceType ?? ''),
      mimeType: typeof response.mimeType === 'string' ? response.mimeType : (existing?.mimeType ?? ''),
      failed: existing?.failed === true,
      errorText: existing?.errorText ?? '',
    });
  }

  /**
   * 记录请求失败。
   *
   * @param {unknown} payload - CDP 事件 payload。
   * @returns {void}
   */
  _onFailed(payload) {
    const record = payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    if (requestId === '') return;
    const existing = this.requests.get(requestId) ?? {
      url: '',
      method: '',
      status: 0,
      resourceType: '',
      mimeType: '',
      failed: false,
      errorText: '',
    };
    const errorText = typeof record.errorText === 'string' && record.errorText !== '' ? record.errorText : 'loading failed';
    this._set(requestId, { ...existing, failed: true, errorText });
  }

  /**
   * 写入/更新一条请求记录，超限时淘汰最旧（Map 的第一个 key）。
   *
   * @param {string} requestId - CDP 请求 id。
   * @param {{ url: string, method: string, status: number, resourceType: string, mimeType: string, failed: boolean, errorText: string }} entry - 记录。
   * @returns {void}
   */
  _set(requestId, entry) {
    this.requests.set(requestId, entry);
    if (this.requests.size > this.bufferSize) {
      const oldest = this.requests.keys().next();
      if (oldest.done !== true) this.requests.delete(oldest.value);
    }
  }
}
