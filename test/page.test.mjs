/**
 * `lib/page.mjs` 的单测：纯函数 + PageHandle 全动作（假 session，不启动 Chrome）。
 *
 * 假 session 按 evaluate 表达式末尾的 `/* dsh-cdp:<name> *​/` 注释标记返回结构化结果，
 * 所以 PageHandle 的定位/填值/快照/等待逻辑都能在 Node 里被验证；同时断言真正发给
 * CDP 的命令参数（点击坐标、Input.insertText、dispatchKeyEvent 的键码、截图落盘等）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  EXPRESSION_MARKS,
  MODIFIER_BITS,
  PageHandle,
  asBrowserError,
  buildExpression,
  buildInlineExpression,
  buildKeyEvents,
  cssEscapeIdent,
  cssPathFromParts,
  describeElementLine,
  inlineScriptCatalog,
  isVisibleBox,
  keySpecFor,
  messageOf,
  normalizeMouseButton,
  normalizeWhitespace,
  parseKeyCombo,
  readPngSize,
  redactUrl,
  resolveScreenshotDir,
  screenshotFileName,
  truncateText,
} from '../lib/page.mjs';

/** 1x1 透明 PNG（真实字节，用于截图尺寸解析）。 */
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 建一个假 TargetSession。
 *
 * @param {{ onSend?: (method: string, params: object) => unknown, onWaitFor?: Function, targetId?: string }} [options]
 *   定制钩子。
 * @returns {object} 假 session。
 */
function createFakeSession(options = {}) {
  const calls = [];
  const listeners = new Map();
  const session = {
    targetId: options.targetId ?? 'TARGET-1',
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
    async waitFor(event, predicate, timeoutMs) {
      calls.push({ method: `waitFor:${event}`, params: { timeoutMs } });
      if (typeof options.onWaitFor === 'function') return options.onWaitFor(event, predicate, timeoutMs);
      return {};
    },
    detach() {},
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount(event) {
      return (listeners.get(event) ?? new Set()).size;
    },
  };
  return session;
}

/** 取 evaluate 表达式里的标记名。 */
function markOf(params) {
  const expression = typeof params?.expression === 'string' ? params.expression : '';
  for (const [name, mark] of Object.entries(EXPRESSION_MARKS)) {
    if (expression.includes(`/* ${mark} */`)) return name;
  }
  return '';
}

/** 构造 `{ result: { type, value } }`。 */
function evaluateResult(value) {
  return { result: { type: value === null ? 'object' : typeof value, value } };
}

/** 按标记返回默认结果。 */
function defaultEvaluateResponse(mark) {
  switch (mark) {
    case 'locate':
      return evaluateResult({ found: true, visible: true, error: '', x: 50, y: 60, width: 100, height: 20, tag: 'button' });
    case 'pageInfo':
      return evaluateResult({ url: 'https://example.test/page', title: 'Example Page' });
    case 'fill':
      return evaluateResult({ ok: true, error: '', value: 'filled' });
    case 'focus':
      return evaluateResult({ ok: true, error: '' });
    case 'snapshot':
      return evaluateResult({
        url: 'https://example.test/',
        title: 'Example',
        items: [
          { tag: 'button', type: 'submit', text: 'Go', path: '#go' },
          { tag: 'input', type: 'text', text: '', path: '#app > input' },
        ],
        text: 'hello world',
      });
    case 'waitSelector':
      return evaluateResult({ found: true, error: '' });
    case 'waitText':
      return evaluateResult({ found: true, error: '' });
    case 'elementObject':
      return { result: { type: 'object', objectId: 'OBJ-1' } };
    default:
      return evaluateResult(undefined);
  }
}

