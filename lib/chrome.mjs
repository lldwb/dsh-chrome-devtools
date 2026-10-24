/**
 * Chrome 进程与调试端点的发现、启动、停止与探测。
 *
 * 这一层只关心「怎么找到/拉起/关掉一个 Chrome」以及「怎么读出它的 ws 端点」，
 * 不持有任何 CDP 连接（那是 {@link module:lib/cdp} 的事），也不读配置对象（那是
 * connection.mjs 的事）。
 *
 * 平台差异只体现在「可执行文件候选路径」和「默认 user data 目录」两个函数里，
 * 其余逻辑跨平台一致。
 *
 * @module lib/chrome
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserError, ERROR_CODES } from './errors.mjs';

/** 支持的 Chrome 渠道，顺序即探测优先级的默认顺序。 @type {readonly string[]} */
export const CHANNELS = Object.freeze(['stable', 'beta', 'dev', 'canary']);

/** 默认调试端口：只用于方案 C 的默认配置与 URL 归一化，方案 A 永远用 0 让 Chrome 自选。 */
export const DEFAULT_DEBUG_PORT = 9222;

/** 运行平台，单独抽出来便于测试时替换。 */
const BROWSER_PLATFORM = process.platform;

/**
 * 各渠道在各平台的目录名（用于拼 user data 目录与安装路径）。
 *
 * @type {Readonly<Record<string, { win: string, mac: string, linux: string }>>}
 */
const CHANNEL_DIRS = Object.freeze({
  stable: { win: 'Chrome', mac: 'Chrome', linux: 'google-chrome' },
  beta: { win: 'Chrome Beta', mac: 'Chrome Beta', linux: 'google-chrome-beta' },
  dev: { win: 'Chrome Dev', mac: 'Chrome Dev', linux: 'google-chrome-unstable' },
  canary: { win: 'Chrome SxS', mac: 'Chrome Canary', linux: 'google-chrome-canary' },
});

/** 把任意输入收敛成合法渠道名（未知一律 stable）。 */
function normalizeChannel(channel) {
  const value = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  return CHANNELS.includes(value) ? value : 'stable';
}

/** Windows 上可能存在的安装根目录（Program Files 等），按 64 位优先。 */
function windowsInstallRoots() {
  const roots = [];
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const programW6432 = process.env.ProgramW6432;
  const localAppData = process.env.LOCALAPPDATA;
  if (programFiles !== undefined && programFiles !== '') roots.push(programFiles);
  if (programW6432 !== undefined && programW6432 !== '') roots.push(programW6432);
  if (programFilesX86 !== undefined && programFilesX86 !== '') roots.push(programFilesX86);
  if (localAppData !== undefined && localAppData !== '') roots.push(localAppData);
  return roots;
}

/**
 * 当前平台的 Chrome 候选安装路径，按探测优先级排序。
 *
 * 顺序：当前 channel 的标准安装位置 → stable 的标准位置（用户装了 beta 但没装 stable
 * 时也能用）→ 常见发行版/第三方位置。
 *
 * @param {string} [channel='stable']
 * @returns {string[]} 绝对路径数组（可能不存在）
 */
export function chromeCandidatePaths(channel = 'stable') {
  const stable = normalizeChannel(channel);
  const paths = [];
  const push = (value) => {
    if (value !== undefined && value !== '' && !paths.includes(value)) paths.push(value);
  };

  if (BROWSER_PLATFORM === 'win32') {
    const roots = windowsInstallRoots();
    const channelDirs = stable === 'stable' ? [] : [CHANNEL_DIRS[stable].win];
    for (const root of roots) {
      for (const dir of [...channelDirs, CHANNEL_DIRS.stable.win]) {
        push(path.join(root, 'Google', dir, 'Application', 'chrome.exe'));
      }
    }
    // Chromium / Edge 不在候选内：契约只承诺 Chrome 渠道。
  } else if (BROWSER_PLATFORM === 'darwin') {
    const apps = stable === 'stable' ? [] : [CHANNEL_DIRS[stable].mac];
    for (const appName of [...apps, CHANNEL_DIRS.stable.mac]) {
      push(`/Applications/Google ${appName}.app/Contents/MacOS/Google ${appName}`);
    }
  } else {
    const binaries = stable === 'stable' ? [] : [CHANNEL_DIRS[stable].linux];
    for (const bin of [...binaries, 'google-chrome-stable', 'google-chrome']) {
      push(`/usr/bin/${bin}`);
    }
    for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
      push(`/usr/bin/${bin}`);
    }
    push('/opt/google/chrome/chrome');
    push('/snap/bin/chromium');
  }
  return paths;
}

