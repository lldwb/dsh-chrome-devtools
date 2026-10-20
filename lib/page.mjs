/**
 * 页面语义层：把「selector + 动作」翻译成 CDP 原语。
 *
 * ## 设计要点
 *
 * 1. **只用 CDP 原语**。元素定位 = `Runtime.evaluate` + `getBoundingClientRect`；
 *    点击 = `Input.dispatchMouseEvent` 打到元素中心坐标（对 React/Vue 的事件委托更真实，
 *    比 `element.click()` 可靠）；填值 = native setter + `input`/`change` 事件（受控组件
 *    才真的生效）；输入 = `Input.insertText`；按键 = `Input.dispatchKeyEvent`。
 * 2. **浏览器端脚本是「自包含函数 + 纯函数 helper 内联」**。`cssPathFromParts`、
 *    `isVisibleBox`、`describeElementLine` 这些纯逻辑在 Node 里可以直接单测，注入浏览器
 *    时通过 `Function.prototype.toString()` 内联成**同一份实现**——不会出现「测试里的
 *    算法和页面里跑的算法不一致」这种假绿。
 * 3. **每条 evaluate 表达式都带一个 `/* dsh-cdp:<name> *​/` 注释标记**。浏览器忽略注释，
 *    而假 session 可以按标记返回结构化结果，于是 PageHandle 的全部动作都能在不启动
 *    Chrome 的单测里验证。
 * 4. **截图默认目录是 `$DSH_HOME/chrome-devtools/screenshots`**，可被 config 的
 *    `screenshotDir` 覆盖（覆盖由工具层传入 `path` 完成）；目录不存在会递归创建。
 *
 * ## 已知限制（写进 README / 简报）
 *
 * - 元素定位只覆盖主 frame：不进入 iframe / shadow DOM。selector 命中的是主文档。
 * - `snapshot` 只列出「可见」的可交互元素；`<option>` 这类零尺寸元素会被过滤。
 * - `drag` 用鼠标事件模拟拖拽；HTML5 原生 DnD（`DataTransfer` 拖放区）不一定触发。
 * - `setFiles` 用 `DOM.setFileInputFiles`，要求选择器指向 `<input type="file">`。
 *
 * @module lib/page
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserError, ERROR_CODES } from './errors.mjs';
import { ConsoleRegistry, NetworkRegistry } from './observe.mjs';

/** 快照默认字符上限（契约 §3.6 的 `maxChars`）。 */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 12_000;

/** 快照识别的「可见可交互元素」选择器（契约 §3.6）。 */
export const INTERACTIVE_SELECTOR =
  'a,button,input,textarea,select,option,[role],[contenteditable],[onclick],summary,label';

/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 100;

/** 等待「网络空闲」的静默窗口（毫秒）。 */
const NETWORK_IDLE_WINDOW_MS = 500;

/**
 * evaluate 表达式的注释标记。
 *
 * 浏览器把 `/* … *​/` 当普通注释忽略；单测的假 session 用它区分「这个表达式是
 * locate / fill / snapshot / …」，从而返回对应形状的结果。集中在这里定义，测试
 * 直接 import，避免字符串两边各写一份而漂移。
 */
export const EXPRESSION_MARKS = Object.freeze({
  locate: 'dsh-cdp:locate',
  pageInfo: 'dsh-cdp:page-info',
  fill: 'dsh-cdp:fill',
  focus: 'dsh-cdp:focus',
  snapshot: 'dsh-cdp:snapshot',
  waitSelector: 'dsh-cdp:wait-selector',
  waitText: 'dsh-cdp:wait-text',
  elementObject: 'dsh-cdp:element-object',
});

/**
 * 修饰键对应的 `Input.dispatchKeyEvent.modifiers` 位。
 *
 * CDP 的位定义：Alt=1、Control=2、Meta/Command=4、Shift=8。
 */
export const MODIFIER_BITS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });

/** 命名键映射：工具参数里的键名 → `{ key, code, vk, text? }`。 */
const NAMED_KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
});

/** 常用标点键（US 布局的虚拟键码）。 */
const PUNCTUATION_KEYS = Object.freeze({
  '.': { code: 'Period', vk: 190, text: '.' },
  ',': { code: 'Comma', vk: 188, text: ',' },
  ';': { code: 'Semicolon', vk: 186, text: ';' },
  "'": { code: 'Quote', vk: 222, text: "'" },
  '/': { code: 'Slash', vk: 191, text: '/' },
  '\\': { code: 'Backslash', vk: 220, text: '\\' },
  '-': { code: 'Minus', vk: 189, text: '-' },
  '=': { code: 'Equal', vk: 187, text: '=' },
  '[': { code: 'BracketLeft', vk: 219, text: '[' },
  ']': { code: 'BracketRight', vk: 221, text: ']' },
  '`': { code: 'Backquote', vk: 192, text: '`' },
});

/** 契约里的错误码集合；非此集合的错误码不原样外泄。 */
const KNOWN_CODES = new Set(Object.values(ERROR_CODES));

/** 空函数：用于吞掉不应影响主流程的异常。 */
function noop() {}

/** 毫秒级 sleep。 */
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 取消息文本，永不抛。 */
export function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message;
  if (error === null || error === undefined) return '未知错误';
  try {
    return String(error);
  } catch {
    return '未知错误';
  }
}

/**
 * 把任意异常归一成 {@link BrowserError}。
 *
 * 只沿用契约枚举里的 `code`（`ERROR_CODES`），像 `ENOENT` 这种 Node 错误码统一归为
 * `CDP_ERROR`——工具返回值是给模型看的，稳定错误码比底层 errno 有用。
 *
 * @param {unknown} error - 原始异常。
 * @param {string} [context] - 出错的 CDP 方法或动作名，放进 details。
 * @returns {InstanceType<typeof BrowserError>} 归一后的错误。
 */
export function asBrowserError(error, context = '') {
  if (error instanceof BrowserError) return error;
  const message = messageOf(error);
  const raw = error !== null && typeof error === 'object' ? /** @type {{ code?: unknown }} */ (error).code : undefined;
  const code = typeof raw === 'string' && KNOWN_CODES.has(raw) ? raw : 'CDP_ERROR';
  return new BrowserError(code, message, context === '' ? {} : { context });
}

/* ------------------------------------------------------------------ *
 * 纯函数：CSS path、可见性、文本、截图路径、PNG 尺寸、键盘映射
 * ------------------------------------------------------------------ */

/**
 * 合并空白并 trim。
 *
 * @param {unknown} value - 任意值。
 * @returns {string} 单行文本。
 */
export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * 按上限截断文本，并附上截断说明。
 *
 * @param {unknown} value - 原始文本。
 * @param {number} [maxChars] - 上限，默认 12000。
 * @returns {{ text: string, truncated: boolean }} 截断结果。
 */
export function truncateText(value, maxChars = DEFAULT_SNAPSHOT_MAX_CHARS) {
  const source = typeof value === 'string' ? value : String(value ?? '');
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : DEFAULT_SNAPSHOT_MAX_CHARS;
  if (source.length <= limit) return { text: source, truncated: false };
  return {
    text: `${source.slice(0, limit)}\n…（已截断：共 ${source.length} 字符，只显示前 ${limit} 字符）`,
    truncated: true,
  };
}

/**
 * 隐去 URL 里的密码（保留用户名），用于 status / config 这类会展示给模型的字段。
 *
 * @param {string} url - 原始 URL。
 * @returns {string} 脱敏后的 URL（无凭据时原样返回）。
 */
export function redactUrl(url) {
  if (typeof url !== 'string' || url === '') return '';
  return url.replace(/(\/\/)([^/@\s]+):([^@/\s]+)@/u, '$1$2:***@');
}

/**
 * 转义 CSS id 选择器里的标识符。
 *
 * 常规标识符（字母/下划线开头，只含字母数字 `_` `-`）原样返回；其它字符逐个反斜杠转义。
 * 以数字开头的 id 不用 `#` 形式（CSS 的 `#123` 非法），调用方会退回 `[id="…"]`。
 *
 * @param {string} value - 标识符。
 * @returns {string} 可直接拼进选择器的文本。
 */
export function cssEscapeIdent(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  return text.replace(/[^A-Za-z0-9_-]/gu, (character) => `\\${character}`);
}

