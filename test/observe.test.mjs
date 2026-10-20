/**
 * `lib/observe.mjs` 的单测：控制台/网络环形缓冲。
 *
 * 全部离线：用假 session 手动 emit CDP 事件，不启动 Chrome。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConsoleRegistry,
  NetworkRegistry,
  DEFAULT_BUFFER_SIZE,
  exceptionRecord,
  normalizeConsoleType,
  remoteObjectText,
} from '../lib/observe.mjs';

/**
 * 建一个只有事件能力的假 session。
 *
 * @returns {object} 带 `on` / `emit` / `listenerCount` 的假 session。
 */
function createFakeSession() {
  const listeners = new Map();
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount(event) {
      return (listeners.get(event) ?? new Set()).size;
    },
  };
}

test('normalizeConsoleType 归一化 warn/err 与大小写', () => {
  assert.equal(normalizeConsoleType('warn'), 'warning');
  assert.equal(normalizeConsoleType('warning'), 'warning');
  assert.equal(normalizeConsoleType('err'), 'error');
  assert.equal(normalizeConsoleType('ERROR'), 'error');
  assert.equal(normalizeConsoleType('LOG'), 'log');
  assert.equal(normalizeConsoleType(''), 'log');
  assert.equal(normalizeConsoleType(undefined), 'log');
  assert.equal(normalizeConsoleType('trace'), 'trace');
});

test('remoteObjectText 覆盖 value / unserializableValue / description 三条路径', () => {
  assert.equal(remoteObjectText({ type: 'string', value: 'hello' }), 'hello');
  assert.equal(remoteObjectText({ type: 'number', value: 42 }), '42');
  assert.equal(remoteObjectText({ type: 'boolean', value: false }), 'false');
  assert.equal(remoteObjectText({ type: 'number', unserializableValue: 'NaN' }), 'NaN');
  assert.equal(remoteObjectText({ type: 'object', description: 'HTMLDivElement' }), 'HTMLDivElement');
  assert.equal(remoteObjectText({ type: 'object', value: { a: 1 } }), '{"a":1}');
  assert.equal(remoteObjectText({ type: 'undefined' }), 'undefined');
  assert.equal(remoteObjectText(undefined), '');
});

test('exceptionRecord 提取异常文本、URL 与 1-based 行号', () => {
  const record = exceptionRecord({
    exceptionDetails: {
      text: 'Uncaught',
      lineNumber: 7,
      url: 'https://example.test/app.js',
      exception: { description: 'Error: boom' },
    },
  });
  assert.deepEqual(record, { text: 'Error: boom', url: 'https://example.test/app.js', line: 8 });
  // 没有 exception.description 时退回 text
  assert.equal(exceptionRecord({ exceptionDetails: { text: 'Uncaught TypeError' } }).text, 'Uncaught TypeError');
  assert.deepEqual(exceptionRecord(undefined), { text: '', url: '', line: 0 });
});

test('ConsoleRegistry 收集 consoleAPICalled（多参数 join、stackTrace 定位）', () => {
  const session = createFakeSession();
  const registry = new ConsoleRegistry(session).start();
  session.emit('Runtime.consoleAPICalled', {
    type: 'warning',
    args: [{ type: 'string', value: 'retry' }, { type: 'number', value: 2 }],
    stackTrace: { callFrames: [{ url: 'https://example.test/a.js', lineNumber: 3 }] },
  });
  const messages = registry.list();
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { type: 'warning', text: 'retry 2', url: 'https://example.test/a.js', line: 4 });
  registry.stop();
});

test('ConsoleRegistry 把 exceptionThrown 记为 exception 类型', () => {
  const session = createFakeSession();
  const registry = new ConsoleRegistry(session).start();
  session.emit('Runtime.exceptionThrown', {
    exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' }, lineNumber: 0 },
  });
  assert.deepEqual(registry.list()[0], { type: 'exception', text: 'TypeError: x is undefined', url: '', line: 1 });
});

test('ConsoleRegistry 缓冲上限淘汰最旧的（默认 200）', () => {
  const session = createFakeSession();
  const registry = new ConsoleRegistry(session).start();
  assert.equal(registry.bufferSize, DEFAULT_BUFFER_SIZE);
  for (let index = 0; index < 250; index += 1) {
    session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'number', value: index }] });
  }
  assert.equal(registry.list({ limit: 500 }).length, 200, '缓冲最多 200 条');
  const recent = registry.list({ limit: 2 });
  assert.deepEqual(recent.map((message) => message.text), ['248', '249']);
});