/** `fs.existsSync` 的安全包装：任何异常都当作不存在。 */
function exists(filePath) {
  try {
    return fsSync.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * 找 Chrome 可执行文件。
 *
 * 顺序：显式 `executablePath` → 当前平台的标准安装路径（当前 channel 优先，再 stable）。
 * 返回 `undefined` 表示没找到（纯探测语义，不抛错）。
 *
 * @param {{ executablePath?: string, channel?: string }} [options]
 * @returns {string | undefined}
 */
export function resolveChromeExecutable(options = {}) {
  const explicit = typeof options.executablePath === 'string' ? options.executablePath.trim() : '';
  if (explicit !== '') {
    const resolved = path.resolve(explicit);
    if (exists(resolved)) return resolved;
    // 显式路径不存在时继续探测平台默认安装位置：用户可能只是配置过时。
  }
  for (const candidate of chromeCandidatePaths(normalizeChannel(options.channel))) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 由 channel 推断用户默认 user data 目录（绝对路径）。
 *
 * 这是方案 B（auto-connect）读取 `DevToolsActivePort` 的位置，也是「用户当前正在用的
 * Chrome」的 profile 目录。
 *
 * @param {string} [channel='stable']
 * @returns {string}
 */
export function defaultUserDataDir(channel = 'stable') {
  const stable = normalizeChannel(channel);
  const dirs = CHANNEL_DIRS[stable];
  if (BROWSER_PLATFORM === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const base = localAppData !== undefined && localAppData !== ''
      ? localAppData
      : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Google', dirs.win, 'User Data');
  }
  if (BROWSER_PLATFORM === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', dirs.mac);
  }
  return path.join(os.homedir(), '.config', dirs.linux);
}

/**
 * 读 `<userDataDir>/DevToolsActivePort`。
 *
 * 文件由 Chrome 写出，两行：第一行端口，第二行是 ws 路径（不是完整 URL）。
 * 文件不存在、为空、格式损坏、端口非法都返回 `undefined`（不抛）。
 *
 * @param {string} userDataDir - Chrome profile 目录绝对路径。
 * @returns {{ port: number, wsPath: string, wsUrl: string } | undefined}
 */
export function readDevToolsActivePort(userDataDir) {
  if (typeof userDataDir !== 'string' || userDataDir.trim() === '') return undefined;
  let raw;
  try {
    raw = fsSync.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length < 2) return undefined;
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  let wsPath = lines[1];
  if (!wsPath.startsWith('/')) wsPath = `/${wsPath}`;
  if (!/^\/devtools\/browser\/\S+$/.test(wsPath)) return undefined;
  return { port, wsPath, wsUrl: `ws://127.0.0.1:${port}${wsPath}` };
}

/** 可中断的 sleep。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 把 `{ width, height }` 或 `'1280x800'` 归一成 spawn 参数用的 `W,H`。
 *
 * @param {{ width?: number, height?: number } | string | undefined} viewport
 * @returns {string | undefined}
 */
export function normalizeViewport(viewport) {
  if (viewport === undefined || viewport === null) return undefined;
  let width;
  let height;
  if (typeof viewport === 'string') {
    const match = /^\s*(\d{2,5})\s*[xX×,\s]\s*(\d{2,5})\s*$/.exec(viewport);
    if (match === null) return undefined;
    width = Number(match[1]);
    height = Number(match[2]);
  } else if (typeof viewport === 'object') {
    width = Number(/** @type {any} */ (viewport).width);
    height = Number(/** @type {any} */ (viewport).height);
  } else {
    return undefined;
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined;
  return `${width},${height}`;
}

/** 删除目录，容忍 Windows 上 Chrome 刚退出时的文件占用。 */
async function removeDirectory(dir) {
  if (typeof dir !== 'string' || dir === '') return;
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    // 清理失败不掩盖主流程的错误；临时目录残留在 os.tmpdir() 下由系统兜底。
  }
}

/**
 * 轮询等待 DevToolsActivePort，直到超时/进程退出/拿到端点。
 *
 * @param {object} state
 * @param {(state: object) => Error | undefined} state.failure
 * @returns {Promise<object>}
 */
async function waitForActivePort(state) {
  const { userDataDir, timeoutMs } = state;
  const deadline = Date.now() + timeoutMs;
  // 先做一次「进程是否已退出」的检查，避免启动即失败时白等满超时。
  for (;;) {
    const activePort = readDevToolsActivePort(userDataDir);
    if (activePort !== undefined) return activePort;
    const failure = state.failure();
    if (failure !== undefined) throw failure;
    if (Date.now() >= deadline) {
      throw new BrowserError(
        ERROR_CODES.TIMEOUT,
        `Chrome 已启动但 ${timeoutMs}ms 内没有写出 DevToolsActivePort（${userDataDir}）；` +
          '可能带上了 --remote-debugging-port 不支持的参数，或 Chrome 版本过旧。',
        { userDataDir, timeoutMs, executablePath: state.executablePath },
      );
    }
    await sleep(100);
  }
}

/** 用 stdio 忽略的方式跑一个外部命令，返回退出码（异常时返回 -1，不抛）。 */
async function runCommand(command, args) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(-1);
      return;
    }
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(typeof code === 'number' ? code : -1));
  });
}