/** 默认 CDP 响应。 */
function fakeResponse(method, params = {}) {
  if (method === 'Runtime.evaluate') {
    const mark = markOf(params);
    if (mark !== '') return defaultEvaluateResponse(mark);
    return evaluateResult(42);
  }
  if (method === 'Page.captureScreenshot') return { data: ONE_PIXEL_PNG_BASE64 };
  if (method === 'Page.getLayoutMetrics') {
    return { cssContentSize: { width: 1280, height: 2400 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
  }
  if (method === 'Page.navigate') return { frameId: 'FRAME-1', loaderId: 'LOADER-1' };
  return {};
}

/** 找某一类 CDP 调用。 */
function callsOf(session, method) {
  return session.calls.filter((call) => call.method === method);
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

test('cssPathFromParts：id 优先、nth-of-type 链、跳过 html 前缀不需要', () => {
  assert.equal(
    cssPathFromParts([{ tag: 'html' }, { tag: 'body' }, { tag: 'div', id: 'app' }, { tag: 'button', nth: 2, countOfType: 3 }]),
    '#app > button:nth-of-type(2)',
  );
  // 目标自身有 id：直接返回 id，父级全部丢弃（id 唯一）
  assert.equal(cssPathFromParts([{ tag: 'html' }, { tag: 'body' }, { tag: 'div', id: 'target' }]), '#target');
  // 没有稳定标识：nth-of-type 链
  assert.equal(
    cssPathFromParts([
      { tag: 'html' },
      { tag: 'body' },
      { tag: 'div', nth: 1, countOfType: 2 },
      { tag: 'a', nth: 2, countOfType: 2 },
    ]),
    'html > body > div:nth-of-type(1) > a:nth-of-type(2)',
  );
  // 唯一同类兄弟时省略 nth-of-type
  assert.equal(cssPathFromParts([{ tag: 'body' }, { tag: 'main', nth: 1, countOfType: 1 }]), 'body > main');
});

test('cssPathFromParts：data-testid / name 锚点、特殊字符 id 退化成属性选择器', () => {
  assert.equal(
    cssPathFromParts([{ tag: 'body' }, { tag: 'form', testId: 'login-form' }, { tag: 'button', countOfType: 1 }]),
    '[data-testid="login-form"] > button',
  );
  assert.equal(cssPathFromParts([{ tag: 'body' }, { tag: 'input', name: 'email' }]), 'input[name="email"]');
  assert.equal(cssPathFromParts([{ tag: 'div', id: '123' }]), '[id="123"]', '数字开头不能做 #id');
  assert.equal(cssPathFromParts([{ tag: 'div', id: 'a:b' }]), '[id="a:b"]');
  assert.equal(cssPathFromParts([{ tag: 'div', id: 'a b' }]), '[id="a b"]');
  assert.equal(cssPathFromParts([{ tag: 'div', testId: 'say "hi"' }]), '[data-testid="say \\"hi\\""]');
  // 空 / 非法输入
  assert.equal(cssPathFromParts([]), '');
  assert.equal(cssPathFromParts(undefined), '');
  assert.equal(cssPathFromParts([{ tag: '' }, null, { tag: 'div', id: 'ok' }]), '#ok');
});

test('cssEscapeIdent 与 normalizeWhitespace', () => {
  assert.equal(cssEscapeIdent('plain-id_1'), 'plain-id_1');
  assert.equal(cssEscapeIdent('a:b'), 'a\\:b');
  assert.equal(cssEscapeIdent(''), '');
  assert.equal(normalizeWhitespace('  a \n\t b  '), 'a b');
  assert.equal(normalizeWhitespace(null), '');
});

test('isVisibleBox：尺寸、display、visibility、opacity、aria-hidden', () => {
  assert.equal(isVisibleBox({ width: 10, height: 10, display: 'block', visibility: 'visible', opacity: 1 }), true);
  assert.equal(isVisibleBox({ width: 0, height: 10 }), false);
  assert.equal(isVisibleBox({ width: 10, height: 0 }), false);
  assert.equal(isVisibleBox({ width: 10, height: 10, display: 'none' }), false);
  assert.equal(isVisibleBox({ width: 10, height: 10, visibility: 'hidden' }), false);
  assert.equal(isVisibleBox({ width: 10, height: 10, visibility: 'collapse' }), false);
  assert.equal(isVisibleBox({ width: 10, height: 10, opacity: 0 }), false);
  assert.equal(isVisibleBox({ width: 10, height: 10, ariaHidden: true }), false);
  assert.equal(isVisibleBox({ width: 10, height: 10, opacity: 0.5 }), true);
  assert.equal(isVisibleBox({ width: 10, height: 10 }), true, '缺省 opacity 视为 1');
  assert.equal(isVisibleBox(null), false);
});

test('describeElementLine：tag/type/文本/css path 的格式', () => {
  assert.equal(
    describeElementLine({ tag: 'BUTTON', type: 'submit', text: 'Sign   in', path: '#login > button' }),
    '- button[submit] "Sign in" => #login > button',
  );
  assert.equal(describeElementLine({ tag: 'a', path: '#x' }), '- a => #x');
  assert.equal(describeElementLine({ tag: 'input', type: 'text', text: '', path: '#q' }), '- input[text] => #q');
  assert.equal(describeElementLine({}), '- element => ');
  // 文本超长截断到 120
  const line = describeElementLine({ tag: 'p', text: 'x'.repeat(200), path: '#p' });
  assert.ok(line.includes('x'.repeat(120)) && !line.includes('x'.repeat(121)));
});

test('truncateText：短文本原样、长文本截断并说明', () => {
  assert.deepEqual(truncateText('hello', 10), { text: 'hello', truncated: false });
  const long = truncateText('x'.repeat(50), 10);
  assert.equal(long.truncated, true);
  assert.ok(long.text.startsWith('x'.repeat(10)));
  assert.ok(long.text.includes('已截断'));
  assert.equal(truncateText('abc', 0).truncated, false, '非法上限回落到默认值');
  assert.equal(DEFAULT_SNAPSHOT_MAX_CHARS, 12000);
});

test('redactUrl：隐去密码但保留用户名', () => {
  assert.equal(redactUrl('ws://user:secret@127.0.0.1:9222/devtools/browser/x'), 'ws://user:***@127.0.0.1:9222/devtools/browser/x');
  assert.equal(redactUrl('http://127.0.0.1:9222/json/version'), 'http://127.0.0.1:9222/json/version');
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl(undefined), '');
});

test('resolveScreenshotDir：显式目录 / DSH_HOME / 用户目录兜底', () => {
  assert.equal(resolveScreenshotDir('/tmp/shots', {}, '/home/u'), path.resolve('/tmp/shots'));
  assert.equal(
    resolveScreenshotDir('', { DSH_HOME: 'C:\\dsh-home' }, 'C:\\Users\\u'),
    path.join(path.resolve('C:\\dsh-home'), 'chrome-devtools', 'screenshots'),
  );
  assert.equal(
    resolveScreenshotDir('   ', {}, path.join('C:', 'Users', 'u')),
    path.join(path.resolve(path.join('C:', 'Users', 'u', '.dsh')), 'chrome-devtools', 'screenshots'),
  );
});

test('screenshotFileName：时间戳格式与扩展名', () => {
  const now = new Date(2026, 9, 20, 9, 47, 55, 123);
  assert.equal(screenshotFileName(now, 'png'), '20261020-094755-123.png');
  assert.equal(screenshotFileName(now, 'jpeg'), '20261020-094755-123.jpg');
  assert.equal(screenshotFileName(now, 'png').length, 23);
});

test('readPngSize：从 PNG 头读宽高，非 PNG 返回 undefined', () => {
  const png = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
  assert.deepEqual(readPngSize(png), { width: 1, height: 1 });
  assert.equal(readPngSize(Buffer.alloc(0)), undefined);
  assert.equal(readPngSize(Buffer.from('not a png at all, 24 bytes', 'utf8')), undefined);
  assert.equal(readPngSize('not a buffer'), undefined);
  // 构造一个 640x480 的 PNG 头
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(640, 16);
  header.writeUInt32BE(480, 20);
  assert.deepEqual(readPngSize(header), { width: 640, height: 480 });
});

test('keySpecFor：契约要求的常见键 + 字母数字标点，未知键 undefined', () => {
  assert.deepEqual(keySpecFor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.deepEqual(keySpecFor('Tab'), { key: 'Tab', code: 'Tab', vk: 9 });
  assert.deepEqual(keySpecFor('Escape'), { key: 'Escape', code: 'Escape', vk: 27 });
  assert.deepEqual(keySpecFor('Backspace'), { key: 'Backspace', code: 'Backspace', vk: 8 });
  assert.deepEqual(keySpecFor('Delete'), { key: 'Delete', code: 'Delete', vk: 46 });
  assert.deepEqual(keySpecFor('ArrowUp'), { key: 'ArrowUp', code: 'ArrowUp', vk: 38 });
  assert.deepEqual(keySpecFor('ArrowDown'), { key: 'ArrowDown', code: 'ArrowDown', vk: 40 });
  assert.deepEqual(keySpecFor('ArrowLeft'), { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
  assert.deepEqual(keySpecFor('ArrowRight'), { key: 'ArrowRight', code: 'ArrowRight', vk: 39 });
  assert.deepEqual(keySpecFor('Home'), { key: 'Home', code: 'Home', vk: 36 });
  assert.deepEqual(keySpecFor('End'), { key: 'End', code: 'End', vk: 35 });
  assert.deepEqual(keySpecFor('PageUp'), { key: 'PageUp', code: 'PageUp', vk: 33 });
  assert.deepEqual(keySpecFor('PageDown'), { key: 'PageDown', code: 'PageDown', vk: 34 });
  assert.deepEqual(keySpecFor('Space'), { key: ' ', code: 'Space', vk: 32, text: ' ' });
  assert.deepEqual(keySpecFor('F12'), { key: 'F12', code: 'F12', vk: 123 });
  assert.deepEqual(keySpecFor('F1'), { key: 'F1', code: 'F1', vk: 112 });
  assert.deepEqual(keySpecFor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keySpecFor('A'), { key: 'A', code: 'KeyA', vk: 65, text: 'A' });
  assert.deepEqual(keySpecFor('7'), { key: '7', code: 'Digit7', vk: 55 });
  assert.equal(keySpecFor('.').vk, 190);
  // 大小写不敏感的命名键
  assert.equal(keySpecFor('enter').vk, 13);
  assert.equal(keySpecFor('Nope'), undefined);
  assert.equal(keySpecFor(''), undefined);
});

test('parseKeyCombo：普通键、修饰键组合、非法输入', () => {
  assert.deepEqual(parseKeyCombo('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r', modifiers: 0 });
  const ctrlA = parseKeyCombo('Control+A');
  assert.equal(ctrlA.modifiers, MODIFIER_BITS.Control);
  assert.equal(ctrlA.key, 'A');
  assert.equal(parseKeyCombo('Shift+Tab').modifiers, MODIFIER_BITS.Shift);
  assert.equal(parseKeyCombo('Meta+Shift+z').modifiers, MODIFIER_BITS.Meta | MODIFIER_BITS.Shift);
  assert.equal(parseKeyCombo(' control + a ').modifiers, MODIFIER_BITS.Control);
  assert.equal(parseKeyCombo('Control+'), undefined, '没有主键');
  assert.equal(parseKeyCombo('A+B'), undefined, '两个主键');
  assert.equal(parseKeyCombo('Control+Unknown'), undefined);
  assert.equal(parseKeyCombo(''), undefined);
  assert.equal(parseKeyCombo(undefined), undefined);
});

test('buildKeyEvents：keyDown/keyUp、可打印键带 text、组合键不带 text', () => {
  const enter = buildKeyEvents(parseKeyCombo('Enter'));
  assert.equal(enter.length, 2);
  assert.deepEqual(enter[0], {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 0,
    text: '\r',
    unmodifiedText: '\r',
  });
  assert.deepEqual(enter[1], {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 0,
  });
  // Ctrl+A：快捷键不插入字符
  const copy = buildKeyEvents(parseKeyCombo('Control+a'));
  assert.equal(copy[0].text, undefined);
  assert.equal(copy[0].modifiers, 2);
  // Shift+a：event.key 变成大写，text 也大写
  const shifted = buildKeyEvents(parseKeyCombo('Shift+a'));
  assert.equal(shifted[0].key, 'A');
  assert.equal(shifted[0].text, 'A');
  assert.equal(shifted[0].modifiers, MODIFIER_BITS.Shift);
  assert.deepEqual(buildKeyEvents(undefined), []);
});

test('buildExpression：内联 helper 源码、JSON 化参数、注释标记', () => {
  const helper = (box) => box.width > 0;
  const expression = buildExpression(
    function locate(helpers, selector) {
      return helpers.ok(selector);
    },
    { ok: helper },
    ['#a'],
    EXPRESSION_MARKS.locate,
  );
  assert.ok(expression.includes('function locate'));
  assert.ok(expression.includes('function'));
  assert.ok(expression.includes('"#a"'));
  assert.ok(expression.includes('/* dsh-cdp:locate */'));
  // 无参数时不追加逗号
  const bare = buildExpression(function info() { return 1; }, {}, [], EXPRESSION_MARKS.pageInfo);
  assert.ok(bare.includes('({})'));
  assert.equal(markOf({ expression }), 'locate');
  assert.throws(() => buildExpression('nope'), TypeError);
});

test('asBrowserError / messageOf：稳定错误码归一', () => {
  assert.equal(asBrowserError(new Error('boom')).code, 'CDP_ERROR');
  assert.equal(asBrowserError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })).code, 'TIMEOUT');
  assert.equal(asBrowserError(Object.assign(new Error('fs'), { code: 'ENOENT' })).code, 'CDP_ERROR', '非契约错误码不外泄');
  const original = asBrowserError(new Error('x'));
  assert.equal(asBrowserError(original), original, 'BrowserError 原样返回');
  assert.equal(messageOf(new Error('msg')), 'msg');
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageOf(undefined), '未知错误');
  assert.equal(normalizeMouseButton('right'), 'right');
  assert.equal(normalizeMouseButton('middle'), 'middle');
  assert.equal(normalizeMouseButton('LEFT'), 'left');
  assert.equal(normalizeMouseButton(undefined), 'left');
});

/* ------------------------------------------------------------------ *
 * PageHandle
 * ------------------------------------------------------------------ */

test('PageHandle：首次操作只 enable 一次 Page/Runtime/DOM', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.url();
  await page.title();
  const enables = session.calls.filter((call) => ['Page.enable', 'Runtime.enable', 'DOM.enable'].includes(call.method));
  assert.deepEqual(
    enables.map((call) => call.method),
    ['Page.enable', 'Runtime.enable', 'DOM.enable'],
  );
  assert.equal(page.targetId, 'TARGET-1');
});

