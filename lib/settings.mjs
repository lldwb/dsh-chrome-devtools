/**
 * `dsh-chrome-devtools` —— 设置页 RPC（Host 半）。
 *
 * 浏览器半（`client.js`）通过 DSH 的 Connection RPC 通道 `/dsh-chrome-devtools`
 * 调用这里：
 *
 * - `status`：当前连接状态 + 浏览器版本 + 已落盘的配置方案（给状态区轮询）；
 * - `probe`：四个方案在当前配置下的可用性探测结果（不建立连接）；
 * - `connect`：按（可选）指定方案建立连接，「测试连接 / 应用」按钮走它；
 * - `disconnect`：断开连接，可选关闭本插件启动的 Chrome；
 * - `openBrowserPage`：在已连接的浏览器里打开一个新标签页（确认连接可用）。
 *
 * handler 返回连接信封要求的形状：`{ ok: true, value }` 或
 * `{ ok: false, error: { code, message, details } }`，`details` 必须是对象。
 *
 * 传输层不从 `ctx.connection.rpc.handle()` 走：它注册时会在调用方 fiber 上访问
 * `webServer`，调用方没有同时 inject `webServer` 时这次属性访问抛错，表现为客户端
 * 拿 **HTTP 405**。这里照 `dsh-webdav-sync` 已验证的写法：显式注册 prefix 路由，
 * 复用 Connection 的公开认证入口 `admit()`，请求/响应信封与官方 RPC carrier 一致。
 *
 * @module chrome-devtools/settings
 */

import { SCHEME_IDS, SCHEME_OPTIONS, resolveOptions, schemeLabel } from './config.mjs';
import { ERROR_CODES, toPublicError } from './errors.mjs';

/** 浏览器半调用本插件动作的 Connection RPC 通道。 */
export const RPC_CHANNEL = '/dsh-chrome-devtools';

/** 支持的端点（顺序即文档顺序）。 */
export const ENDPOINTS = Object.freeze(['status', 'probe', 'connect', 'disconnect', 'openBrowserPage']);

/** RPC 请求体上限：动作请求只是几个 JSON 字段，64 KiB 足够。 */
const MAX_RPC_BODY_BYTES = 64 * 1024;

/** 成功信封。 */
function ok(value) {
  return { ok: true, value };
}

/** 失败信封：`details` 必须是对象，这是 Connection 客户端的硬要求。 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/**
 * 把 WS URL 里的内嵌凭据（`ws://user:pass@host`）打码。
 *
 * 方案 D 允许用 URL 内嵌凭据做 Basic 认证；状态区与错误信息里不能把密码原样回显。
 *
 * @param {unknown} url 原始 URL。
 * @returns {string} 打码后的 URL；非字符串返回空串。
 */
export function maskUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  return url.replace(/\/\/[^/@\s]+@/u, '//***@');
}

/**
 * 探测方案在「当前配置」下是否可用。
 *
 * 优先用调用方注入的 `probeAll`（测试用），否则动态取 `lib/schemes.mjs` 的
 * `probeAllSchemes`。动态导入而不是静态 import：`lib/schemes.mjs` 由 T1 并行
 * 编写，缺失时设置页的 status/probe 仍要能给出一份「全部不可用」的降级结果，
 * 而不是让整个设置层加载失败。
 *
 * @returns {Promise<((config: object, currentScheme: string) => Promise<unknown>) | undefined>}
 */