/**
 * 结束本插件启动的 Chrome（按 pid）。
 *
 * - Windows：`taskkill /T /F`（连同 Chrome 的子进程树一起结束，否则 GPU/utility 子进程会残留）；
 * - 其它平台：先 SIGTERM，1.5s 内未退出再 SIGKILL。
 *
 * 进程已不存在时静默返回（幂等）。
 *
 * @param {number} pid
 * @returns {Promise<void>}
 */
export async function stopChrome(pid) {
  const numeric = typeof pid === 'number' ? pid : Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return;
  if (BROWSER_PLATFORM === 'win32') {
    await runCommand('taskkill', ['/PID', String(numeric), '/T', '/F']);
    return;
  }
  try {
    process.kill(numeric, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (!isProcessAlive(numeric)) return;
    await sleep(100);
  }
  try {
    process.kill(numeric, 'SIGKILL');
  } catch {
    // 已经退出：忽略。
  }
}

/** 进程是否还活着（signal 0 探测）。 */
export function isProcessAlive(pid) {
  const numeric = typeof pid === 'number' ? pid : Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但没有权限发信号——仍然算活着。
    return /** @type {any} */ (error)?.code === 'EPERM';
  }
}

/**
 * 启动一个全新的 Chrome（方案 A）。
 *
 * 固定用 `--remote-debugging-port=0` 让 Chrome 自选端口（不能硬编码 9222，会与
 * auto-connect 抢端口），然后轮询 `<userDataDir>/DevToolsActivePort` 拿真正的 ws 端点。
 * Chrome 136+ 禁止对默认 profile 开远程调试，所以**必须**传独立 `--user-data-dir`。
 *
 * @param {object} [options]
 * @param {string} [options.executablePath] - 显式 Chrome 路径；空则自动探测。
 * @param {string} [options.channel] - Chrome 渠道，默认 stable。
 * @param {boolean} [options.headless] - 是否 `--headless=new`。
 * @param {string} [options.userDataDir] - 显式 profile 目录；空则 mkdtemp('dsh-chrome-')。
 * @param {boolean} [options.isolated] - 退出时是否删除 profile 目录；临时目录默认 true，显式目录默认 false。
 * @param {{ width?: number, height?: number } | string} [options.viewport] - 窗口尺寸。
 * @param {string[]} [options.args] - 追加的 Chrome 命令行参数。
 * @param {number} [options.timeoutMs] - 等待 DevToolsActivePort 的上限，默认 15000。
 * @param {string} [options.url] - 启动后打开的 URL，默认 about:blank。
 * @returns {Promise<{ pid: number, port: number, wsUrl: string, userDataDir: string,
 *   executablePath: string, owned: true, isolated: boolean, channel: string, args: string[] }>}
 * @throws {BrowserError} `CHROME_NOT_FOUND` | `CONNECT_FAILED` | `TIMEOUT`
 */