test('ConsoleRegistry.list 支持 limit 与 types 过滤（warn 归一后匹配）', () => {
  const session = createFakeSession();
  const registry = new ConsoleRegistry(session).start();
  session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'a' }] });
  session.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'b' }] });
  session.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'c' }] });
  assert.deepEqual(registry.list({ types: ['error'] }).map((message) => message.text), ['c']);
  assert.deepEqual(registry.list({ types: ['warn'] }).map((message) => message.text), ['b'], 'warn 应匹配 warning');
  assert.deepEqual(registry.list({ limit: 1 }).map((message) => message.text), ['c']);
  assert.deepEqual(registry.list({ limit: 0 }), []);
  // clear 之后为空
  registry.clear();
  assert.deepEqual(registry.list(), []);
});

test('ConsoleRegistry.stop 之后不再接收事件', () => {
  const session = createFakeSession();
  const registry = new ConsoleRegistry(session).start();
  assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 1);
  registry.stop();
  assert.equal(session.listenerCount('Runtime.consoleAPICalled'), 0);
  session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'ignored' }] });
  assert.deepEqual(registry.list(), []);
});

test('NetworkRegistry 合并 requestWillBeSent + responseReceived', () => {
  const session = createFakeSession();
  const registry = new NetworkRegistry(session).start();
  session.emit('Network.requestWillBeSent', {
    requestId: 'REQ-1',
    type: 'Fetch',
    request: { url: 'https://api.example.test/items', method: 'POST' },
  });
  session.emit('Network.responseReceived', {
    requestId: 'REQ-1',
    type: 'Fetch',
    response: { status: 201, mimeType: 'application/json', url: 'https://api.example.test/items' },
  });
  const requests = registry.list();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    url: 'https://api.example.test/items',
    method: 'POST',
    status: 201,
    resourceType: 'Fetch',
    mimeType: 'application/json',
    failed: false,
    errorText: '',
  });
});

test('NetworkRegistry 记录 loadingFailed（保留原 url/method，标记 failed）', () => {
  const session = createFakeSession();
  const registry = new NetworkRegistry(session).start();
  session.emit('Network.requestWillBeSent', {
    requestId: 'REQ-2',
    type: 'Image',
    request: { url: 'https://cdn.example.test/x.png', method: 'GET' },
  });
  session.emit('Network.loadingFailed', { requestId: 'REQ-2', errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
  const [request] = registry.list();
  assert.equal(request.failed, true);
  assert.equal(request.errorText, 'net::ERR_BLOCKED_BY_CLIENT');
  assert.equal(request.url, 'https://cdn.example.test/x.png');
  assert.equal(request.method, 'GET');
  assert.equal(request.resourceType, 'Image');
});

test('NetworkRegistry 缓冲上限与 limit，并保留请求发起顺序', () => {
  const session = createFakeSession();
  const registry = new NetworkRegistry(session).start();
  for (let index = 0; index < 230; index += 1) {
    session.emit('Network.requestWillBeSent', {
      requestId: `REQ-${index}`,
      type: 'XHR',
      request: { url: `https://example.test/${index}`, method: 'GET' },
    });
  }
  const all = registry.list({ limit: 500 });
  assert.equal(all.length, 200, '缓冲最多 200 条');
  assert.equal(all[0].url, 'https://example.test/30');
  assert.equal(all[199].url, 'https://example.test/229');
  assert.equal(registry.list({ limit: 1 })[0].url, 'https://example.test/229');
  assert.deepEqual(registry.list({ limit: 0 }), []);
});

test('NetworkRegistry.stop 之后不再接收事件；无 on 方法的 session 不炸', () => {
  const session = createFakeSession();
  const registry = new NetworkRegistry(session).start();
  registry.stop();
  assert.equal(session.listenerCount('Network.requestWillBeSent'), 0);
  session.emit('Network.requestWillBeSent', { requestId: 'REQ-X', request: { url: 'https://x.test' } });
  assert.deepEqual(registry.list(), []);

  const bare = new NetworkRegistry({}).start();
  assert.deepEqual(bare.list(), []);
  bare.stop();
  const bareConsole = new ConsoleRegistry({}).start();
  assert.deepEqual(bareConsole.list(), []);
  bareConsole.stop();
});