async function loadProbeAll() {
  try {
    const module = await import('./schemes.mjs');
    return typeof module.probeAllSchemes === 'function' ? module.probeAllSchemes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把探测结果规整成界面可直接渲染的数组。
 *
 * `probeAllSchemes` 的契约返回 `[{ id, label, available, detail, isCurrent }]`；
 * 这里补齐缺失字段、按 `SCHEME_OPTIONS` 的顺序输出，未知项丢弃。拿不到探测实现时
 * 返回四个「不可用」项并说明原因，界面据此显示「探测不可用」。
 *
 * @param {unknown} list 探测结果（可能 undefined / 非法）。
 * @param {string} currentScheme 当前方案 id。
 * @returns {Array<{ id: string, label: string, labelEn: string, available: boolean, detail: string, isCurrent: boolean }>}
 */
export function normalizeProbeList(list, currentScheme) {
  const byId = new Map();
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const id = /** @type {{ id?: unknown }} */ (item).id;
      if (typeof id !== 'string') continue;
      byId.set(id, item);
    }
  }
  return SCHEME_OPTIONS.map((option) => {
    const item = byId.get(option.id);
    if (item === undefined) {
      return {
        id: option.id,
        label: option.label,
        labelEn: option.labelEn,
        available: false,
        detail: '探测不可用（未取得 probeScheme 实现）',
        isCurrent: option.id === currentScheme,
      };
    }
    const detail = /** @type {{ detail?: unknown }} */ (item).detail;
    const label = /** @type {{ label?: unknown }} */ (item).label;
    return {
      id: option.id,
      label: typeof label === 'string' && label.length > 0 ? label : option.label,
      labelEn: option.labelEn,
      available: /** @type {{ available?: unknown }} */ (item).available === true,
      detail: typeof detail === 'string' ? detail : '',
      isCurrent: option.id === currentScheme,
    };
  });
}

/**
 * 从 manager 读一份状态快照，补齐界面需要的展示字段。
 *
 * @param {object} manager BrowserManager（或测试里的假对象）。
 * @param {object} options `resolveOptions` 的结果。
 * @returns {Promise<object>} 状态值。
 */
async function buildStatus(manager, options) {
  const raw = typeof manager?.status === 'function' ? await manager.status() : undefined;
  const status = raw !== null && typeof raw === 'object' ? raw : {};
  const scheme = typeof status.scheme === 'string' && status.scheme.length > 0 ? status.scheme : options.scheme;
  return {
    connected: status.connected === true,
    scheme,
    schemeLabel: schemeLabel(scheme),
    wsUrl: maskUrl(status.wsUrl),
    browserVersion: typeof status.browserVersion === 'string' ? status.browserVersion : '',
    launchedPid: Number.isFinite(status.launchedPid) ? status.launchedPid : 0,
    launchedUserDataDir: typeof status.launchedUserDataDir === 'string' ? status.launchedUserDataDir : '',
    lastError: typeof status.lastError === 'string' ? status.lastError : '',
    pageCount: Number.isFinite(status.pageCount) ? status.pageCount : 0,
    // 「配置里选的方案」与「实际连接的方案」可能短暂不同（例如连接失败后回落），
    // 页面据此提示用户重新应用配置。
    configScheme: options.scheme,
    configSchemeLabel: schemeLabel(options.scheme),
    toolset: options.toolset,
  };
}

/**
 * 构造 Connection RPC handler。
 *
 * @param {object} ctx Cordis 上下文（只用于日志，可为 undefined）。
 * @param {object} config 行配置（每一次调用都现读，保证表单保存后立即生效）。
 * @param {object} manager BrowserManager（或测试里的假对象）。
 * @param {{ probeAll?: Function | null }} [deps] 测试注入点：`probeAll` 提供时优先使用；
 *   显式传 `null` 表示强制走降级列表。生产代码不传。
 * @returns {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<object>}
 */