test('PageHandle.navigate：Page.navigate + 等 load 事件，返回真实 URL/title', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const result = await page.navigate('https://target.test/landing');
  assert.deepEqual(result, { url: 'https://example.test/page', title: 'Example Page' });
  const navigates = callsOf(session, 'Page.navigate');
  assert.equal(navigates.length, 1);
  assert.equal(navigates[0].params.url, 'https://target.test/landing');
  assert.ok(session.calls.some((call) => call.method === 'waitFor:Page.loadEventFired'), '应等 load 事件');
});

test('PageHandle.navigate：waitUntil=domcontentloaded 等对应事件；none 不等', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.navigate('https://target.test/', { waitUntil: 'domcontentloaded' });
  assert.ok(session.calls.some((call) => call.method === 'waitFor:Page.domContentEventFired'));
  const second = createFakeSession();
  const pageTwo = new PageHandle(second, 'TARGET-2');
  await pageTwo.navigate('https://target.test/', { waitUntil: 'none' });
  assert.equal(second.calls.filter((call) => call.method.startsWith('waitFor:')).length, 0);
});

test('PageHandle.navigate：CDP errorText 抛 CDP_ERROR，空 url 抛 INVALID_ARGUMENT', async () => {
  const session = createFakeSession({
    onSend: (method) => (method === 'Page.navigate' ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : undefined),
  });
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.navigate('https://bad.test/'),
    (error) => error.code === 'CDP_ERROR' && /ERR_NAME_NOT_RESOLVED/u.test(error.message),
  );
  await assert.rejects(
    () => page.navigate('   '),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('PageHandle.click：Input.dispatchMouseEvent 打到元素中心（不是 element.click()）', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const result = await page.click('button.submit');
  assert.deepEqual(result, { ok: true });
  const mouse = callsOf(session, 'Input.dispatchMouseEvent').map((call) => call.params);
  assert.deepEqual(
    mouse.map((params) => params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
  );
  for (const params of mouse) {
    assert.equal(params.x, 50, 'x 应为元素中心坐标');
    assert.equal(params.y, 60, 'y 应为元素中心坐标');
  }
  assert.equal(mouse[1].button, 'left');
  assert.equal(mouse[1].clickCount, 1);
  assert.equal(mouse[2].clickCount, 1);
  // locate 表达式里包含 scrollIntoView 与 getBoundingClientRect
  const locateCall = session.calls.find((call) => call.method === 'Runtime.evaluate' && markOf(call.params) === 'locate');
  assert.ok(locateCall.params.expression.includes('scrollIntoView'));
  assert.ok(locateCall.params.expression.includes('getBoundingClientRect'));
});

test('PageHandle.click：双击与右键', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.click('#item', { clickCount: 2, button: 'right' });
  const mouse = callsOf(session, 'Input.dispatchMouseEvent').map((call) => call.params);
  assert.deepEqual(
    mouse.map((params) => params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased'],
  );
  assert.equal(mouse[1].button, 'right');
  assert.equal(mouse[1].clickCount, 1);
  assert.equal(mouse[3].clickCount, 2);
});

test('PageHandle.click：元素不存在抛 TARGET_NOT_FOUND（带 selector 与当前 URL）', async () => {
  const session = createFakeSession({
    onSend: (method, params) =>
      method === 'Runtime.evaluate' && markOf(params) === 'locate'
        ? evaluateResult({ found: false, visible: false, error: '', x: 0, y: 0, width: 0, height: 0, tag: '' })
        : undefined,
  });
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.click('#missing', { timeoutMs: 30 }),
    (error) =>
      error.code === 'TARGET_NOT_FOUND' &&
      error.message.includes('#missing') &&
      error.message.includes('https://example.test/page') &&
      error.details.selector === '#missing',
  );
});

test('PageHandle.click：元素存在但不可见也抛 TARGET_NOT_FOUND（消息说明不可见）', async () => {
  const session = createFakeSession({
    onSend: (method, params) =>
      method === 'Runtime.evaluate' && markOf(params) === 'locate'
        ? evaluateResult({ found: true, visible: false, error: '', x: 0, y: 0, width: 0, height: 0, tag: 'div' })
        : undefined,
  });
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.click('.hidden', { timeoutMs: 20 }),
    (error) => error.code === 'TARGET_NOT_FOUND' && /不可见/u.test(error.message),
  );
});