export async function launchChrome(options = {}) {
  const channel = normalizeChannel(options.channel);
  const executablePath = resolveChromeExecutable({ executablePath: options.executablePath, channel });
  if (executablePath === undefined) {
    throw new BrowserError(
      ERROR_CODES.CHROME_NOT_FOUND,
      '找不到 Chrome 可执行文件。请在设置里填写 executablePath，或安装稳定版 Chrome。',
      {
        channel,
        explicitPath: typeof options.executablePath === 'string' ? options.executablePath : '',
        candidates: chromeCandidatePaths(channel),
      },
    );
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
  const explicitUserDataDir = typeof options.userDataDir === 'string' && options.userDataDir.trim() !== '';
  const temporaryProfile = !explicitUserDataDir;
  let userDataDir;
  try {
    userDataDir = temporaryProfile
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-'))
      : path.resolve(/** @type {string} */ (options.userDataDir));
  } catch (error) {
    throw new BrowserError(
      ERROR_CODES.CONNECT_FAILED,
      `无法创建临时 profile 目录：${/** @type {Error} */ (error).message}`,
      { temporaryProfile },
    );
  }
  // 显式给了 profile 目录时默认不删（尊重用户数据）；临时目录默认删。
  const isolated = options.isolated === true || (temporaryProfile && options.isolated !== false);

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
  ];
  if (options.headless === true) args.push('--headless=new');
  const windowSize = normalizeViewport(options.viewport);
  if (windowSize !== undefined) args.push(`--window-size=${windowSize}`);
  if (Array.isArray(options.args)) {
    for (const extra of options.args) {
      if (typeof extra === 'string' && extra.trim() !== '') args.push(extra);
    }
  }
  const startUrl = typeof options.url === 'string' && options.url.trim() !== '' ? options.url : 'about:blank';
  args.push(startUrl);

  /** @type {{ code: number | null, signal: NodeJS.Signals | null } | undefined} */
  let exitInfo;
  /** @type {Error | undefined} */
  let spawnError;
  let child;
  try {
    // `windowsHide: true` 在 Windows 上会让 Chrome 继承「隐藏窗口」的启动信息：主窗口依然
    // 会被创建（hwnd 存在、标题 "about:blank - Google Chrome"、尺寸也对），但 IsWindowVisible
    // 为 false —— 用户看到的是屏幕上一块白色残影，以为启动了个坏窗口。实测对比：
    //   windowsHide=true  → visible=False
    //   windowsHide=false → visible=True
    // 有头模式必须可见；headless 模式本身不建窗口，与这个选项无关。stdio 已经是 ignore，
    // 不需要靠它隐藏控制台窗口。
    child = spawn(executablePath, args, { stdio: 'ignore', windowsHide: false });
  } catch (error) {
    await removeDirectory(temporaryProfile ? userDataDir : undefined);
    throw new BrowserError(
      ERROR_CODES.CONNECT_FAILED,
      `启动 Chrome 失败：${/** @type {Error} */ (error).message}`,
      { executablePath, userDataDir },
    );
  }
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const state = {
    userDataDir,
    timeoutMs,
    executablePath,
    failure() {
      if (spawnError !== undefined) {
        return new BrowserError(
          ERROR_CODES.CHROME_NOT_FOUND,
          `启动 Chrome 失败：${spawnError.message}`,
          { executablePath },
        );
      }
      if (exitInfo !== undefined) {
        // 给「已经写出 DevToolsActivePort 之后主进程才退出」留一个竞态窗口：下一次循环会先读文件。
        return new BrowserError(
          ERROR_CODES.CONNECT_FAILED,
          `Chrome 启动后立即退出（exit code ${String(exitInfo.code)}${exitInfo.signal === null ? '' : `, signal ${exitInfo.signal}`}）。` +
            '常见原因：显式 userDataDir 已被另一个 Chrome 实例占用，或 --remote-debugging-port 被策略禁用。',
          { executablePath, userDataDir, exitCode: exitInfo.code, signal: exitInfo.signal },
        );
      }
      return undefined;
    },
  };

  try {
    const activePort = await waitForActivePort(state);
    return {
      pid: typeof child.pid === 'number' ? child.pid : 0,
      port: activePort.port,
      wsUrl: activePort.wsUrl,
      userDataDir,
      executablePath,
      owned: true,
      isolated,
      channel,
      args,
    };
  } catch (error) {
    if (typeof child.pid === 'number' && exitInfo === undefined) {
      await stopChrome(child.pid);
    }
    if (temporaryProfile) await removeDirectory(userDataDir);
    throw error;
  }
}