export function createRpcHandler(ctx, config, manager, deps = {}) {
  /** 串行锁：connect / disconnect / openBrowserPage / probe 互斥，避免两次连接交错。 */
  const lock = { busy: false };

  /**
   * 执行一个会改变状态或做 IO 的动作，期间其它动作返回 BUSY。
   *
   * 动作内部可以直接返回失败信封（例如参数校验不过）：这种信封原样透传，不能再
   * 包一层 `ok()`，否则客户端会把失败读成成功。
   *
   * @param {() => Promise<unknown>} operation 动作。
   * @returns {Promise<object>} 信封。
   */
  const guard = async (operation) => {
    if (lock.busy) return fail('BUSY', '另一个浏览器操作正在进行，请稍后再试');
    lock.busy = true;
    try {
      const result = await operation();
      if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') return result;
      return ok(result);
    } finally {
      lock.busy = false;
    }
  };

  return async (endpoint, payload, signal) => {
    if (signal?.aborted === true) return fail('ABORTED', '请求已取消');
    const name = typeof endpoint === 'string' ? endpoint : '';
    if (name.length === 0) return fail('UNKNOWN_ENDPOINT', '缺少 RPC 端点名');
    try {
      const options = resolveOptions(config);
      switch (name) {
        case 'status':
          return ok(await buildStatus(manager, options));
        case 'probe':
          return await guard(async () => {
            const requested = /** @type {{ scheme?: unknown }} */ (payload)?.scheme;
            const currentScheme = SCHEME_IDS.includes(requested) ? requested : options.scheme;
            const probeAll = deps.probeAll === null ? undefined : (deps.probeAll ?? (await loadProbeAll()));
            let list;
            if (typeof probeAll === 'function') {
              try {
                list = await probeAll({ ...options, scheme: currentScheme }, currentScheme);
              } catch (error) {
                // 单次探测失败不该让整个 probe 端点失败：降级为「不可用」列表，
                // 并把原因写进 detail，界面能显示给用户。
                const publicError = toPublicError(error);
                list = SCHEME_OPTIONS.map((option) => ({
                  id: option.id,
                  label: option.label,
                  labelEn: option.labelEn,
                  available: false,
                  detail: publicError.message,
                }));
              }
            }
            return {
              currentScheme,
              currentSchemeLabel: schemeLabel(currentScheme),
              schemes: normalizeProbeList(list, currentScheme),
            };
          });
        case 'connect':
          return await guard(async () => {
            const requested = /** @type {{ scheme?: unknown }} */ (payload)?.scheme;
            if (requested !== undefined && !SCHEME_IDS.includes(requested)) {
              return fail(ERROR_CODES.SCHEME_UNKNOWN, `未知的连接方案: ${String(requested)}`, {
                allowed: [...SCHEME_IDS],
              });
            }
            const scheme = requested === undefined ? options.scheme : requested;
            if (typeof manager?.connect !== 'function') {
              return fail('NOT_AVAILABLE', '连接管理器不可用（Host 半未初始化）');
            }
            const result = await manager.connect({ scheme });
            const value = result !== null && typeof result === 'object' ? result : {};
            return {
              connected: true,
              scheme: typeof value.scheme === 'string' ? value.scheme : scheme,
              schemeLabel: schemeLabel(typeof value.scheme === 'string' ? value.scheme : scheme),
              wsUrl: maskUrl(value.wsUrl),
              browserVersion: typeof value.browserVersion === 'string' ? value.browserVersion : '',
              reused: value.reused === true,
              launchedPid: Number.isFinite(value.launchedPid) ? value.launchedPid : 0,
            };
          });
        case 'disconnect':
          return await guard(async () => {
            const closeBrowser = /** @type {{ closeBrowser?: unknown }} */ (payload)?.closeBrowser === true;
            const result =
              typeof manager?.disconnect === 'function' ? await manager.disconnect({ closeBrowser }) : undefined;
            const value = result !== null && typeof result === 'object' ? result : {};
            return {
              disconnected: true,
              closedOwnedBrowser: value.closedOwnedBrowser === true,
            };
          });
        case 'openBrowserPage':
          return await guard(async () => {
            const rawUrl = /** @type {{ url?: unknown }} */ (payload)?.url;
            const url = typeof rawUrl === 'string' && rawUrl.trim().length > 0 ? rawUrl.trim() : 'about:blank';
            if (typeof manager?.browser !== 'function') {
              return fail('NOT_AVAILABLE', '连接管理器不可用（Host 半未初始化）');
            }
            const browser = await manager.browser();
            if (typeof browser?.createTarget !== 'function') {
              return fail('NOT_AVAILABLE', '浏览器连接没有 createTarget 能力');
            }
            const target = await browser.createTarget(url);
            const targetId = target !== null && typeof target === 'object' ? target.targetId : undefined;
            return {
              targetId: typeof targetId === 'string' ? targetId : '',
              url,
            };
          });
        default:
          return fail('UNKNOWN_ENDPOINT', `未知的设置页端点: ${name}`, { allowed: [...ENDPOINTS] });
      }
    } catch (error) {
      const publicError = toPublicError(error);
      try {
        ctx?.logger?.warn?.(`[chrome-devtools] 设置页 ${name} 失败: ${publicError.code}: ${publicError.message}`);
      } catch {
        // 日志失败不能吞掉真正的错误响应。
      }
      return fail(publicError.code, publicError.message, publicError.details);
    }
  };
}