test('PageHandle.click：非法 selector 抛 INVALID_ARGUMENT', async () => {
  const session = createFakeSession({
    onSend: (method, params) =>
      method === 'Runtime.evaluate' && markOf(params) === 'locate'
        ? evaluateResult({ found: false, visible: false, error: 'not a valid selector', x: 0, y: 0, width: 0, height: 0, tag: '' })
        : undefined,
  });
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.click(']]]'),
    (error) => error.code === 'INVALID_ARGUMENT' && /selector 非法/u.test(error.message),
  );
});

test('PageHandle.fill：native setter + input/change 事件（对受控组件生效）', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const result = await page.fill('#email', 'user@example.test');
  assert.deepEqual(result, { ok: true });
  const fillCall = session.calls.find((call) => call.method === 'Runtime.evaluate' && markOf(call.params) === 'fill');
  assert.ok(fillCall !== undefined, '必须发 fill 表达式');
  const expression = fillCall.params.expression;
  assert.ok(expression.includes('HTMLInputElement'));
  assert.ok(expression.includes('HTMLTextAreaElement'));
  assert.ok(expression.includes("getOwnPropertyDescriptor"));
  assert.ok(expression.includes('dispatchEvent'));
  assert.ok(expression.includes("new Event('input'"));
  assert.ok(expression.includes("new Event('change'"));
  assert.ok(expression.includes('"user@example.test"'));
});

test('PageHandle.fill：元素不存在抛 TARGET_NOT_FOUND', async () => {
  const session = createFakeSession({
    onSend: (method, params) =>
      method === 'Runtime.evaluate' && markOf(params) === 'fill'
        ? evaluateResult({ ok: false, error: 'element not found', notFound: true })
        : undefined,
  });
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.fill('#nope', 'x'),
    (error) => error.code === 'TARGET_NOT_FOUND',
  );
});

test('PageHandle.type：逐字符 Input.insertText，返回 code point 字符数', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const result = await page.type('ab😀', { selector: '#q' });
  assert.deepEqual(result, { ok: true, chars: 3 });
  const inserts = callsOf(session, 'Input.insertText').map((call) => call.params.text);
  assert.deepEqual(inserts, ['a', 'b', '😀'], 'emoji 按一个 code point 算');
  assert.ok(session.calls.some((call) => call.method === 'Runtime.evaluate' && markOf(call.params) === 'focus'));
});

test('PageHandle.type：未知 selector 类型不抛；非字符串 text 抛 INVALID_ARGUMENT', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.type(undefined),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('PageHandle.pressKey：Enter 发 keyDown+keyUp 且带 windowsVirtualKeyCode', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const result = await page.pressKey('Enter');
  assert.deepEqual(result, { ok: true });
  const events = callsOf(session, 'Input.dispatchKeyEvent').map((call) => call.params);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'keyDown');
  assert.equal(events[0].key, 'Enter');
  assert.equal(events[0].code, 'Enter');
  assert.equal(events[0].windowsVirtualKeyCode, 13);
  assert.equal(events[1].type, 'keyUp');
});

test('PageHandle.pressKey：组合键带 modifiers、未知键抛 INVALID_ARGUMENT', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.pressKey('Control+a', { selector: '#input' });
  const events = callsOf(session, 'Input.dispatchKeyEvent').map((call) => call.params);
  assert.equal(events[0].modifiers, 2);
  assert.equal(events[0].text, undefined);
  assert.ok(session.calls.some((call) => call.method === 'Runtime.evaluate' && markOf(call.params) === 'focus'));

  await assert.rejects(
    () => page.pressKey('Hyper+Q'),
    (error) => error.code === 'INVALID_ARGUMENT' && /不支持的键/u.test(error.message),
  );
});

test('PageHandle.hover：只发 mouseMoved', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.hover('.menu-item');
  const mouse = callsOf(session, 'Input.dispatchMouseEvent').map((call) => call.params);
  assert.equal(mouse.length, 1);
  assert.equal(mouse[0].type, 'mouseMoved');
  assert.equal(mouse[0].button, 'none');
  assert.equal(mouse[0].x, 50);
});

test('PageHandle.drag：按下、分步移动、在目标中心释放', async () => {
  const session = createFakeSession({
    onSend: (method, params) => {
      if (method !== 'Runtime.evaluate' || markOf(params) !== 'locate') return undefined;
      const expression = params.expression;
      // 源元素在 (50,60)，目标元素在 (250,160)
      const value = expression.includes('"#from"')
        ? { found: true, visible: true, error: '', x: 50, y: 60, width: 100, height: 20, tag: 'div' }
        : { found: true, visible: true, error: '', x: 250, y: 160, width: 100, height: 20, tag: 'div' };
      return evaluateResult(value);
    },
  });
  const page = new PageHandle(session, 'TARGET-1');
  await page.drag('#from', '#to');
  const mouse = callsOf(session, 'Input.dispatchMouseEvent').map((call) => call.params);
  assert.equal(mouse[0].type, 'mouseMoved');
  assert.equal(mouse[1].type, 'mousePressed');
  const moves = mouse.filter((params) => params.type === 'mouseMoved').slice(1);
  assert.equal(moves.length, 8, '应分步移动');
  assert.equal(moves.at(-1).x, 250);
  assert.equal(moves.at(-1).y, 160);
  for (const move of moves) assert.equal(move.buttons, 1);
  const released = mouse.at(-1);
  assert.equal(released.type, 'mouseReleased');
  assert.equal(released.x, 250);
  assert.equal(released.y, 160);
});