/**
 * 由「祖先链步骤」生成稳定的 CSS path。
 *
 * 优先级（契约 §3.6）：`id` → `data-testid` → `name` → `tag:nth-of-type(n)` 链。
 * 找到锚点后只保留它**之后**的步骤——id 在文档内唯一，不需要祖先；这正是路径
 * 稳定、不会因为页面某处多了一个 div 而失效的原因。
 *
 * `steps` 从最外层（`html`）到目标元素。每步：
 * `{ tag, id?, testId?, name?, nth?, countOfType? }`，`nth` 是同类兄弟中的序号，
 * `countOfType` 是同类兄弟总数（为 1 时可以省略 `:nth-of-type`）。
 *
 * @example
 * cssPathFromParts([
 *   { tag: 'html' },
 *   { tag: 'body' },
 *   { tag: 'div', id: 'app' },
 *   { tag: 'button', nth: 2, countOfType: 3 },
 * ]); // => '#app > button:nth-of-type(2)'
 *
 * @param {Array<{ tag: string, id?: string, testId?: string, name?: string, nth?: number, countOfType?: number }>} steps
 *   祖先链步骤（含目标元素本身）。
 * @returns {string} CSS path；步骤为空或全部非法时返回空串。
 */
export function cssPathFromParts(steps) {
  // ⚠️ 这两个辅助函数**必须声明在函数体内**：cssPathFromParts 会被 `toString()` 内联
  // 进页面执行（browser_snapshot 的浏览器端脚本），内联后模块作用域不存在，引用模块级
  // 辅助函数会在页面里抛 ReferenceError（真实事故：normalizeStep 曾漏在模块级，单测
  // 因假 session 不执行内联脚本而全绿）。`inlineScriptCatalog()` + 自由变量审计测试锁住这一点。
  /** 转义属性选择器里的双引号与反斜杠。 */
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  }

  /** 把一步祖先信息补齐成稳定形状。 */
  function normalizeStep(step) {
    if (step === null || typeof step !== 'object') return undefined;
    const record = step;
    const tag = typeof record.tag === 'string' ? record.tag.trim().toLowerCase() : '';
    if (tag === '') return undefined;
    return {
      tag,
      id: typeof record.id === 'string' ? record.id : '',
      testId: typeof record.testId === 'string' ? record.testId : '',
      name: typeof record.name === 'string' ? record.name : '',
      nth: typeof record.nth === 'number' && Number.isFinite(record.nth) && record.nth > 0 ? Math.trunc(record.nth) : 1,
      countOfType:
        typeof record.countOfType === 'number' && Number.isFinite(record.countOfType) && record.countOfType > 0
          ? Math.trunc(record.countOfType)
          : 1,
    };
  }

  if (!Array.isArray(steps) || steps.length === 0) return '';
  const parts = [];
  for (const step of steps) {
    const normalized = normalizeStep(step);
    if (normalized !== undefined) parts.push(normalized);
  }
  if (parts.length === 0) return '';

  const relative = (step) => (step.countOfType > 1 ? `${step.tag}:nth-of-type(${step.nth})` : step.tag);

  let anchorIndex = -1;
  let anchorSelector = '';
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const step = parts[index];
    if (step.id !== '') {
      anchorIndex = index;
      anchorSelector = /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(step.id) ? `#${step.id}` : `[id="${escapeAttributeValue(step.id)}"]`;
      break;
    }
    if (step.testId !== '') {
      anchorIndex = index;
      anchorSelector = `[data-testid="${escapeAttributeValue(step.testId)}"]`;
      break;
    }
    if (step.name !== '') {
      anchorIndex = index;
      anchorSelector = `${step.tag}[name="${escapeAttributeValue(step.name)}"]`;
      break;
    }
  }

  if (anchorSelector === '') return parts.map(relative).join(' > ');
  const segments = [anchorSelector];
  for (let index = anchorIndex + 1; index < parts.length; index += 1) segments.push(relative(parts[index]));
  return segments.join(' > ');
}

/**
 * 判断一个盒模型快照是否「可见」。
 *
 * 纯函数：浏览器端采集时把 `getBoundingClientRect` 与 `getComputedStyle` 的结果塞进来，
 * 单测可以直接构造各种组合。规则来自契约 §3.6 的「可见可交互元素」：
 * 有尺寸、不是 `display:none` / `visibility:hidden|collapse`、透明度不是 0、未被
 * `aria-hidden="true"` 标记。
 *
 * @param {{ width?: number, height?: number, display?: string, visibility?: string, opacity?: number, ariaHidden?: boolean }} box
 *   盒模型与样式快照。
 * @returns {boolean} 是否可见。
 */
export function isVisibleBox(box) {
  if (box === null || typeof box !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (box);
  if (record.ariaHidden === true) return false;
  const width = typeof record.width === 'number' && Number.isFinite(record.width) ? record.width : 0;
  const height = typeof record.height === 'number' && Number.isFinite(record.height) ? record.height : 0;
  if (width <= 0 || height <= 0) return false;
  const display = typeof record.display === 'string' ? record.display : '';
  if (display === 'none') return false;
  const visibility = typeof record.visibility === 'string' ? record.visibility : '';
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  const opacity = typeof record.opacity === 'number' && Number.isFinite(record.opacity) ? record.opacity : 1;
  if (opacity <= 0.05) return false;
  return true;
}

/**
 * 把一条可交互元素信息格式化成快照里的一行。
 *
 * 格式（契约 §3.6）：`- <tag>[<type>] "文本" => <css path>`；没有 type / 文本时省略
 * 对应片段，保证行不会出现空引号或空方括号。
 *
 * @param {{ tag?: string, type?: string, text?: string, path?: string }} meta - 元素信息。
 * @returns {string} 单行描述。
 */
export function describeElementLine(meta) {
  const record = meta !== null && typeof meta === 'object' ? /** @type {Record<string, unknown>} */ (meta) : {};
  const tag = typeof record.tag === 'string' && record.tag.trim() !== '' ? record.tag.trim().toLowerCase() : 'element';
  const type = typeof record.type === 'string' ? record.type.trim() : '';
  const text = normalizeWhitespace(typeof record.text === 'string' ? record.text : '').slice(0, 120);
  const cssPath = typeof record.path === 'string' ? record.path : '';
  const head = type === '' ? tag : `${tag}[${type}]`;
  return text === '' ? `- ${head} => ${cssPath}` : `- ${head} "${text}" => ${cssPath}`;
}

/**
 * 解析截图目录。
 *
 * @param {unknown} configuredDir - 配置里的 `screenshotDir`（空 = 用默认目录）。
 * @param {Record<string, string | undefined>} [env] - 环境变量，默认 `process.env`。
 * @param {string} [home] - 用户主目录，默认 `os.homedir()`。
 * @returns {string} 绝对目录路径。
 */
export function resolveScreenshotDir(configuredDir, env = process.env, home = os.homedir()) {
  const explicit = typeof configuredDir === 'string' ? configuredDir.trim() : '';
  if (explicit !== '') return path.resolve(explicit);
  const envHome = env !== null && typeof env === 'object' && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const dshHome = envHome !== '' ? envHome : path.join(home, '.dsh');
  return path.join(path.resolve(dshHome), 'chrome-devtools', 'screenshots');
}

/**
 * 生成截图文件名：`YYYYMMDD-HHmmss-SSS.<ext>`。
 *
 * @param {Date} [now] - 时间，默认当前时间。
 * @param {string} [format] - `png` / `jpeg`。
 * @returns {string} 文件名（不含目录）。
 */
export function screenshotFileName(now = new Date(), format = 'png') {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    pad(now.getMilliseconds(), 3),
  ].join('');
  const extension = format === 'jpeg' || format === 'jpg' ? 'jpg' : 'png';
  return `${stamp}.${extension}`;
}

/**
 * 从 PNG 字节里读宽高（IHDR 块固定布局）。
 *
 * 比 `Page.getLayoutMetrics` 更准确：截图实际像素尺寸就是图片头的尺寸。非 PNG 或
 * 结构不对时返回 `undefined`，调用方退回 layout metrics。
 *
 * @param {unknown} buffer - PNG 字节。
 * @returns {{ width: number, height: number } | undefined} 尺寸；不是合法 PNG 时 undefined。
 */
export function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return undefined;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) return undefined;
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * 单个按键的键码描述。
 *
 * @param {string} key - 键名（`Enter`、`a`、`5`、`F1`、`Space` …）。
 * @returns {{ key: string, code: string, vk: number, text?: string } | undefined} 键码描述，未知键返回 undefined。
 */
export function keySpecFor(key) {
  if (typeof key !== 'string' || key === '') return undefined;
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, key)) return { ...NAMED_KEYS[key] };
  const canonical = key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, canonical)) return { ...NAMED_KEYS[canonical] };
  const functionKey = /^f([1-9]|1[0-2])$/iu.exec(key);
  if (functionKey !== null) {
    const index = Number(functionKey[1]);
    return { key: `F${index}`, code: `F${index}`, vk: 111 + index };
  }
  if (/^[A-Za-z]$/u.test(key)) {
    const upper = key.toUpperCase();
    // 保留输入的大小写作为 event.key（无 Shift 时按 "a" 应得到 key="a"），
    // text 用同一个字符——否则字母键不会真正插入字符。
    return { key, code: `Key${upper}`, vk: upper.charCodeAt(0), text: key };
  }
  if (/^[0-9]$/u.test(key)) return { key, code: `Digit${key}`, vk: 48 + Number(key) };
  if (Object.prototype.hasOwnProperty.call(PUNCTUATION_KEYS, key)) {
    const punctuation = PUNCTUATION_KEYS[key];
    return { key, code: punctuation.code, vk: punctuation.vk, text: punctuation.text };
  }
  return undefined;
}