/**
 * 探测 `http://host:port/json/version`。
 *
 * 只有方案 C（browser-url）依赖这个 HTTP 路由；方案 B 的 auto-connect 端口上这些
 * JSON 路由全部 404，所以**不能**用它判断 auto-connect 是否可用。
 *
 * @param {string} browserUrl - 形如 `http://127.0.0.1:9222`。
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{ browser: string, webSocketDebuggerUrl: string, protocolVersion: string } | undefined>}
 *   成功返回归一化字段，失败返回 undefined（不抛）。
 */
export async function probeBrowserUrl(browserUrl, timeoutMs = 5000) {
  const base = normalizeBrowserUrl(browserUrl);
  if (base === undefined) return undefined;
  const budget = Number.isFinite(timeoutMs) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
  try {
    const response = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(budget),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    if (payload === null || typeof payload !== 'object') return undefined;
    const record = /** @type {Record<string, unknown>} */ (payload);
    return {
      browser: typeof record.Browser === 'string' ? record.Browser : '',
      webSocketDebuggerUrl: typeof record.webSocketDebuggerUrl === 'string' ? record.webSocketDebuggerUrl : '',
      protocolVersion: typeof record['Protocol-Version'] === 'string' ? record['Protocol-Version'] : '',
    };
  } catch {
    return undefined;
  }
}

/**
 * 把 `'http://127.0.0.1:9222'` / `'127.0.0.1:9222'` / `'9222'` 归一成完整 HTTP URL。
 *
 * 规则：
 * - 纯数字当作端口，host 补 127.0.0.1；
 * - 缺协议补 `http://`；
 * - 只保留 origin（Chrome 调试端点没有 base path），缺端口补 9222；
 * - host 必须是 IPv4 / IPv6 / `localhost` / 含点的域名（`abc` 这种输入视为非法）；
 * - 只接受 http/https；`ws://` 属于方案 D，这里视为非法（返回 undefined）。
 *
 * 注意 URL 里若带 `user:pass@` 会被丢弃——Chrome 的调试端点不支持 Basic 认证，
 * 方案 D 的鉴权请见 lib/cdp.mjs 的说明。
 *
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function normalizeBrowserUrl(raw) {
  if (typeof raw !== 'string') return undefined;
  let candidate = raw.trim();
  if (candidate === '') return undefined;
  if (/^\d{1,5}$/.test(candidate)) candidate = `127.0.0.1:${candidate}`;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) candidate = `http://${candidate}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.hostname === '') return undefined;
  if (!isPlausibleDebugHost(url.hostname)) return undefined;
  const port = url.port === '' ? String(DEFAULT_DEBUG_PORT) : url.port;
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) return undefined;
  return `${url.protocol}//${url.hostname}:${port}`;
}

/** host 是否像调试端点：IPv4 / 带括号的 IPv6 / localhost / 含点的域名。 */
function isPlausibleDebugHost(hostname) {
  if (hostname === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) <= 255);
  }
  if (/^\[[0-9a-fA-F:.]+\]$/.test(hostname)) return true;
  return hostname.includes('.');
}

/**
 * 把 URL 里的凭据（`user:pass@`、token 类 query）脱敏，用于日志与工具输出。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function redactUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') {
      url.username = url.username === '' ? '' : '***';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|pass|auth/i.test(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch {
    // 不是合法 URL（例如空串或纯路径）：只做粗略的 userinfo 掩码。
    return raw.replace(/\/\/[^/@\s]+@/g, '//***@');
  }
}