test('PageHandle.waitFor：selector+text 都命中、无条件与超时路径', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const matched = await page.waitFor({ selector: '#done', text: 'finished', timeoutMs: 1000 });
  assert.equal(matched.matched, true);
  assert.equal(matched.reason, 'text found');
  assert.ok(matched.waitedMs >= 0);

  const nothing = await page.waitFor({});
  assert.equal(nothing.matched, false);
  assert.ok(nothing.reason.includes('selector'));
  assert.equal(nothing.waitedMs, 0);

  const timeoutSession = createFakeSession({
    onSend: (method, params) =>
      method === 'Runtime.evaluate' && markOf(params) === 'waitSelector'
        ? evaluateResult({ found: false, error: '' })
        : undefined,
  });
  const timeoutPage = new PageHandle(timeoutSession, 'TARGET-2');
  const timedOut = await timeoutPage.waitFor({ selector: '#never', timeoutMs: 30 });
  assert.equal(timedOut.matched, false);
  assert.ok(timedOut.reason.includes('超时'));
});

test('PageHandle.setFiles：DOM.setFileInputFiles 带绝对路径与 objectId', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-page-upload-'));
  try {
    const file = path.join(directory, 'resume.txt');
    writeFileSync(file, 'hello', 'utf8');
    const session = createFakeSession();
    const page = new PageHandle(session, 'TARGET-1');
    const result = await page.setFiles('input[type=file]', [file]);
    assert.deepEqual(result, { ok: true });
    const upload = callsOf(session, 'DOM.setFileInputFiles')[0];
    assert.deepEqual(upload.params.files, [path.resolve(file)]);
    assert.equal(upload.params.objectId, 'OBJ-1');

    await assert.rejects(
      () => page.setFiles('input[type=file]', [path.join(directory, 'missing.txt')]),
      (error) => error.code === 'INVALID_ARGUMENT' && /不存在/u.test(error.message),
    );
    await assert.rejects(
      () => page.setFiles('input[type=file]', []),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PageHandle.screenshot：写到显式路径，返回字节数与 PNG 头解析的宽高', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-page-shot-'));
  try {
    const target = path.join(directory, 'nested', 'shot.png');
    const session = createFakeSession();
    const page = new PageHandle(session, 'TARGET-1');
    const result = await page.screenshot({ path: target });
    assert.equal(result.path, path.resolve(target));
    assert.deepEqual({ width: result.width, height: result.height }, { width: 1, height: 1 });
    assert.ok(result.bytes > 0);
    assert.equal(existsSync(target), true, '目录应被递归创建并写入文件');
    assert.deepEqual(readFileSync(target), Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
    assert.equal(callsOf(session, 'Page.captureScreenshot')[0].params.format, 'png');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PageHandle.screenshot：默认目录取 $DSH_HOME，fullPage 带 captureBeyondViewport', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-page-home-'));
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = directory;
    const session = createFakeSession();
    const page = new PageHandle(session, 'TARGET-1');
    const result = await page.screenshot({ fullPage: true, format: 'jpeg' });
    assert.equal(path.dirname(result.path), path.join(path.resolve(directory), 'chrome-devtools', 'screenshots'));
    assert.ok(path.basename(result.path).endsWith('.jpg'));
    assert.equal(existsSync(result.path), true);
    const params = callsOf(session, 'Page.captureScreenshot')[0].params;
    assert.equal(params.captureBeyondViewport, true);
    assert.equal(params.quality, 90);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PageHandle.screenshot：CDP 返回空数据时抛 CDP_ERROR', async () => {
  const session = createFakeSession({ onSend: (method) => (method === 'Page.captureScreenshot' ? { data: '' } : undefined) });
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.screenshot({ path: path.join(os.tmpdir(), 'dsh-never-written.png') }),
    (error) => error.code === 'CDP_ERROR',
  );
});

test('PageHandle.evaluate / evaluateDetailed：正常值、异常以数据返回、evaluate 抛错', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  assert.equal(await page.evaluate('40 + 2'), 42);
  const detail = await page.evaluateDetailed('40 + 2');
  assert.deepEqual(detail, { ok: true, value: 42, type: 'number', exception: '' });

  const throwing = createFakeSession({
    onSend: (method, params) =>
      method === 'Runtime.evaluate' && markOf(params) === ''
        ? { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } }
        : undefined,
  });
  const throwingPage = new PageHandle(throwing, 'TARGET-2');
  const failed = await throwingPage.evaluateDetailed('boom()');
  assert.equal(failed.ok, false);
  assert.equal(failed.type, 'exception');
  assert.equal(failed.exception, 'Error: boom');
  await assert.rejects(
    () => throwingPage.evaluate('boom()'),
    (error) => error.code === 'CDP_ERROR' && /Error: boom/u.test(error.message),
  );
  await assert.rejects(
    () => page.evaluate('   '),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('PageHandle.snapshot：可见可交互元素清单 + CSS path + 可见文本', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const snapshot = await page.snapshot({ maxChars: 12000 });
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.url, 'https://example.test/');
  assert.equal(snapshot.title, 'Example');
  assert.ok(snapshot.text.includes('- button[submit] "Go" => #go'));
  assert.ok(snapshot.text.includes('- input[text] => #app > input'));
  assert.ok(snapshot.text.includes('hello world'));
  assert.ok(snapshot.text.includes('可交互元素：2'));
  // 表达式里内联了 collectSnapshot + 纯函数 helper（同一份实现）
  const snapshotCall = session.calls.find((call) => call.method === 'Runtime.evaluate' && markOf(call.params) === 'snapshot');
  assert.ok(snapshotCall.params.expression.includes('cssPathFromParts'));
  assert.ok(snapshotCall.params.expression.includes('isVisibleBox'));
  assert.ok(snapshotCall.params.expression.includes('data-testid'));
});

test('PageHandle.snapshot：maxChars 很小时截断并标记', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  const snapshot = await page.snapshot({ maxChars: 100 });
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.text.length <= 100 + 80, '截断后只比上限多一点提示文本');
  assert.ok(snapshot.text.includes('已截断'));
});

test('PageHandle 对话框：pendingDialog、操作被阻塞、handleDialog 处理', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.enableConsoleCapture(); // 触发 enable，挂上 dialog 监听
  assert.equal(session.listenerCount('Page.javascriptDialogOpening'), 1);
  session.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?', url: 'https://example.test/' });
  assert.deepEqual(page.pendingDialog, { type: 'confirm', message: 'Sure?', url: 'https://example.test/' });

  await assert.rejects(
    () => page.click('#ok'),
    (error) => error.code === 'CDP_ERROR' && /browser_handle_dialog/u.test(error.message) && /confirm/u.test(error.message),
  );

  const handled = await page.handleDialog(true);
  assert.deepEqual(handled, { handled: true, dialogType: 'confirm', dialogMessage: 'Sure?' });
  assert.equal(page.pendingDialog, undefined);
  const handleCall = callsOf(session, 'Page.handleJavaScriptDialog')[0];
  assert.equal(handleCall.params.accept, true);
});

