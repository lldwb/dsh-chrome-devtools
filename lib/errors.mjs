/**
 * 稳定错误码与统一错误类型。
 *
 * 所有对外「操作失败」都抛 {@link BrowserError}，`code` 是稳定的、可被工具层与设置页
 * 直接展示的机器码。带 `toPublicError()` 是给 RPC / 工具返回值用的：它只暴露
 * `{ code, message, details }`，不泄漏 Error 的栈与内部字段。
 *
 * @module lib/errors
 */

/**
 * 稳定错误码。新增码要同步 docs/CONTRACT.md 与 README。
 *
 * 错误码是用户可见的稳定契约：设置页与工具返回值都会原样展示，改动即破坏性变更。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_CODES = Object.freeze({
  /** 未知/非法的连接方案 id。 */
  SCHEME_UNKNOWN: 'SCHEME_UNKNOWN',
  /** 找不到 Chrome 可执行文件。 */
  CHROME_NOT_FOUND: 'CHROME_NOT_FOUND',
  /** 连接 CDP / 启动浏览器失败。 */
  CONNECT_FAILED: 'CONNECT_FAILED',
  /** 需要浏览器连接但当前没有。 */
  NOT_CONNECTED: 'NOT_CONNECTED',
  /** 目标（tab / 元素 / selector）不存在。 */
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  /** 操作超时（连接、send、等待事件）。 */
  TIMEOUT: 'TIMEOUT',
  /** CDP 返回了 error 响应。 */
  CDP_ERROR: 'CDP_ERROR',
  /** 协议层问题（非法消息、帧错误、意外状态）。 */
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  /** 调用参数非法。 */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** 找不到可用的调试端点（DevToolsActivePort 缺失等）。 */
  NO_DEBUG_ENDPOINT: 'NO_DEBUG_ENDPOINT',
  /** 未归类错误（toPublicError 的兜底码，不在契约枚举里）。 */
  UNKNOWN: 'UNKNOWN',
});

/** 便捷导出：`SCHEME_UNKNOWN` 的独立常量形式。 */
export const SCHEME_UNKNOWN = ERROR_CODES.SCHEME_UNKNOWN;

/**
 * 插件统一错误类型。
 *
 * @example
 * throw new BrowserError('CONNECT_FAILED', '连不上 ws://127.0.0.1:9222', { wsUrl: 'ws://127.0.0.1:9222' });
 */
export class BrowserError extends Error {
  /**
   * @param {string} code - 见 {@link ERROR_CODES}；未知值也允许（原样传出）。
   * @param {string} message - 面向模型/用户的中文或英文一句话说明。
   * @param {object} [details] - 结构化补充信息；会被 toPublicError 原样带出，**不要放密码**。
   */
  constructor(code, message, details = {}) {
    super(typeof message === 'string' ? message : String(message));
    this.name = 'BrowserError';
    this.code = typeof code === 'string' && code !== '' ? code : ERROR_CODES.UNKNOWN;
    this.details = details !== null && typeof details === 'object' ? details : {};
    // 兼容 ES2022 之前的 Error 子类：保留正确的原型链。
    if (Error.captureStackTrace !== undefined) Error.captureStackTrace(this, BrowserError);
  }

  /**
   * 供日志/序列化使用的紧凑表示。
   *
   * @returns {{ code: string, message: string, details: object }}
   */
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * 把任意异常归一成 `{ code, message, details }`，供 RPC 响应与工具输出使用。
 *
 * - `BrowserError` 原样展开；
 * - 普通 `Error` 的 `code` 若是已知错误码字符串则沿用（例如 node 的 `ENOENT` 不会命中），
 *   否则归为 `UNKNOWN`；
 * - 其它（字符串、undefined、对象）也给出可读 message，保证返回值永远有结构。
 *
 * @param {unknown} error
 * @returns {{ code: string, message: string, details: object }}
 */
export function toPublicError(error) {
  if (error instanceof BrowserError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    const known = typeof /** @type {{ code?: unknown }} */ (error).code === 'string' && error.code !== '';
    return {
      code: known ? String(error.code) : ERROR_CODES.UNKNOWN,
      message: typeof error.message === 'string' && error.message !== '' ? error.message : String(error.name ?? 'Error'),
      details: {},
    };
  }
  if (typeof error === 'string') {
    return { code: ERROR_CODES.UNKNOWN, message: error, details: {} };
  }
  if (error === null || error === undefined) {
    return { code: ERROR_CODES.UNKNOWN, message: '未知错误', details: {} };
  }
  let message;
  try {
    message = JSON.stringify(error);
  } catch {
    message = String(error);
  }
  return { code: ERROR_CODES.UNKNOWN, message, details: {} };
}

/**
 * 是否是 `BrowserError`（跨模块比较 `instanceof` 在单包内可靠，这里额外兜底 name）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBrowserError(value) {
  return value instanceof BrowserError || (value !== null && typeof value === 'object' && /** @type {any} */ (value).name === 'BrowserError');
}