/**
 * 在 Host 的 web server 上注册浏览器半使用的 RPC 通道。
 *
 * 为什么不用 `ctx.connection.rpc.handle()`：它注册时执行
 * `owner.effect(() => owner.webServer.register(route))`，其中 owner 是调用方
 * fiber 的 ctx；调用方没有同时 inject `webServer` 时，这次属性访问会抛
 * `"cannot get property \"webServer\" without inject"`，表现为客户端拿到
 * **HTTP 405**（请求落到 SPA fallback）。这里显式注册 prefix 路由，并复用
 * Connection 的公开认证入口 `admit()`，请求/响应信封与官方 RPC carrier 一致。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} config 行配置。
 * @param {object} runtime BrowserManager（契约 §3.10 的 `runtime`）。
 * @returns {void}
 */
export function installRpcChannel(ctx, config, runtime) {
  const handler = createRpcHandler(ctx, config, runtime);
  ctx.inject?.(['connection', 'webServer'], (rpcCtx) => {
    rpcCtx.effect(() => {
      const connection = rpcCtx.connection;
      const webServer = rpcCtx.webServer;
      if (connection === undefined || connection === null || webServer === undefined || webServer === null) {
        ctx.logger?.debug?.('[chrome-devtools] connection 或 webServer 服务不可用，跳过 RPC 通道注册');
        return () => {};
      }
      try {
        const dispose = webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: async (req, res) => {
            let admission;
            try {
              admission = connection.admit(req);
            } catch (error) {
              res.writeHead(500);
              res.end(`admission failed: ${String(error)}`);
              return;
            }
            if ('rejection' in admission) {
              res.writeHead(admission.rejection);
              res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(404);
              res.end('not found');
              return;
            }
            const chunks = [];
            try {
              for await (const chunk of req) chunks.push(chunk);
            } catch {
              res.writeHead(400);
              res.end('request body unreadable');
              return;
            }
            const raw = Buffer.concat(chunks);
            if (raw.length > MAX_RPC_BODY_BYTES) {
              res.writeHead(413);
              res.end('request body too large');
              return;
            }
            let request;
            try {
              request = JSON.parse(raw.toString('utf8'));
            } catch {
              res.writeHead(400);
              res.end('body is not JSON');
              return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const endpoint = url.pathname.startsWith(`${RPC_CHANNEL}/`)
              ? url.pathname.slice(RPC_CHANNEL.length + 1)
              : '';
            const controller = new AbortController();
            req.on('close', () => controller.abort());
            let result;
            try {
              result = await handler(
                String(request?.method ?? endpoint),
                request?.payload,
                controller.signal,
                admission.peer,
              );
            } catch (error) {
              res.writeHead(500);
              res.end(`handler failure: ${String(error)}`);
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'server-response', rpcId: request?.rpcId, result }));
          },
        });
        ctx.logger?.debug?.(`[chrome-devtools] 已注册 RPC prefix 路由 ${RPC_CHANNEL}`);
        return dispose;
      } catch (error) {
        ctx.logger?.warn?.(`[chrome-devtools] webServer.register 失败: ${error?.message ?? error}`);
        // 回退到官方通道（若该部署的 rpc.handle 可用）。
        try {
          return connection.rpc.handle(RPC_CHANNEL, handler);
        } catch (fallbackError) {
          ctx.logger?.warn?.(`[chrome-devtools] rpc.handle 回退也失败: ${fallbackError?.message ?? fallbackError}`);
          return () => {};
        }
      }
    }, 'chrome-devtools: rpc channel');
  });
}