test('PageHandle 对话框：enableDialogAutoHandle 自动处理并清空 pendingDialog', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.enableConsoleCapture();
  page.enableDialogAutoHandle(false);
  session.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const handleCall = callsOf(session, 'Page.handleJavaScriptDialog')[0];
  assert.equal(handleCall.params.accept, false);
  assert.equal(page.pendingDialog, undefined);
});

test('PageHandle 对话框：onDialog 回调收到事件；handleDialog 无对话框时抛 CDP_ERROR', async () => {
  const session = createFakeSession({
    onSend: (method) =>
      method === 'Page.handleJavaScriptDialog'
        ? Promise.reject(Object.assign(new Error('No dialog is showing'), { code: 'CDP_ERROR' }))
        : undefined,
  });
  const page = new PageHandle(session, 'TARGET-1');
  await page.enableConsoleCapture();
  const seen = [];
  page.onDialog((dialog) => seen.push(dialog));
  session.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', url: 'https://x.test/' });
  assert.deepEqual(seen, [{ type: 'prompt', message: 'Name?', url: 'https://x.test/' }]);
  await assert.rejects(
    () => page.handleDialog(true, 'Alice'),
    (error) => error.code === 'CDP_ERROR' && /No dialog/u.test(error.message),
  );
});

test('PageHandle 控制台/网络采集：事件经 Registry 进入 list', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.enableConsoleCapture();
  assert.deepEqual(page.consoleMessages(), []);
  session.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] });
  assert.deepEqual(page.consoleMessages(), [{ type: 'error', text: 'boom', url: '', line: 0 }]);

  await page.enableNetworkCapture();
  assert.ok(callsOf(session, 'Network.enable').length === 1);
  session.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    type: 'Document',
    request: { url: 'https://example.test/', method: 'GET' },
  });
  session.emit('Network.responseReceived', { requestId: 'R1', response: { status: 200, mimeType: 'text/html' } });
  assert.deepEqual(page.networkRequests().map((request) => [request.url, request.status]), [['https://example.test/', 200]]);
  // 幂等：再次 enable 不重复 Network.enable
  await page.enableNetworkCapture();
  assert.equal(callsOf(session, 'Network.enable').length, 1);
});

test('PageHandle.dispose：取消监听、之后操作抛 PROTOCOL_ERROR', async () => {
  const session = createFakeSession();
  const page = new PageHandle(session, 'TARGET-1');
  await page.enableConsoleCapture();
  page.dispose();
  assert.equal(page.disposed, true);
  assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0);
  assert.equal(session.listenerCount('Page.javascriptDialogOpening'), 0);
  await assert.rejects(
    () => page.url(),
    (error) => error.code === 'PROTOCOL_ERROR' && /释放/u.test(error.message),
  );
  // 重复 dispose 不抛
  page.dispose();
});

test('PageHandle：session.send 抛错时归一成 BrowserError', async () => {
  const session = createFakeSession({
    onSend: (method) => (method === 'Page.navigate' ? Promise.reject(new Error('socket closed')) : undefined),
  });
  const page = new PageHandle(session, 'TARGET-1');
  await assert.rejects(
    () => page.navigate('https://x.test/'),
    (error) => error.code === 'CDP_ERROR' && /socket closed/u.test(error.message),
  );
});

test('PageHandle：没有 send 方法的 session 抛 NOT_CONNECTED', async () => {
  const page = new PageHandle({}, 'TARGET-X');
  await assert.rejects(
    () => page.url(),
    (error) => error.code === 'NOT_CONNECTED',
  );
});

test('PageHandle：waitFor 缺失时 navigate 用 readyState 轮询兜底', async () => {
  const session = createFakeSession({
    onSend: (method, params) => {
      if (method !== 'Runtime.evaluate') return undefined;
      if (params.expression === 'document.readyState') return evaluateResult('complete');
      return undefined;
    },
  });
  delete session.waitFor;
  const page = new PageHandle(session, 'TARGET-1');
  const result = await page.navigate('https://target.test/');
  assert.equal(result.title, 'Example Page');
});

/* ------------------------------------------------------------------ *
 * 防复发：内联脚本自由变量审计
 *
 * 背景（真实事故）：`browser_snapshot` 在真实 Loader 里抛
 * `ReferenceError: normalizeStep is not defined`。原因是 `cssPathFromParts` 被
 * `toString()` 内联进页面后，引用了模块作用域的 `normalizeStep` / `escapeAttributeValue`，
 * 而对象属性名不会成为表达式作用域里的变量。假 session 测试按 `/* dsh-cdp:* *​/` 标记
 * 直接返回固定值、从不真正执行内联脚本，所以 133 个单测全绿也测不出来。
 *
 * 这里做三层防护：
 *   1. 静态审计：对 `inlineScriptCatalog()` 的每个脚本，解析源码找出自由标识符；
 *   2. vm 真实执行：用最小 DOM 在 `node:vm` 里真的跑一遍每个表达式（能抓 ReferenceError）；
 *   3. 源码锁：`PageHandle` 类体内不允许出现裸的 `buildExpression(...)` 调用。
 * ------------------------------------------------------------------ */

/** JS 关键字/字面量：不可能是自由变量。 */
const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'yield', 'get', 'set',
]);

/** 内联脚本允许引用的浏览器 / JS 全局（其余自由标识符必须在 helpers 里或函数体内声明）。 */
const ALLOWED_INLINE_GLOBALS = new Set([
  // JS 内置
  'Array', 'BigInt', 'Boolean', 'Date', 'Error', 'Infinity', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object',
  'Promise', 'RangeError', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'TypeError', 'WeakMap', 'WeakSet',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
  'queueMicrotask', 'setTimeout', 'clearTimeout', 'structuredClone', 'globalThis',
  // 浏览器 API
  'document', 'window', 'location', 'navigator', 'console', 'getComputedStyle', 'getSelection', 'history',
  'performance', 'screen', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Event', 'CustomEvent', 'InputEvent', 'KeyboardEvent', 'MouseEvent',
  'HTMLElement', 'Element', 'Node', 'NodeList', 'HTMLCollection',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLFormElement',
  'File', 'FileList', 'FormData', 'DataTransfer', 'FileReader', 'Blob', 'URL', 'URLSearchParams',
  'atob', 'btoa', 'TextEncoder', 'TextDecoder', 'Uint8Array', 'Int32Array', 'Float64Array',
]);

/** 正则字面量的合法前驱字符（用于把 `/…/flags` 从代码里抹掉，避免正则内容被当成标识符）。 */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '?', '!', '&', '|', '[', '{', ';', '+', '-', '*', '%', '<', '>']);