/**
 * 解析按键表达式，支持 `Control+A` 这类修饰键组合。
 *
 * 修饰键识别为 `Alt` / `Control` / `Meta` / `Shift`（大小写不敏感），主键必须恰好一个。
 *
 * @param {string} input - 例如 `Enter`、`a`、`Control+A`。
 * @returns {{ key: string, code: string, vk: number, text?: string, modifiers: number } | undefined}
 *   解析结果；无法识别时 undefined。
 */
export function parseKeyCombo(input) {
  if (typeof input !== 'string') return undefined;
  const raw = input.trim();
  if (raw === '') return undefined;
  const parts = raw.split('+').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) return undefined;
  let modifiers = 0;
  const mains = [];
  for (const part of parts) {
    const canonical = part.length === 1 ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    const bit = MODIFIER_BITS[canonical];
    if (bit !== undefined) modifiers |= bit;
    else mains.push(part);
  }
  if (mains.length !== 1) return undefined;
  const spec = keySpecFor(mains[0]);
  if (spec === undefined) return undefined;
  return { ...spec, modifiers };
}

/**
 * 由键码描述生成 CDP 的 `keyDown` / `keyUp` 事件序列。
 *
 * - 可打印键在 keyDown 上带 `text`，页面才会真的输入字符；
 * - 带 Ctrl/Alt/Meta 的组合不带 `text`（那是快捷键，不是输入）；
 * - Shift + 字母把 `key` 转成大写（`event.key` 的语义）。
 *
 * @param {{ key: string, code: string, vk: number, text?: string, modifiers?: number }} combo - 键码描述。
 * @returns {object[]} 两个 CDP 事件参数对象。
 */
export function buildKeyEvents(combo) {
  if (combo === null || typeof combo !== 'object') return [];
  const modifiers = typeof combo.modifiers === 'number' && Number.isFinite(combo.modifiers) ? combo.modifiers : 0;
  const shift = (modifiers & MODIFIER_BITS.Shift) !== 0;
  let key = String(combo.key);
  let text = typeof combo.text === 'string' ? combo.text : undefined;
  if (shift && /^[a-z]$/u.test(key)) {
    key = key.toUpperCase();
    if (text !== undefined) text = text.toUpperCase();
  }
  const shared = {
    key,
    code: String(combo.code),
    windowsVirtualKeyCode: combo.vk,
    nativeVirtualKeyCode: combo.vk,
    modifiers,
  };
  const keyDown = { type: 'keyDown', ...shared };
  if (text !== undefined && text !== '' && (modifiers & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) === 0) {
    keyDown.text = text;
    keyDown.unmodifiedText = text;
  }
  return [keyDown, { type: 'keyUp', ...shared }];
}

/* ------------------------------------------------------------------ *
 * 浏览器端脚本（自包含函数，通过 toString 内联；不能引用模块作用域变量）
 * ------------------------------------------------------------------ */

/**
 * 定位元素：滚动到视口中央并返回中心坐标。
 *
 * @param {{ isVisibleBox: Function }} helpers - 内联的纯函数。
 * @param {string} selector - CSS 选择器。
 * @returns {object} `{ found, visible, error, x, y, width, height, tag }`。
 */
function locateElement(helpers, selector) {
  let element;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    return { found: false, visible: false, error: String((error && error.message) || error), x: 0, y: 0, width: 0, height: 0, tag: '' };
  }
  if (element === null || element === undefined) {
    return { found: false, visible: false, error: '', x: 0, y: 0, width: 0, height: 0, tag: '' };
  }
  try {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch {
    try {
      element.scrollIntoView();
    } catch {
      /* 滚动失败不影响后续 rect 读取 */
    }
  }
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const visible = helpers.isVisibleBox({
    width: rect.width,
    height: rect.height,
    display: style.display,
    visibility: style.visibility,
    opacity: Number(style.opacity),
    ariaHidden: element.getAttribute('aria-hidden') === 'true',
  });
  return {
    found: true,
    visible,
    error: '',
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: String(element.tagName || '').toLowerCase(),
  };
}

/**
 * 页面信息（`browser_*` 输出现用）。
 *
 * @returns {{ url: string, title: string }} 当前 URL 与标题。
 */
function pageInfoScript() {
  return { url: String(window.location.href), title: String(document.title) };
}

/**
 * 聚焦元素（不点击，避免触发额外副作用）。
 *
 * @param {object} helpers - 内联 helper（当前未用，保持签名一致）。
 * @param {string} selector - CSS 选择器。
 * @returns {{ ok: boolean, error: string }} 结果。
 */