/**
 * 把注释、字符串、模板字面量文本、正则字面量抹成空格（保留模板 `${}` 里的代码）。
 *
 * @param {string} source - JS 源码。
 * @returns {string} 同长度级别的「纯代码」文本（空白位置被替换）。
 */
function scrubLiterals(source) {
  let out = '';
  let index = 0;
  const length = source.length;

  const lastNonSpace = () => out.replace(/\s+$/u, '').at(-1) ?? '';

  /** 扫描一段代码；`terminator === '}'` 时遇到未配对的 `}` 返回（用于模板 `${}`）。 */
  const scrubCode = (terminator) => {
    while (index < length) {
      const char = source[index];
      const next = source[index + 1];
      if (terminator === '}' && char === '}') return;
      if (char === '/' && next === '/') {
        while (index < length && source[index] !== '\n') {
          out += ' ';
          index += 1;
        }
        continue;
      }
      if (char === '/' && next === '*') {
        index += 2;
        out += '  ';
        while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
          out += source[index] === '\n' ? '\n' : ' ';
          index += 1;
        }
        if (index < length) {
          out += '  ';
          index += 2;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        const quote = char;
        out += ' ';
        index += 1;
        while (index < length) {
          if (source[index] === '\\') {
            out += '  ';
            index += 2;
            continue;
          }
          if (source[index] === quote) {
            out += ' ';
            index += 1;
            break;
          }
          out += source[index] === '\n' ? '\n' : ' ';
          index += 1;
        }
        continue;
      }
      if (char === '`') {
        out += ' ';
        index += 1;
        while (index < length) {
          if (source[index] === '\\') {
            out += '  ';
            index += 2;
            continue;
          }
          if (source[index] === '`') {
            out += ' ';
            index += 1;
            break;
          }
          if (source[index] === '$' && source[index + 1] === '{') {
            // 保留 ${} 里的代码，但不要把 '$' 留在输出里（否则会被当成标识符）
            out += '  ';
            index += 2;
            scrubCode('}');
            if (index < length && source[index] === '}') {
              out += ' ';
              index += 1;
            }
            continue;
          }
          out += source[index] === '\n' ? '\n' : ' ';
          index += 1;
        }
        continue;
      }
      if (char === '/' && next !== '/' && next !== '*') {
        const previous = lastNonSpace();
        if (previous === '' || REGEX_PRECEDERS.has(previous)) {
          // 正则字面量：吞到未转义的闭合 `/`（字符类里的 `/` 不闭合），再吃 flags
          out += ' ';
          index += 1;
          let inClass = false;
          while (index < length) {
            const current = source[index];
            if (current === '\\') {
              out += '  ';
              index += 2;
              continue;
            }
            if (current === '[') inClass = true;
            else if (current === ']') inClass = false;
            else if (current === '/' && !inClass) {
              index += 1;
              break;
            } else if (current === '\n') {
              break;
            }
            index += 1;
          }
          while (index < length && /[a-z]/u.test(source[index])) index += 1;
          out += ' ';
          continue;
        }
      }
      out += char;
      index += 1;
    }
  };

  scrubCode(undefined);
  return out;
}

/**
 * 收集箭头函数参数名：从每个 `=>` 向前找配对的括号（比正则可靠，
 * `options.find((option) => …)` 这种嵌套括号也能取到 `option`）。
 *
 * @param {string} code - 已抹掉字面量的代码。
 * @returns {Set<string>} 参数名集合。
 */
function collectArrowParams(code) {
  const names = new Set();
  for (const match of code.matchAll(/=>/gu)) {
    const before = code.slice(0, match.index).replace(/\s+$/u, '');
    if (before.endsWith(')')) {
      let depth = 0;
      let index = before.length - 1;
      for (; index >= 0; index -= 1) {
        if (before[index] === ')') depth += 1;
        else if (before[index] === '(') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const parameters = before.slice(index + 1, before.length - 1);
      for (const parameter of parameters.split(',')) {
        const name = parameter.trim().replace(/=.*$/u, '').trim();
        if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
      }
    } else {
      const single = /([A-Za-z_$][\w$]*)$/u.exec(before);
      if (single !== null) names.add(single[1]);
    }
  }
  return names;
}

/**
 * 收集函数源码里的声明名：函数名、参数、箭头函数参数、const/let/var、catch 参数。
 *
 * @param {string} code - 已抹掉字面量的代码。
 * @returns {Set<string>} 声明名集合。
 */
function collectDeclaredNames(code) {
  const names = new Set();
  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/gu)) {
    if (match[1] !== undefined) names.add(match[1]);
    for (const parameter of (match[2] ?? '').split(',')) {
      const name = parameter.trim().replace(/=.*$/u, '').trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
    }
  }
  for (const name of collectArrowParams(code)) names.add(name);
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  for (const match of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  return names;
}

/**
 * 找出一段函数源码里的「自由标识符」：不是关键字、不是声明名、不是白名单全局、
 * 不是属性访问（`x.y` 的 y）、不是对象字面量 key。
 *
 * @param {string} source - 函数源码（`fn.toString()`）。
 * @returns {Set<string>} 自由标识符集合。
 */
function freeIdentifiersIn(source) {
  const code = scrubLiterals(source);
  const declared = collectDeclaredNames(code);
  const free = new Set();
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const name = match[0];
    if (JS_KEYWORDS.has(name)) continue;
    if (declared.has(name)) continue;
    if (ALLOWED_INLINE_GLOBALS.has(name)) continue;
    const before = code.slice(0, match.index).replace(/\s+$/u, '');
    if (before.endsWith('.') || before.endsWith('?.')) continue; // 属性访问
    const after = code.slice(match.index + name.length).replace(/^\s+/u, '');
    const previous = before.at(-1);
    if (after.startsWith(':') && (previous === '{' || previous === ',')) continue; // 对象字面量 key
    free.add(name);
  }
  return free;
}

test('扫描器自检：能真的抓到模块级 normalizeStep 这种漏（不是空转）', () => {
  const synthetic = 'function f(a){ const local = 1; return normalizeStep(a) + escapeAttributeValue(a) + document.body; }';
  assert.deepEqual([...freeIdentifiersIn(synthetic)].sort(), ['escapeAttributeValue', 'normalizeStep']);
  // 正则/字符串/模板文本不能被误判成标识符
  const literals = 'function g(x){ return x.replace(/[A-Za-z]/gu, "abc") + `${x.foo}` + DocumentTitle; }';
  assert.deepEqual([...freeIdentifiersIn(literals)], ['DocumentTitle']);
});

test('内联脚本自由变量审计：每个脚本只引用参数/局部声明/浏览器全局', () => {
  const catalog = inlineScriptCatalog();
  assert.ok(catalog.length >= 8, `内联脚本注册表应有 >=8 项，实际 ${catalog.length}`);
  // catalog 与 EXPRESSION_MARKS 一一对应（避免新增脚本忘了标记）
  assert.deepEqual(catalog.map((script) => script.name).sort(), Object.keys(EXPRESSION_MARKS).sort());
  for (const script of catalog) {
    assert.ok(script.expression.includes(`/* ${script.mark} */`), `${script.name}: 表达式应带自己的标记`);
    const allowed = new Set(script.helpers);
    const unknown = [...freeIdentifiersIn(script.source)].filter((name) => !allowed.has(name));
    assert.deepEqual(
      unknown,
      [],
      `${script.name} 的内联脚本引用了页面作用域里不存在的标识符：${unknown.join(', ')}。` +
        ' 内联函数必须自包含（把辅助函数声明在函数体内），或通过 helpers 参数传入。',
    );
  }
});

test('内联脚本的 helper 都是 page.mjs 真实导出的函数', async () => {
  const module = await import('../lib/page.mjs');
  for (const script of inlineScriptCatalog()) {
    for (const helper of script.helpers) {
      assert.equal(typeof module[helper], 'function', `${script.name}: helper "${helper}" 不是函数`);
      // helper 自身也必须是自包含的（它会被 toString 内联）
      const free = freeIdentifiersIn(module[helper].toString());
      const allowed = new Set(script.helpers);
      const unknown = [...free].filter((name) => !allowed.has(name));
      assert.deepEqual(unknown, [], `${script.name}: helper "${helper}" 也引用了页面里不存在的标识符：${unknown.join(', ')}`);
    }
  }
});

test('源码锁：PageHandle 类体内不允许裸 buildExpression 调用（必须走注册表）', () => {
  const source = readFileSync(fileURLToPath(new URL('../lib/page.mjs', import.meta.url)), 'utf8');
  const classIndex = source.indexOf('export class PageHandle');
  assert.ok(classIndex > 0, '找不到 PageHandle 类定义');
  const classBody = source.slice(classIndex);
  assert.ok(
    !/buildExpression\s*\(/u.test(classBody),
    'PageHandle 内必须通过 buildInlineExpression(name, args) 构造表达式；裸 buildExpression 不会进注册表，防复发测试覆盖不到',
  );
  const inlineCalls = classBody.match(/buildInlineExpression\s*\(/gu) ?? [];
  assert.ok(inlineCalls.length >= 8, `PageHandle 内应有 >=8 处 buildInlineExpression 调用，实际 ${inlineCalls.length}`);
});

/**
 * 建一个只够内联脚本跑起来的最小 DOM，放进 vm 上下文。
 *
 * @returns {{ context: object, elements: object }} vm 上下文与元素引用。
 */
function createMiniDom() {
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = init.bubbles === true;
      this.data = init.data;
      this.inputType = init.inputType;
    }
  }
  class FakeInputEvent extends FakeEvent {}
  class FakeInput {
    constructor() {
      this.__value = '';
    }
  }
  Object.defineProperty(FakeInput.prototype, 'value', {
    configurable: true,
    get() {
      return this.__value;
    },
    set(value) {
      this.__value = String(value);
    },
  });
  class FakeTextArea extends FakeInput {}
  class FakeSelect extends FakeInput {}

  const makeElement = (tagName, init = {}) => {
    const element = init.proto === undefined ? {} : Object.create(init.proto);
    Object.assign(element, {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      id: init.id ?? '',
      type: init.type ?? '',
      children: [],
      parentElement: init.parent ?? null,
      innerText: init.text ?? '',
      isContentEditable: false,
      attributes: init.attributes ?? {},
      events: [],
      scrollIntoView() {},
      focus() {},
      dispatchEvent(event) {
        this.events.push(event);
        return true;
      },
      getBoundingClientRect() {
        return { left: 10, top: 20, width: 100, height: 40 };
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
    });
    return element;
  };

  const body = makeElement('body', { text: 'Hi' });
  const button = makeElement('button', { id: 'a', text: 'Hi', parent: body });
  const input = makeElement('input', {
    type: 'text',
    parent: body,
    proto: FakeInput.prototype,
    attributes: { name: 'q', type: 'text' },
  });
  body.children = [button, input];

  const context = vm.createContext({
    document: {
      title: 'Mini',
      body,
      querySelectorAll: () => [button, input],
      querySelector: (selector) => ({ '#a': button, '[name="q"]': input, input })[selector] ?? null,
    },
    window: {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      location: { href: 'https://mini.test/page' },
      HTMLInputElement: FakeInput,
      HTMLTextAreaElement: FakeTextArea,
      HTMLSelectElement: FakeSelect,
    },
    location: { href: 'https://mini.test/page' },
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
  });
  return { context, elements: { body, button, input } };
}

test('内联脚本在 vm 迷你 DOM 里真实执行：不再 ReferenceError，snapshot 生成 CSS path（本次事故的回归）', async () => {
  const { context, elements } = createMiniDom();
  const scriptArgs = {
    locate: ['#a'],
    pageInfo: [],
    fill: ['[name="q"]', 'hello'],
    focus: ['#a'],
    snapshot: [{ selector: '*', limit: 10 }],
    waitSelector: ['#a'],
    waitText: ['Hi'],
    elementObject: ['#a'],
  };
  /** @type {Map<string, any>} */
  const values = new Map();
  for (const script of inlineScriptCatalog()) {
    const expression = buildInlineExpression(script.name, scriptArgs[script.name] ?? []);
    // 关键：这里是真的执行（vm 里没有模块作用域）。修复前 snapshot 会抛
    // ReferenceError: normalizeStep is not defined —— 正是本次事故。
    values.set(script.name, vm.runInContext(expression, context));
  }

  const snapshot = values.get('snapshot');
  // vm 里创建的对象原型属于另一个 realm，deepStrictEqual 会因原型不同而失败；JSON 化后比较值。
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.items.map((item) => item.path))),
    ['#a', 'input[name="q"]'],
    'snapshot 必须为每个元素生成稳定 CSS path（id / name 锚点）',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.items.map((item) => item.tag))), ['button', 'input']);
  assert.equal(snapshot.url, 'https://mini.test/page');
  assert.equal(snapshot.title, 'Mini');
  assert.equal(snapshot.text, 'Hi');

  const located = values.get('locate');
  assert.equal(located.found, true);
  assert.equal(located.visible, true);
  assert.deepEqual(JSON.parse(JSON.stringify({ x: located.x, y: located.y })), { x: 60, y: 40 }, '点击坐标应是元素中心');
  assert.equal(values.get('pageInfo').url, 'https://mini.test/page');
  assert.equal(values.get('pageInfo').title, 'Mini');
  assert.equal(values.get('focus').ok, true);
  assert.equal(values.get('waitSelector').found, true);
  assert.equal(values.get('waitText').found, true);
  assert.equal(values.get('elementObject'), elements.button);

  const filled = values.get('fill');
  assert.equal(filled.ok, true, `fill 应成功，实际 ${JSON.stringify(filled)}`);
  assert.equal(elements.input.__value, 'hello', 'native setter 应在真实执行里生效');
  assert.equal(elements.input.events.map((event) => event.type).join(','), 'input,change', '应派发 input + change');
});