function focusElement(helpers, selector) {
  try {
    const element = document.querySelector(selector);
    if (element === null || element === undefined) return { ok: false, error: 'element not found' };
    try {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      /* 忽略 */
    }
    element.focus({ preventScroll: true });
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/**
 * 填值：native setter + `input` / `change` 事件（契约 §3.6）。
 *
 * React/Vue 的受控组件通过劫持 `value` 的 setter 跟踪输入；直接 `element.value = x`
 * 不会触发它们的更新，必须用原型上的原生 setter 写入，再派发冒泡的 `input` 事件。
 * `<select>` 与 checkbox/radio 是另一套语义，单独处理。
 *
 * @param {object} helpers - 内联 helper（当前未用）。
 * @param {string} selector - CSS 选择器。
 * @param {string} value - 要填入的文本。
 * @returns {{ ok: boolean, error: string, value?: string, notFound?: boolean }} 结果。
 */
function fillElement(helpers, selector, value) {
  let element;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  if (element === null || element === undefined) return { ok: false, error: 'element not found', notFound: true };
  const text = String(value);
  try {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch {
    /* 忽略 */
  }
  try {
    const tag = String(element.tagName || '').toUpperCase();
    if (tag === 'SELECT') {
      element.value = text;
      if (element.value !== text) {
        const options = Array.from(element.options || []);
        const matched = options.find((option) => String(option.textContent || '').trim() === text);
        if (matched !== undefined) element.value = matched.value;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, error: '', value: String(element.value) };
    }
    if (tag === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) {
      const wantsChecked = text === 'true' || text === '1' || text === 'checked';
      if (element.checked !== wantsChecked) element.click();
      return { ok: true, error: '', value: String(element.checked) };
    }
    if (tag === 'INPUT' && element.type === 'file') {
      return { ok: false, error: 'file input 不能直接填值，请用 browser_upload_file' };
    }
    element.focus();
    if (element.isContentEditable === true) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, error: '', value: String(element.textContent || '') };
    }
    let applied = false;
    for (const constructor of [window.HTMLInputElement, window.HTMLTextAreaElement, window.HTMLSelectElement]) {
      if (constructor === undefined || !(element instanceof constructor)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, 'value');
      if (descriptor !== undefined && typeof descriptor.set === 'function') {
        descriptor.set.call(element, text);
        applied = true;
        break;
      }
    }
    if (!applied) element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, error: '', value: String(element.value === undefined ? text : element.value) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/**
 * 采集快照：可见可交互元素清单 + 稳定 CSS path + 页面可见文本。
 *
 * 返回结构化数据（不在这里拼文本），格式化交给 Node 侧的
 * {@link describeElementLine}——同一份纯函数，测试与运行时行为一致。
 *
 * @param {{ cssPathFromParts: Function, isVisibleBox: Function }} helpers - 内联的纯函数。
 * @param {{ selector: string, limit: number }} options - 选择器与元素上限。
 * @returns {{ url: string, title: string, items: object[], text: string }} 采集结果。
 */
function collectSnapshot(helpers, options) {
  const selector = String(options.selector);
  const limit = Number(options.limit) > 0 ? Math.trunc(Number(options.limit)) : 400;
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch (error) {
    return { url: String(window.location.href), title: String(document.title), items: [], text: '', error: String((error && error.message) || error) };
  }
  const items = [];
  for (const element of nodes) {
    if (items.length >= limit) break;
    let rect;
    let style;
    try {
      rect = element.getBoundingClientRect();
      style = window.getComputedStyle(element);
    } catch {
      continue;
    }
    const visible = helpers.isVisibleBox({
      width: rect.width,
      height: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      ariaHidden: element.getAttribute('aria-hidden') === 'true',
    });
    if (!visible) continue;
    const steps = [];
    let node = element;
    while (node !== null && node !== undefined && node.nodeType === 1) {
      const tag = String(node.tagName || '').toLowerCase();
      if (tag === '') break;
      let nth = 1;
      let count = 0;
      const parent = node.parentElement;
      if (parent !== null && parent !== undefined) {
        for (const sibling of parent.children) {
          if (sibling.tagName === node.tagName) {
            count += 1;
            if (sibling === node) nth = count;
          }
        }
      } else {
        count = 1;
      }
      steps.unshift({
        tag,
        id: typeof node.id === 'string' ? node.id : '',
        testId:
          (typeof node.getAttribute === 'function' &&
            (node.getAttribute('data-testid') || node.getAttribute('data-test') || '')) ||
          '',
        name: (typeof node.getAttribute === 'function' && node.getAttribute('name')) || '',
        nth,
        countOfType: count,
      });
      node = parent;
    }
    let text = '';
    try {
      text = String(element.innerText !== undefined ? element.innerText : element.textContent || '');
    } catch {
      text = '';
    }
    items.push({
      tag: String(element.tagName || '').toLowerCase(),
      type: String((element.getAttribute && element.getAttribute('type')) || '').toLowerCase(),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      path: helpers.cssPathFromParts(steps),
    });
  }
  let pageText = '';
  try {
    pageText = document.body === null || document.body === undefined ? '' : String(document.body.innerText || '');
  } catch {
    pageText = '';
  }
  return { url: String(window.location.href), title: String(document.title), items, text: pageText };
}

/**
 * 等待选择器出现。
 *
 * @param {object} helpers - 内联 helper（当前未用）。
 * @param {string} selector - CSS 选择器。
 * @returns {{ found: boolean, error: string }} 结果。
 */
function waitSelectorScript(helpers, selector) {
  try {
    return { found: document.querySelector(selector) !== null, error: '' };
  } catch (error) {
    return { found: false, error: String((error && error.message) || error) };
  }
}

/**
 * 等待页面文本出现。
 *
 * @param {object} helpers - 内联 helper（当前未用）。
 * @param {string} text - 要等待的文本。
 * @returns {{ found: boolean, error: string }} 结果。
 */
function waitTextScript(helpers, text) {
  const body = document.body === null || document.body === undefined ? null : document.body;
  const haystack = body === null ? '' : String(body.innerText || body.textContent || '');
  return { found: haystack.indexOf(text) !== -1, error: '' };
}

/**
 * 取元素对象本身（`returnByValue: false` 时由 CDP 返回 objectId）。
 *
 * @param {object} helpers - 内联 helper（当前未用）。
 * @param {string} selector - CSS 选择器。
 * @returns {Element | null} 命中的元素。
 */
function elementObjectScript(helpers, selector) {
  return document.querySelector(selector);
}

/**
 * 组装一条「内联 helper + 调用 + 标记」的 evaluate 表达式。
 *
 * @param {Function} fn - 浏览器端自包含函数。
 * @param {Record<string, Function>} helpers - 需要内联的纯函数。
 * @param {unknown[]} args - 传给 `fn` 的参数（JSON 化）。
 * @param {string} [mark] - 表达式末尾的注释标记（见 {@link EXPRESSION_MARKS}）。
 * @returns {string} 可直接执行并拿回值的表达式。
 */
export function buildExpression(fn, helpers = {}, args = [], mark = '') {
  if (typeof fn !== 'function') throw new TypeError('buildExpression: fn 必须是函数');
  const helperSource = Object.entries(helpers)
    .map(([name, helper]) => `${name}: (${helper.toString()})`)
    .join(', ');
  const helperObject = helperSource === '' ? '{}' : `{ ${helperSource} }`;
  const argSource = args.map((argument) => JSON.stringify(argument)).join(', ');
  const call = argSource === '' ? `(${helperObject})` : `(${helperObject}, ${argSource})`;
  const suffix = mark === '' ? '' : ` /* ${mark} */`;
  return `(${fn.toString()})${call}${suffix}`;
}

/**
 * 浏览器端内联脚本注册表。
 *
 * ## 为什么需要这张表（真实事故）
 *
 * `buildExpression` 只把 `fn.toString()` 与 helpers 的函数源码拼进表达式；**模块作用域在
 * 页面里不存在**。所以内联函数体内的每个自由标识符只能是：参数、函数体内自己声明的
 * 局部名、或浏览器/JS 全局。曾经 `cssPathFromParts` 调用了模块级的 `normalizeStep`，
 * 单测（假 session 按标记返回、从不执行表达式）全绿，真实 Loader 里一跑 `browser_snapshot`
 * 就 `ReferenceError: normalizeStep is not defined`。
 *
 * 现在**所有** evaluate 都从这张表构造（`buildInlineExpression`），`inlineScriptCatalog()`
 * 把每个内联脚本暴露给测试做「自由变量审计」——新增脚本必须同时进表，否则测试找不到它，
 * 而 PageHandle 里也不允许再出现裸的 `buildExpression(...)` 调用（测试用正则锁住）。
 */
const INLINE_SCRIPTS = {
  locate: { fn: locateElement, helpers: { isVisibleBox } },
  pageInfo: { fn: pageInfoScript, helpers: {} },
  fill: { fn: fillElement, helpers: {} },
  focus: { fn: focusElement, helpers: {} },
  snapshot: { fn: collectSnapshot, helpers: { cssPathFromParts, isVisibleBox } },
  waitSelector: { fn: waitSelectorScript, helpers: {} },
  waitText: { fn: waitTextScript, helpers: {} },
  elementObject: { fn: elementObjectScript, helpers: {} },
};

/**
 * 列出全部浏览器端内联脚本（供测试做自由变量审计）。
 *
 * @returns {{ name: string, mark: string, helpers: string[], source: string, expression: string }[]}
 *   每个脚本的名字、注释标记、helpers 名、函数源码与完整表达式。
 */
export function inlineScriptCatalog() {
  return Object.entries(INLINE_SCRIPTS).map(([name, entry]) => ({
    name,
    mark: EXPRESSION_MARKS[name],
    helpers: Object.keys(entry.helpers),
    source: entry.fn.toString(),
    expression: buildExpression(entry.fn, entry.helpers, [], EXPRESSION_MARKS[name]),
  }));
}

/**
 * 按注册表构造一条内联表达式（PageHandle 的唯一入口）。
 *
 * @param {string} name - 注册表里的脚本名（与 {@link EXPRESSION_MARKS} 的键一致）。
 * @param {unknown[]} [args] - 传给脚本的参数（JSON 化）。
 * @returns {string} 可直接 `Runtime.evaluate` 的表达式。
 * @throws {Error} 脚本名不在注册表里时。
 */
export function buildInlineExpression(name, args = []) {
  const entry = Object.prototype.hasOwnProperty.call(INLINE_SCRIPTS, name) ? INLINE_SCRIPTS[name] : undefined;
  if (entry === undefined) throw new Error(`page: unknown inline script "${String(name)}"`);
  return buildExpression(entry.fn, entry.helpers, args, EXPRESSION_MARKS[name]);
}

/* ------------------------------------------------------------------ *
 * CDP 返回值工具
 * ------------------------------------------------------------------ */

/** 从 `Runtime.evaluate` 的 remote object 里取值。 */
function remoteValue(remote) {
  if (remote === null || remote === undefined) return undefined;
  if (typeof remote !== 'object') return remote;
  const record = /** @type {Record<string, unknown>} */ (remote);
  if (record.value !== undefined) return record.value;
  if (typeof record.unserializableValue === 'string') {
    switch (record.unserializableValue) {
      case 'NaN':
        return Number.NaN;
      case 'Infinity':
        return Number.POSITIVE_INFINITY;
      case '-Infinity':
        return Number.NEGATIVE_INFINITY;
      case '-0':
        return -0;
      default:
        return record.unserializableValue;
    }
  }
  if (typeof record.description === 'string') return record.description;
  return undefined;
}

/** remote object 的 `type`（`undefined` / `object` / `string` …）。 */
function remoteType(remote) {
  if (remote === null || typeof remote !== 'object') return typeof remote;
  const type = /** @type {Record<string, unknown>} */ (remote).type;
  return typeof type === 'string' ? type : 'unknown';
}

/** 从 `exceptionDetails` 提取可读文本。 */
function exceptionText(details) {
  if (details === null || typeof details !== 'object') return 'unknown exception';
  const record = /** @type {Record<string, unknown>} */ (details);
  const exception = record.exception !== null && typeof record.exception === 'object' ? /** @type {Record<string, unknown>} */ (record.exception) : {};
  if (typeof exception.description === 'string' && exception.description !== '') return exception.description;
  if (typeof record.text === 'string' && record.text !== '') return record.text;
  return 'unknown exception';
}

/** 响应里带 `exceptionDetails` 就抛 `CDP_ERROR`。 */
function assertNoException(response, context) {
  const details = response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).exceptionDetails : undefined;
  if (details === undefined || details === null) return;
  const text = exceptionText(details);
  throw new BrowserError('CDP_ERROR', `${context}：页面脚本抛错 ${text}`, { exception: text });
}

/** 取有限数字，否则回落到默认值。 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 取整数并夹在区间内。 */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 归一化鼠标按钮名。 */
export function normalizeMouseButton(button) {
  return button === 'right' || button === 'middle' ? button : 'left';
}

/* ------------------------------------------------------------------ *
 * PageHandle
 * ------------------------------------------------------------------ */

/**
 * 一个 target（tab）的页面语义封装。
 *
 * 构造后第一次操作才 enable 各 CDP domain（懒初始化），因此 `browser_status` 这类
 * 不碰页面的工具不会产生多余往返。
 */
export class PageHandle {
  /**
   * @param {object} session - `TargetSession`（`send` / `on` / `waitFor` / `targetId`）。
   * @param {string} targetId - 该页的 target id。
   */
  constructor(session, targetId) {
    /** @type {object} */
    this.session = session;
    /** 该页的 target id。 */
    this.targetId = typeof targetId === 'string' ? targetId : '';
    /** @type {boolean} */
    this._enabled = false;
    /** @type {Promise<void> | undefined} */
    this._enablePromise = undefined;
    /** @type {ConsoleRegistry | undefined} */
    this._console = undefined;
    /** @type {NetworkRegistry | undefined} */
    this._network = undefined;
    /** @type {{ type: string, message: string, url: string } | undefined} */
    this._dialog = undefined;
    /** @type {boolean} */
    this._networkEnabled = false;
    /** @type {boolean} */
    this._disposed = false;
    /** @type {(() => void)[]} */
    this._unsubscribers = [];
    /** @type {{ accept: boolean, promptText?: string } | undefined} */
    this._autoHandle = undefined;
    /** @type {((dialog: object) => void) | undefined} */
    this._dialogListener = undefined;
    /** @type {boolean} */
    this._handlingDialog = false;
  }

  /** 当前挂起（尚未处理）的 JavaScript 对话框。 */
  get pendingDialog() {
    return this._dialog === undefined ? undefined : { ...this._dialog };
  }

  /** 是否已释放。 */
  get disposed() {
    return this._disposed;
  }

  /**
   * 确保 `Page` / `Runtime` / `DOM` 已 enable。
   *
   * @returns {Promise<void>} 完成即代表 domain 就绪。
   */
  async _ensureEnabled() {
    if (this._disposed) throw new BrowserError('PROTOCOL_ERROR', '页面句柄已释放（dispose 之后不能再操作）');
    if (this._enabled) return;
    if (this._enablePromise === undefined) {
      this._enablePromise = (async () => {
        await this._sendRaw('Page.enable');
        await this._sendRaw('Runtime.enable');
        await this._sendRaw('DOM.enable').catch(noop);
        this._wireDialogEvents();
        this._enabled = true;
      })();
      this._enablePromise = this._enablePromise.catch((error) => {
        this._enablePromise = undefined;
        throw asBrowserError(error, 'enable');
      });
    }
    await this._enablePromise;
  }

  /**
   * 挂上对话框事件监听。
   *
   * @returns {void}
   */
  _wireDialogEvents() {
    if (this.session === null || typeof this.session !== 'object' || typeof this.session.on !== 'function') return;
    this._unsubscribers.push(
      this.session.on('Page.javascriptDialogOpening', (payload) => {
        const record = payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
        const dialog = {
          type: typeof record.type === 'string' ? record.type : 'alert',
          message: typeof record.message === 'string' ? record.message : '',
          url: typeof record.url === 'string' ? record.url : '',
        };
        this._dialog = dialog;
        if (typeof this._dialogListener === 'function') {
          try {
            this._dialogListener(dialog);
          } catch {
            /* 监听器异常不影响页面操作 */
          }
        }
        if (this._autoHandle !== undefined && !this._handlingDialog) {
          const { accept, promptText } = this._autoHandle;
          this._handlingDialog = true;
          this.handleDialog(accept, promptText)
            .catch(noop)
            .finally(() => {
              this._handlingDialog = false;
            });
        }
      }),
    );
    this._unsubscribers.push(
      this.session.on('Page.javascriptDialogClosed', () => {
        this._dialog = undefined;
      }),
    );
  }

  /** 有未处理对话框时给出明确错误（契约 §3.6：未处理的 dialog 会阻塞页面）。 */
  _assertNoDialog(action) {
    if (this._dialog === undefined) return;
    const { type, message } = this._dialog;
    throw new BrowserError(
      'CDP_ERROR',
      `页面被未处理的 JavaScript ${type} 对话框阻塞（"${message}"）。请先调用 browser_handle_dialog 处理后再执行 ${action}。`,
      { dialogType: type, dialogMessage: message, action },
    );
  }

  /**
   * 发一条 CDP 命令，把异常归一成 BrowserError。
   *
   * `options` 是可选的 `{ timeoutMs }`：`TargetSession.send` 支持按命令覆盖超时
   * （契约 §3.3 的「截图/导航可用更长」）。不传时用连接默认值；不支持第三参的
   * 实现会安全忽略它。
   *
   * @param {string} method - CDP 方法名。
   * @param {object} [params] - 参数。
   * @param {{ timeoutMs?: number }} [options] - 可选的命令级超时。
   * @returns {Promise<any>} CDP 返回值。
   */
  async _sendRaw(method, params = {}, options = undefined) {
    if (this.session === null || typeof this.session !== 'object' || typeof this.session.send !== 'function') {
      throw new BrowserError('NOT_CONNECTED', 'CDP session 不可用（没有 send 方法），请先 browser_connect');
    }
    try {
      return options === undefined ? await this.session.send(method, params) : await this.session.send(method, params, options);
    } catch (error) {
      throw asBrowserError(error, method);
    }
  }

  /**
   * 执行一条 evaluate 表达式，返回结构化细节（异常也以数据形式返回）。
   *
   * @param {string} expression - 要执行的 JS 表达式。
   * @param {{ awaitPromise?: boolean, returnByValue?: boolean }} [options] - Runtime.evaluate 选项。
   * @returns {Promise<{ ok: boolean, value: unknown, type: string, exception: string }>} 结果。
   */
  async evaluateDetailed(expression, options = {}) {
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new BrowserError('INVALID_ARGUMENT', 'expression 不能为空');
    }
    await this._ensureEnabled();
    this._assertNoDialog('browser_evaluate');
    const response = await this._sendRaw('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: options.returnByValue !== false,
      userGesture: true,
      includeCommandLineAPI: false,
      replMode: false,
    }, { timeoutMs: 30_000 });
    const details = response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).exceptionDetails : undefined;
    if (details !== undefined && details !== null) {
      return { ok: false, value: undefined, type: 'exception', exception: exceptionText(details) };
    }
    const remote = response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined;
    return { ok: true, value: remoteValue(remote), type: remoteType(remote), exception: '' };
  }

  /**
   * 执行 JS 表达式并返回结果（异常时抛 BrowserError）。
   *
   * @param {string} expression - 表达式。
   * @param {{ awaitPromise?: boolean, returnByValue?: boolean }} [options] - 选项。
   * @returns {Promise<unknown>} 求值结果。
   */
  async evaluate(expression, options = {}) {
    const detail = await this.evaluateDetailed(expression, options);
    if (!detail.ok) throw new BrowserError('CDP_ERROR', `页面脚本异常：${detail.exception}`, { exception: detail.exception });
    return detail.value;
  }

  /**
   * 当前页面 URL 与标题。
   *
   * @returns {Promise<{ url: string, title: string }>} 页面信息。
   */
  async pageInfo() {
    await this._ensureEnabled();
    this._assertNoDialog('读取页面信息');
    const response = await this._sendRaw('Runtime.evaluate', {
      expression: buildInlineExpression('pageInfo'),
      awaitPromise: false,
      returnByValue: true,
    });
    assertNoException(response, '读取页面信息');
    const value = remoteValue(response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined);
    const record = value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
    return {
      url: typeof record.url === 'string' ? record.url : '',
      title: typeof record.title === 'string' ? record.title : '',
    };
  }

  /**
   * 当前页面 URL（契约 §3.6）。
   *
   * @returns {Promise<string>} URL。
   */
  async url() {
    return (await this.pageInfo()).url;
  }

  /**
   * 当前页面标题（契约 §3.6）。
   *
   * @returns {Promise<string>} 标题。
   */
  async title() {
    return (await this.pageInfo()).title;
  }

  /**
   * 等到导航完成。
   *
   * 优先用 `session.waitFor` 等 `Page.loadEventFired` / `Page.domContentEventFired`；
   * 没有事件能力（或事件超时）时退回轮询 `document.readyState`。
   *
   * @param {'load' | 'domcontentloaded' | 'networkidle0' | 'none'} waitUntil - 等待条件。
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<void>} 完成即导航就绪。
   */
  async _waitForNavigation(waitUntil, timeoutMs) {
    const mode = ['load', 'domcontentloaded', 'networkidle0', 'none'].includes(waitUntil) ? waitUntil : 'load';
    if (mode === 'none') return;
    if (mode === 'networkidle0') {
      await this._waitForLoadEvent('load', timeoutMs);
      await this._waitForNetworkIdle(timeoutMs);
      return;
    }
    await this._waitForLoadEvent(mode, timeoutMs);
  }

  /**
   * 等 `load` / `domcontentloaded` 事件。
   *
   * @param {'load' | 'domcontentloaded'} mode - 目标状态。
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<void>} 完成即到达目标状态。
   */
  async _waitForLoadEvent(mode, timeoutMs) {
    const eventName = mode === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
    if (this.session !== null && typeof this.session === 'object' && typeof this.session.waitFor === 'function') {
      try {
        await this.session.waitFor(eventName, undefined, timeoutMs);
        return;
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error).code : undefined;
        if (code !== 'TIMEOUT') throw asBrowserError(error, eventName);
      }
    }
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const wanted = mode === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete'];
    for (;;) {
      try {
        const state = await this.evaluate('document.readyState', { awaitPromise: false });
        if (wanted.includes(String(state))) return;
      } catch {
        /* 导航进行中 evaluate 可能失败，继续等 */
      }
      if (Date.now() >= deadline) throw new BrowserError('TIMEOUT', `页面在 ${timeoutMs}ms 内没有到达 ${mode} 状态`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * 等到网络空闲（启发式：`load` 之后 500ms 内没有新请求）。
   *
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<void>} 完成即网络空闲。
   */
  async _waitForNetworkIdle(timeoutMs) {
    const registry = await this.enableNetworkCapture();
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let baseline = registry.requests.size;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const size = registry.requests.size;
      if (size !== baseline) {
        baseline = size;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= NETWORK_IDLE_WINDOW_MS) {
        return;
      }
    }
    throw new BrowserError('TIMEOUT', `网络在 ${timeoutMs}ms 内没有进入空闲状态（networkidle0 是启发式）`);
  }

  /**
   * 导航到 URL 并等待就绪。
   *
   * @param {string} url - 目标 URL。
   * @param {{ waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'none', timeoutMs?: number }} [options]
   *   等待条件与超时。
   * @returns {Promise<{ url: string, title: string }>} 导航后的页面信息。
   */
  async navigate(url, options = {}) {
    const target = typeof url === 'string' ? url.trim() : '';
    if (target === '') throw new BrowserError('INVALID_ARGUMENT', 'navigate 需要非空 url');
    const timeoutMs = clampInt(options.timeoutMs, 30_000, 100, 300_000);
    const waitUntil = ['load', 'domcontentloaded', 'networkidle0', 'none'].includes(options.waitUntil) ? options.waitUntil : 'load';
    await this._ensureEnabled();
    this._assertNoDialog('browser_navigate');
    const waiter = this._waitForNavigation(waitUntil, timeoutMs);
    waiter.catch(noop);
    let response;
    try {
      response = await this._sendRaw('Page.navigate', { url: target }, { timeoutMs: Math.max(15_000, timeoutMs) });
    } catch (error) {
      throw asBrowserError(error, 'Page.navigate');
    }
    const errorText = response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).errorText : undefined;
    if (typeof errorText === 'string' && errorText !== '') {
      throw new BrowserError('CDP_ERROR', `导航失败：${errorText}（目标 ${target}）`, { url: target });
    }
    await waiter;
    const info = await this.pageInfo().catch(() => ({ url: target, title: '' }));
    return { url: info.url === '' ? target : info.url, title: info.title };
  }

  /**
   * 定位元素（含滚动到视口中央）。
   *
   * @param {string} selector - CSS 选择器。
   * @param {number} timeoutMs - 最长等待。
   * @param {string} action - 动作名（用于错误消息）。
   * @returns {Promise<{ x: number, y: number, width: number, height: number, tag: string }>} 中心坐标与尺寸。
   */
  async _locate(selector, timeoutMs, action) {
    const wanted = typeof selector === 'string' ? selector.trim() : '';
    if (wanted === '') throw new BrowserError('INVALID_ARGUMENT', `${action} 需要非空 selector`);
    await this._ensureEnabled();
    const limit = clampInt(timeoutMs, 10_000, 1, 300_000);
    const deadline = Date.now() + limit;
    let lastReason = '';
    for (;;) {
      this._assertNoDialog(action);
      const response = await this._sendRaw('Runtime.evaluate', {
        expression: buildInlineExpression('locate', [wanted]),
        awaitPromise: false,
        returnByValue: true,
      });
      assertNoException(response, action);
      const value = remoteValue(response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined);
      const record = value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
      const invalid = typeof record.error === 'string' && record.error !== '';
      if (invalid) {
        throw new BrowserError('INVALID_ARGUMENT', `${action}：selector 非法（"${wanted}"）：${record.error}`, { selector: wanted });
      }
      if (record.found === true && record.visible === true) {
        return {
          x: Math.round(numberOr(record.x, 0)),
          y: Math.round(numberOr(record.y, 0)),
          width: numberOr(record.width, 0),
          height: numberOr(record.height, 0),
          tag: typeof record.tag === 'string' ? record.tag : '',
        };
      }
      lastReason = record.found === true ? '元素存在但不可见（尺寸为 0 或被 display/visibility 隐藏）' : '页面上没有匹配的元素';
      if (Date.now() >= deadline) break;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    const info = await this.pageInfo().catch(() => ({ url: '', title: '' }));
    throw new BrowserError(
      'TARGET_NOT_FOUND',
      `找不到可操作的元素 "${wanted}"（等待 ${limit}ms）：${lastReason}。当前页面 ${info.url === '' ? '(未知)' : info.url}`,
      { selector: wanted, url: info.url },
    );
  }

  /**
   * 点击元素：先滚动到视口中央，再用 `Input.dispatchMouseEvent` 打到中心坐标。
   *
   * @param {string} selector - CSS 选择器。
   * @param {{ timeoutMs?: number, button?: 'left' | 'right' | 'middle', clickCount?: number }} [options]
   *   超时、按钮、点击次数（2 = 双击）。
   * @returns {Promise<{ ok: boolean }>} 成功标志。
   */
  async click(selector, options = {}) {
    const point = await this._locate(selector, options.timeoutMs, 'browser_click');
    const button = normalizeMouseButton(options.button);
    const clicks = clampInt(options.clickCount, 1, 1, 3);
    await this._sendRaw('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      pointerType: 'mouse',
    });
    for (let index = 0; index < clicks; index += 1) {
      const clickCount = index + 1;
      await this._sendRaw('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        clickCount,
        pointerType: 'mouse',
      });
      await this._sendRaw('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount,
        pointerType: 'mouse',
      });
    }
    return { ok: true };
  }

  /**
   * 填值：native setter + `input` / `change` 事件（对 React/Vue 受控组件生效）。
   *
   * @param {string} selector - CSS 选择器。
   * @param {unknown} value - 要填入的值（转成字符串）。
   * @param {{ timeoutMs?: number }} [options] - 超时。
   * @returns {Promise<{ ok: boolean }>} 成功标志。
   */
  async fill(selector, value, options = {}) {
    const wanted = typeof selector === 'string' ? selector.trim() : '';
    if (wanted === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_fill 需要非空 selector');
    await this._locate(wanted, options.timeoutMs, 'browser_fill');
    this._assertNoDialog('browser_fill');
    const text = value === undefined || value === null ? '' : String(value);
    const response = await this._sendRaw('Runtime.evaluate', {
      expression: buildInlineExpression('fill', [wanted, text]),
      awaitPromise: false,
      returnByValue: true,
      userGesture: true,
    });
    assertNoException(response, 'browser_fill');
    const result = remoteValue(response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined);
    const record = result !== null && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
    if (record.ok !== true) {
      if (record.notFound === true) throw new BrowserError('TARGET_NOT_FOUND', `找不到输入框 "${wanted}"`, { selector: wanted });
      throw new BrowserError('CDP_ERROR', `填写 "${wanted}" 失败：${typeof record.error === 'string' && record.error !== '' ? record.error : '未知原因'}`, {
        selector: wanted,
      });
    }
    return { ok: true };
  }

  /**
   * 打字：先聚焦（可选 selector），再逐字符 `Input.insertText`。
   *
   * @param {string} text - 要输入的文本。
   * @param {{ selector?: string, delayMs?: number }} [options] - 聚焦目标与字符间隔。
   * @returns {Promise<{ ok: boolean, chars: number }>} 成功标志与字符数（按 code point 计）。
   */
  async type(text, options = {}) {
    if (typeof text !== 'string') throw new BrowserError('INVALID_ARGUMENT', 'browser_type 需要 text 字符串');
    const selector = typeof options.selector === 'string' ? options.selector.trim() : '';
    const delayMs = clampInt(options.delayMs, 0, 0, 10_000);
    await this._ensureEnabled();
    this._assertNoDialog('browser_type');
    if (selector !== '') {
      await this._locate(selector, options.timeoutMs, 'browser_type');
      const response = await this._sendRaw('Runtime.evaluate', {
        expression: buildInlineExpression('focus', [selector]),
        awaitPromise: false,
        returnByValue: true,
        userGesture: true,
      });
      assertNoException(response, 'browser_type');
      const result = remoteValue(response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined);
      const record = result !== null && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
      if (record.ok !== true) {
        throw new BrowserError('CDP_ERROR', `聚焦 "${selector}" 失败：${typeof record.error === 'string' && record.error !== '' ? record.error : '未知原因'}`, {
          selector,
        });
      }
    }
    const characters = Array.from(text);
    for (const character of characters) {
      await this._sendRaw('Input.insertText', { text: character });
      if (delayMs > 0) await sleep(delayMs);
    }
    return { ok: true, chars: characters.length };
  }

  /**
   * 按键：`Input.dispatchKeyEvent`（keyDown + keyUp，含常见键映射表）。
   *
   * @param {string} key - 键名或组合（`Enter`、`Tab`、`Control+A` …）。
   * @param {{ selector?: string }} [options] - 可选聚焦目标。
   * @returns {Promise<{ ok: boolean }>} 成功标志。
   */
  async pressKey(key, options = {}) {
    const combo = parseKeyCombo(key);
    if (combo === undefined) {
      throw new BrowserError(
        'INVALID_ARGUMENT',
        `不支持的键 "${String(key)}"：支持 Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space/字母/数字/F1-F12，以及 Control+A 这类组合`,
      );
    }
    await this._ensureEnabled();
    this._assertNoDialog('browser_press_key');
    const selector = typeof options.selector === 'string' ? options.selector.trim() : '';
    if (selector !== '') {
      await this._locate(selector, options.timeoutMs, 'browser_press_key');
      const response = await this._sendRaw('Runtime.evaluate', {
        expression: buildInlineExpression('focus', [selector]),
        awaitPromise: false,
        returnByValue: true,
        userGesture: true,
      });
      assertNoException(response, 'browser_press_key');
    }
    for (const event of buildKeyEvents(combo)) {
      await this._sendRaw('Input.dispatchKeyEvent', event);
    }
    return { ok: true };
  }

  /**
   * 悬停：`Input.dispatchMouseEvent` 的 `mouseMoved`。
   *
   * @param {string} selector - CSS 选择器。
   * @param {{ timeoutMs?: number }} [options] - 超时。
   * @returns {Promise<{ ok: boolean }>} 成功标志。
   */
  async hover(selector, options = {}) {
    const point = await this._locate(selector, options.timeoutMs, 'browser_hover');
    await this._sendRaw('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      pointerType: 'mouse',
    });
    return { ok: true };
  }

  /**
   * 拖拽：从源元素中心按下，分步移动到目标元素中心后释放。
   *
   * @param {string} fromSelector - 源元素。
   * @param {string} toSelector - 目标元素。
   * @param {{ timeoutMs?: number }} [options] - 超时。
   * @returns {Promise<{ ok: boolean }>} 成功标志。
   */
  async drag(fromSelector, toSelector, options = {}) {
    const from = await this._locate(fromSelector, options.timeoutMs, 'browser_drag');
    const to = await this._locate(toSelector, options.timeoutMs, 'browser_drag');
    await this._sendRaw('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', pointerType: 'mouse' });
    await this._sendRaw('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    const steps = 8;
    for (let index = 1; index <= steps; index += 1) {
      await this._sendRaw('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + ((to.x - from.x) * index) / steps),
        y: Math.round(from.y + ((to.y - from.y) * index) / steps),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
    }
    await this._sendRaw('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    return { ok: true };
  }

  /**
   * 等待条件（selector 出现 / 文本出现；两者都给时要求同时满足）。
   *
   * @param {{ selector?: string, text?: string, timeoutMs?: number }} [options] - 等待条件与超时。
   * @returns {Promise<{ matched: boolean, waitedMs: number, reason: string }>} 等待结果。
   */
  async waitFor(options = {}) {
    await this._ensureEnabled();
    const selector = typeof options.selector === 'string' ? options.selector.trim() : '';
    const text = typeof options.text === 'string' && options.text !== '' ? options.text : '';
    const timeoutMs = clampInt(options.timeoutMs, 10_000, 0, 300_000);
    if (selector === '' && text === '') {
      return { matched: false, waitedMs: 0, reason: '没有可等待的条件：请提供 selector 或 text' };
    }
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lastReason = '';
    for (;;) {
      this._assertNoDialog('browser_wait_for');
      let matched = true;
      let reason = '';
      if (selector !== '') {
        const response = await this._sendRaw('Runtime.evaluate', {
          expression: buildInlineExpression('waitSelector', [selector]),
          awaitPromise: false,
          returnByValue: true,
        });
        assertNoException(response, 'browser_wait_for');
        const value = remoteValue(response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined);
        const record = value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
        if (typeof record.error === 'string' && record.error !== '') {
          throw new BrowserError('INVALID_ARGUMENT', `browser_wait_for：selector 非法（"${selector}"）：${record.error}`, { selector });
        }
        if (record.found !== true) {
          matched = false;
          lastReason = `selector "${selector}" 还没有出现`;
        } else {
          reason = 'selector found';
        }
      }
      if (matched && text !== '') {
        const response = await this._sendRaw('Runtime.evaluate', {
          expression: buildInlineExpression('waitText', [text]),
          awaitPromise: false,
          returnByValue: true,
        });
        assertNoException(response, 'browser_wait_for');
        const value = remoteValue(response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined);
        const record = value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
        if (record.found !== true) {
          matched = false;
          lastReason = `文本 "${text}" 还没有出现`;
        } else {
          reason = 'text found';
        }
      }
      if (matched) return { matched: true, waitedMs: Date.now() - started, reason };
      if (Date.now() >= deadline) break;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    return { matched: false, waitedMs: Date.now() - started, reason: `等待超时（${timeoutMs}ms）：${lastReason}` };
  }

  /**
   * 给 `<input type="file">` 设文件（`DOM.setFileInputFiles`）。
   *
   * @param {string} selector - 文件输入框选择器。
   * @param {string[]} files - 文件路径（会解析成绝对路径并校验存在）。
   * @returns {Promise<{ ok: boolean }>} 成功标志。
   */
  async setFiles(selector, files) {
    const wanted = typeof selector === 'string' ? selector.trim() : '';
    if (wanted === '') throw new BrowserError('INVALID_ARGUMENT', 'browser_upload_file 需要非空 selector');
    const list = Array.isArray(files) ? files.filter((file) => typeof file === 'string' && file.trim() !== '').map((file) => file.trim()) : [];
    if (list.length === 0) throw new BrowserError('INVALID_ARGUMENT', 'browser_upload_file 需要非空 files 数组');
    await this._ensureEnabled();
    this._assertNoDialog('browser_upload_file');
    await this._locate(wanted, 10_000, 'browser_upload_file');
    const absolute = list.map((file) => path.resolve(file));
    const missing = absolute.filter((file) => {
      try {
        return !fs.statSync(file).isFile();
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      throw new BrowserError('INVALID_ARGUMENT', `这些文件不存在或不是普通文件：${missing.join(', ')}`, { files: missing });
    }
    const response = await this._sendRaw('Runtime.evaluate', {
      expression: buildInlineExpression('elementObject', [wanted]),
      awaitPromise: false,
      returnByValue: false,
    });
    assertNoException(response, 'browser_upload_file');
    const remote = response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined;
    const objectId = remote !== null && typeof remote === 'object' ? /** @type {Record<string, unknown>} */ (remote).objectId : undefined;
    if (typeof objectId !== 'string' || objectId === '') {
      throw new BrowserError('TARGET_NOT_FOUND', `找不到文件输入框 "${wanted}"`, { selector: wanted });
    }
    await this._sendRaw('DOM.setFileInputFiles', { files: absolute, objectId });
    return { ok: true };
  }

  /**
   * 页面快照：可见可交互元素清单（含稳定 CSS path）+ 页面可见文本。
   *
   * 这是模型找选择器的主要手段：每行形如
   * `- button[submit] "Sign in" => #login > button`。元素采集在浏览器里做（内联同一份
   * `cssPathFromParts` / `isVisibleBox`），格式化在 Node 里做（{@link describeElementLine}），
   * 保证单测与运行时行为一致。
   *
   * @param {{ maxChars?: number, selector?: string, limit?: number }} [options]
   *   字符上限（默认 12000）、元素选择器覆盖、元素数量上限（默认 400）。
   * @returns {Promise<{ text: string, truncated: boolean, url: string, title: string }>}
   *   快照文本与页面信息（`url` / `title` 是便捷字段，工具层直接用）。
   */
  async snapshot(options = {}) {
    const maxChars = clampInt(options.maxChars, DEFAULT_SNAPSHOT_MAX_CHARS, 100, 200_000);
    const limit = clampInt(options.limit, 400, 1, 2000);
    const selector = typeof options.selector === 'string' && options.selector.trim() !== '' ? options.selector.trim() : INTERACTIVE_SELECTOR;
    await this._ensureEnabled();
    this._assertNoDialog('browser_snapshot');
    const response = await this._sendRaw('Runtime.evaluate', {
      expression: buildInlineExpression('snapshot', [{ selector, limit }]),
      awaitPromise: false,
      returnByValue: true,
    });
    assertNoException(response, 'browser_snapshot');
    const value = remoteValue(response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).result : undefined);
    const record = value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
    const items = Array.isArray(record.items) ? record.items : [];
    const header = [
      `# ${typeof record.title === 'string' && record.title !== '' ? record.title : '(无标题)'}`,
      `URL: ${typeof record.url === 'string' ? record.url : ''}`,
      `可交互元素：${items.length}${items.length >= limit ? '（达到上限，可能还有更多）' : ''}`,
      '',
    ];
    const lines = items.map((item) => describeElementLine(item !== null && typeof item === 'object' ? item : {}));
    const pageText =
      typeof record.text === 'string' ? record.text.replace(/\r\n?/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim().slice(0, 4000) : '';
    const body = [...header, ...lines, '', '## 页面可见文本（截断）', pageText === '' ? '(空)' : pageText];
    const clipped = truncateText(body.join('\n'), maxChars);
    return {
      text: clipped.text,
      truncated: clipped.truncated,
      url: typeof record.url === 'string' ? record.url : '',
      title: typeof record.title === 'string' ? record.title : '',
    };
  }

  /**
   * 截图并落盘。
   *
   * @param {{ format?: 'png' | 'jpeg' | 'jpg', fullPage?: boolean, path?: string }} [options]
   *   格式、是否整页、目标文件（默认 `$DSH_HOME/chrome-devtools/screenshots/<timestamp>.png`）。
   * @returns {Promise<{ path: string, bytes: number, width: number, height: number }>} 文件绝对路径、字节数与像素尺寸。
   */
  async screenshot(options = {}) {
    const format = options.format === 'jpeg' || options.format === 'jpg' ? 'jpeg' : 'png';
    const fullPage = options.fullPage === true;
    await this._ensureEnabled();
    this._assertNoDialog('browser_screenshot');
    const response = await this._sendRaw('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: 90 } : {}),
      ...(fullPage ? { captureBeyondViewport: true } : {}),
    }, { timeoutMs: 60_000 });
    const data = response !== null && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response).data : undefined;
    if (typeof data !== 'string' || data === '') {
      throw new BrowserError('CDP_ERROR', '截图失败：Page.captureScreenshot 没有返回 base64 数据');
    }
    const bytes = Buffer.from(data, 'base64');
    const explicitPath = typeof options.path === 'string' && options.path.trim() !== '' ? options.path.trim() : '';
    const targetPath = explicitPath !== '' ? path.resolve(explicitPath) : path.join(resolveScreenshotDir(), screenshotFileName(new Date(), format));
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, bytes);
    } catch (error) {
      throw new BrowserError('CDP_ERROR', `截图已生成但写入文件失败：${messageOf(error)}（目标 ${targetPath}）`, { path: targetPath });
    }
    const size = await this._screenshotSize(bytes, format, fullPage);
    return { path: targetPath, bytes: bytes.byteLength, width: size.width, height: size.height };
  }

  /**
   * 截图像素尺寸：PNG 解析图片头，其它格式退回 `Page.getLayoutMetrics`。
   *
   * @param {Buffer} bytes - 图片字节。
   * @param {'png' | 'jpeg'} format - 格式。
   * @param {boolean} fullPage - 是否整页。
   * @returns {Promise<{ width: number, height: number }>} 尺寸（取不到时为 0）。
   */
  async _screenshotSize(bytes, format, fullPage) {
    if (format === 'png') {
      const png = readPngSize(bytes);
      if (png !== undefined) return png;
    }
    try {
      const metrics = await this._sendRaw('Page.getLayoutMetrics');
      const record = metrics !== null && typeof metrics === 'object' ? /** @type {Record<string, unknown>} */ (metrics) : {};
      const viewport = record.cssVisualViewport !== null && typeof record.cssVisualViewport === 'object' ? record.cssVisualViewport : record.visualViewport;
      const content = record.cssContentSize !== null && typeof record.cssContentSize === 'object' ? record.cssContentSize : record.contentSize;
      const viewportRecord = viewport !== null && typeof viewport === 'object' ? /** @type {Record<string, unknown>} */ (viewport) : {};
      const contentRecord = content !== null && typeof content === 'object' ? /** @type {Record<string, unknown>} */ (content) : {};
      const source = fullPage ? contentRecord : { ...contentRecord, ...viewportRecord };
      const width = numberOr(source.width ?? viewportRecord.clientWidth, 0);
      const height = numberOr(source.height ?? viewportRecord.clientHeight, 0);
      return { width, height };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  /**
   * 开始采集控制台消息（幂等）。`Runtime.enable` 已由 {@link _ensureEnabled} 完成。
   *
   * @returns {Promise<ConsoleRegistry>} 控制台缓冲。
   */
  async enableConsoleCapture() {
    await this._ensureEnabled();
    if (this._console === undefined) {
      this._console = new ConsoleRegistry(this.session);
      this._console.start();
    }
    return this._console;
  }

  /**
   * 列出最近的控制台消息。
   *
   * @param {{ limit?: number, types?: string[] }} [options] - 条数与类型过滤。
   * @returns {object[]} 控制台消息。
   */
  consoleMessages(options = {}) {
    return this._console === undefined ? [] : this._console.list(options);
  }

  /**
   * 开始采集网络请求（幂等；会 `Network.enable`）。
   *
   * @returns {Promise<NetworkRegistry>} 网络缓冲。
   */
  async enableNetworkCapture() {
    await this._ensureEnabled();
    if (this._network === undefined) {
      if (!this._networkEnabled) {
        await this._sendRaw('Network.enable').catch(noop);
        this._networkEnabled = true;
      }
      this._network = new NetworkRegistry(this.session);
      this._network.start();
    }
    return this._network;
  }

  /**
   * 列出最近的网络请求。
   *
   * @param {{ limit?: number }} [options] - 条数上限。
   * @returns {object[]} 请求记录。
   */
  networkRequests(options = {}) {
    return this._network === undefined ? [] : this._network.list(options);
  }

  /**
   * 注册对话框打开回调（未自动处理时通知调用方）。
   *
   * @param {(dialog: { type: string, message: string, url: string }) => void} callback - 回调。
   * @returns {this} 便于链式调用。
   */
  onDialog(callback) {
    this._dialogListener = typeof callback === 'function' ? callback : undefined;
    return this;
  }

  /**
   * 开启对话框自动处理（收到事件立刻 accept/dismiss）。
   *
   * @param {boolean} [accept] - 是否接受（true = 确定，false = 取消）。
   * @param {string} [promptText] - `prompt()` 的输入值。
   * @returns {this} 便于链式调用。
   */
  enableDialogAutoHandle(accept = true, promptText = undefined) {
    this._autoHandle = { accept: accept === true, promptText: typeof promptText === 'string' ? promptText : undefined };
    return this;
  }

  /**
   * 处理当前挂起的 JavaScript 对话框（`Page.handleJavaScriptDialog`）。
   *
   * @param {boolean} accept - 是否接受。
   * @param {string} [promptText] - `prompt()` 的输入值。
   * @returns {Promise<{ handled: boolean, dialogType: string, dialogMessage: string }>} 处理结果。
   */
  async handleDialog(accept, promptText) {
    await this._ensureEnabled();
    const previous = this._dialog;
    const params = { accept: accept === true };
    if (typeof promptText === 'string' && promptText !== '') params.promptText = promptText;
    try {
      await this._sendRaw('Page.handleJavaScriptDialog', params);
    } catch (error) {
      this._dialog = undefined;
      throw asBrowserError(error, 'Page.handleJavaScriptDialog');
    }
    this._dialog = undefined;
    return {
      handled: true,
      dialogType: previous === undefined ? '' : previous.type,
      dialogMessage: previous === undefined ? '' : previous.message,
    };
  }

  /** 释放句柄：停止观测、取消事件监听。不 detach（session 由 manager 管理）。 */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const unsubscribe of this._unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        /* 取消监听失败不影响释放 */
      }
    }
    if (this._console !== undefined) this._console.stop();
    if (this._network !== undefined) this._network.stop();
    this._dialog = undefined;
    this._dialogListener = undefined;
    this._autoHandle = undefined;
  }
}
