// lib/cdp.mjs 的离线单测。
//
// 核心是文件末尾那个**手写的最小 fake CDP WebSocket 服务器**（node:http upgrade +
// RFC 6455 帧编解码）：真实 Chrome 从不参与单测，协议行为（id 配对、CDP error、
// 连接关闭时 pending reject、事件订阅、sessionId 过滤）全部由它驱动。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { BrowserError } from '../lib/errors.mjs';
import {
  CdpBrowser,
  CdpConnection,
  prepareWebSocketUrl,
} from '../lib/cdp.mjs';

// ---------------------------------------------------------------------------
// 最小 WebSocket 编解码（RFC 6455 子集：文本/二进制/close/ping/pong，无扩展、无分片）
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** 编码一个服务器→客户端帧（不 mask）。 */
function encodeFrame(payload, opcode = OPCODE_TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

/**
 * 从缓冲区解出一个帧；数据不足返回 undefined。
 *
 * @returns {{ fin: boolean, opcode: number, payload: Buffer, rest: Buffer } | undefined}
 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('帧过长');
    length = Number(big);
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { fin, opcode, payload, rest: buffer.subarray(offset + length) };
}

/** 一个已握手的 fake 客户端（服务器视角）。 */
class FakeClient {
  constructor(socket, request) {
    this.socket = socket;
    this.request = request;
    /** @type {string[]} 客户端发来的原始文本消息 */
    this.messages = [];
    /** @type {any[]} 解析后的消息 */
    this.parsed = [];
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#markClosed());
    socket.on('error', () => this.#markClosed());
  }

  /** 发一条文本消息（对象会被 JSON.stringify）。 */
  send(payload) {
    if (this.closed) throw new Error('client already closed');
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.socket.write(encodeFrame(text, OPCODE_TEXT));
  }

  /** 发一条原始文本（用来测非 JSON 消息）。 */
  sendRaw(text) {
    if (this.closed) throw new Error('client already closed');
    this.socket.write(encodeFrame(text, OPCODE_TEXT));
  }

  /** 注册消息监听；返回取消函数。 */
  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 等待满足 predicate 的消息（含历史消息）。 */
  waitForMessage(predicate, timeoutMs = 2000) {
    const found = this.parsed.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待消息超时；已收到 ${JSON.stringify(this.parsed)}`));
      }, timeoutMs);
      const off = this.onMessage((message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        off();
        resolve(message);
      });
    });
  }

  /** 等客户端发来的、方法为 method 的请求。 */
  waitForMethod(method, timeoutMs) {
    return this.waitForMessage((message) => message?.method === method, timeoutMs);
  }

  /** 服务器主动关连接（发 close 帧）。 */
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      this.socket.write(encodeFrame(payload, OPCODE_CLOSE));
    } catch {
      // 连接已断：忽略。
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 50).unref?.();
  }

  /** 粗暴断开（模拟网络中断）。 */
  destroy() {
    this.closed = true;
    this.socket.destroy();
  }

  /** 注册关闭监听；返回取消函数。 */
  onClose(listener) {
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let frame;
      try {
        frame = decodeFrame(this.buffer);
      } catch {
        this.destroy();
        return;
      }
      if (frame === undefined) return;
      this.buffer = frame.rest;
      this.#handleFrame(frame);
    }
  }

  #handleFrame(frame) {
    if (frame.opcode === OPCODE_CLOSE) {
      try {
        this.socket.write(encodeFrame(frame.payload, OPCODE_CLOSE));
      } catch {
        // 忽略。
      }
      this.socket.end();
      this.#markClosed();
      return;
    }
    if (frame.opcode === OPCODE_PING) {
      try {
        this.socket.write(encodeFrame(frame.payload, OPCODE_PONG));
      } catch {
        // 忽略。
      }
      return;
    }
    if (frame.opcode === OPCODE_PONG) return;
    if (frame.opcode === OPCODE_CONTINUATION) {
      throw new Error('测试用 fake server 不支持分片消息（CDP 命令不会这么大）');
    }
    if (frame.opcode !== OPCODE_TEXT && frame.opcode !== OPCODE_BINARY) return;
    const text = frame.payload.toString('utf8');
    this.messages.push(text);
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { unparsed: text };
    }
    this.parsed.push(parsed);
    for (const listener of [...this.listeners]) {
      try {
        listener(parsed, text);
      } catch {
        // 测试监听器异常不影响服务器。
      }
    }
  }

  #markClosed() {
    if (this.closed) return;
    this.closed = true;
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

/**
 * 起一个 fake CDP 服务器。
 *
 * @param {{ handler?: (message: any, client: FakeClient) => any, onUpgrade?: (request: http.IncomingMessage) => void }} [options]
 *   handler 的返回值约定：
 *   - `undefined`：交给默认响应（只认识下面 defaultCdpResponse 列出的常见方法，**未知方法不响应**，
 *     方便测超时/挂起）；
 *   - `HANDLED`：handler 已自行（可能是异步）回包，服务器不再自动回；
 *   - 其它：作为 `{ id, ...返回值 }` 直接回包。
 */
async function startFakeCdpServer(options = {}) {
  /** @type {{ handler?: (message: any, client: FakeClient) => any, onUpgrade?: (request: http.IncomingMessage) => void }} */
  const config = options;
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  /** @type {FakeClient[]} */
  const clients = [];
  /** @type {http.IncomingMessage[]} */
  const upgradeRequests = [];

  server.on('upgrade', (request, socket, head) => {
    upgradeRequests.push(request);
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (head !== undefined && head.length > 0) socket.unshift(head);
    const client = new FakeClient(socket, request);
    clients.push(client);
    client.onMessage((message) => {
      if (message === null || typeof message !== 'object') return;
      if (typeof message.id !== 'number' && typeof message.id !== 'string') return;
      const handler = config?.handler;
      if (typeof handler === 'function') {
        const answered = handler(message, client);
        if (answered === HANDLED) return;
        if (answered !== undefined) {
          client.send(answered);
          return;
        }
      }
      const response = defaultCdpResponse(message);
      if (response !== undefined) client.send({ id: message.id, ...response });
    });
    config?.onUpgrade?.(request);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    httpUrl: `http://127.0.0.1:${port}`,
    port,
    clients,
    upgradeRequests,
    /** 已连接的第一个客户端（多数用例只连一个）。 */
    get client() {
      return clients[0];
    },
    async close() {
      for (const client of clients) client.destroy();
      await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
        }),
      ]);
      // 兜底：强制断掉所有连接，避免 listening handle 让测试进程不退出。
      server.closeAllConnections?.();
    },
  };
}

/** handler 的「我已自行处理、不要再自动回包」哨兵。 */
const HANDLED = Symbol('handled');

/** 默认的 CDP 响应：只覆盖测试真正用到的常见方法；**未知方法不响应**。 */
function defaultCdpResponse(message) {
  switch (message.method) {
    case 'Browser.getVersion':
      return { result: { product: 'Chrome/155.0.7600.0', protocolVersion: '1.3', userAgent: 'FakeChrome/155.0.0', jsVersion: '15.5' } };
    case 'Target.setDiscoverTargets':
    case 'Target.setAutoAttach':
    case 'Target.detachFromTarget':
    case 'Runtime.enable':
    case 'Page.enable':
    case 'Runtime.runIfWaitingForDebugger':
      return { result: {} };
    case 'Target.getTargets':
      return {
        result: {
          targetInfos: [
            { targetId: 'target-a', type: 'page', url: 'https://example.test/a', title: 'A', attached: false },
            { targetId: 'target-sw', type: 'service_worker', url: 'https://example.test/sw.js', title: '', attached: false },
            { targetId: 'target-b', type: 'page', url: 'data:text/html,b', title: '', attached: true, openerId: 'target-a' },
            { targetId: 'target-bg', type: 'background_page', url: 'about:blank', title: '', attached: false },
          ],
        },
      };
    case 'Target.createTarget':
      return { result: { targetId: 'target-created' } };
    case 'Target.attachToTarget':
      return { result: { sessionId: `session-for-${message.params?.targetId ?? 'unknown'}` } };
    case 'Target.closeTarget':
      return { result: { success: true } };
    default:
      return undefined;
  }
}

/** 建一条连接到 fake 服务器，返回 { server, connection }，自动注册清理。 */
async function openConnection(t, options = {}) {
  const server = await startFakeCdpServer(options);
  let connection;
  try {
    connection = await CdpConnection.open(server.url, { timeoutMs: 3000 });
  } catch (error) {
    await server.close();
    throw error;
  }
  t.after(async () => {
    // 先关客户端连接再关服务器，避免 teardown 互相等待。
    try {
      await connection.close();
    } catch {
      // 清理失败不掩盖断言结果。
    }
    await server.close();
  });
  return { server, connection };
}

// ---------------------------------------------------------------------------
// prepareWebSocketUrl：方案 D 的鉴权限制（Node 内置 WebSocket 不支持 headers）
// ---------------------------------------------------------------------------

test('prepareWebSocketUrl：合法的 ws/wss URL 原样通过', () => {
  assert.equal(prepareWebSocketUrl('ws://127.0.0.1:9222/devtools/browser/x'), 'ws://127.0.0.1:9222/devtools/browser/x');
  assert.equal(prepareWebSocketUrl('wss://example.test/devtools/browser/x'), 'wss://example.test/devtools/browser/x');
  assert.equal(prepareWebSocketUrl('ws://127.0.0.1:9222/devtools/browser/x', {}), 'ws://127.0.0.1:9222/devtools/browser/x');
  assert.equal(prepareWebSocketUrl('ws://127.0.0.1:9222/devtools/browser/x', { '': '' }), 'ws://127.0.0.1:9222/devtools/browser/x');
});

test('prepareWebSocketUrl：http URL / 非法 URL 抛 INVALID_ARGUMENT', () => {
  for (const bad of ['http://127.0.0.1:9222', '127.0.0.1:9222', '', 'not a url']) {
    assert.throws(
      () => prepareWebSocketUrl(bad),
      (error) => error instanceof BrowserError && error.code === 'INVALID_ARGUMENT',
      `应拒绝：${bad}`,
    );
  }
});

test('prepareWebSocketUrl：URL 内嵌凭据被明确拒绝（实测 Node 会静默丢弃凭据）', () => {
  assert.throws(
    () => prepareWebSocketUrl('ws://user:pass@127.0.0.1:9222/devtools/browser/x'),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /user:pass/i);
      assert.equal(error.details.reason, 'url-credentials-unsupported');
      // 错误信息里的 URL 必须脱敏：不能出现真实密码。
      assert.ok(!JSON.stringify(error.details).includes('pass@'), 'details 不应泄漏密码');
      return true;
    },
  );
});

test('prepareWebSocketUrl：自定义 headers 被明确拒绝并列出头部名', () => {
  assert.throws(
    () => prepareWebSocketUrl('ws://127.0.0.1:9222/devtools/browser/x', { 'X-API-Key': 'secret' }),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details.unsupportedHeaders, ['X-API-Key']);
      assert.match(error.message, /X-API-Key/);
      assert.equal(error.details.reason, 'headers-unsupported');
      return true;
    },
  );
});

test('CdpConnection.open：headers 在建立连接前就抛错（不会静默忽略）', async () => {
  await assert.rejects(
    () => CdpConnection.open('ws://127.0.0.1:1/x', { headers: { Authorization: 'Bearer t' } }),
    (error) => error instanceof BrowserError && error.code === 'INVALID_ARGUMENT',
  );
});

// ---------------------------------------------------------------------------
// CdpConnection：请求/响应配对、错误、关闭、事件
// ---------------------------------------------------------------------------

test('CdpConnection.open：连不上端口抛 CONNECT_FAILED', async () => {
  await assert.rejects(
    () => CdpConnection.open('ws://127.0.0.1:1/devtools/browser/x', { timeoutMs: 3000 }),
    (error) => {
      assert.equal(error.code, 'CONNECT_FAILED');
      assert.ok(error instanceof BrowserError);
      return true;
    },
  );
});

test('CdpConnection.open：握手无响应时按 timeoutMs 超时抛 CONNECT_FAILED', async (t) => {
  // 服务器只接受 upgrade 请求但不回 101：客户端应等到超时。
  const sockets = [];
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (_request, socket) => {
    sockets.push(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const started = Date.now();
  await assert.rejects(
    () => CdpConnection.open(`ws://127.0.0.1:${port}/devtools/browser/x`, { timeoutMs: 300 }),
    (error) => error instanceof BrowserError && error.code === 'CONNECT_FAILED',
  );
  assert.ok(Date.now() - started < 3000, `应在 ~300ms 内超时，实际 ${Date.now() - started}ms`);
});

test('send：id 配对正确（并发请求乱序响应）', async (t) => {
  const server = await startFakeCdpServer();
  t.after(async () => {
    await server.close();
  });
  const connection = await CdpConnection.open(server.url, { timeoutMs: 3000 });
  t.after(async () => {
    await connection.close();
  });
  const serverClient = server.client;
  // 服务器收到两个请求后故意倒序回包。
  const received = [];
  serverClient.onMessage((message) => {
    if (typeof message?.id !== 'number') return;
    received.push(message);
    if (received.length === 2) {
      const [first, second] = received;
      serverClient.send({ id: second.id, result: { echo: second.method } });
      serverClient.send({ id: first.id, result: { echo: first.method } });
    }
  });
  const [a, b] = await Promise.all([
    connection.send('Test.first', { value: 1 }),
    connection.send('Test.second', { value: 2 }),
  ]);
  assert.deepEqual(a, { echo: 'Test.first' });
  assert.deepEqual(b, { echo: 'Test.second' });
});

test('send：CDP error 响应 reject 成 BrowserError(CDP_ERROR) 并带 method/code/data', async (t) => {
  const { connection } = await openConnection(t, {
    handler: (message) => {
      if (message.method === 'Page.navigate') {
        return { id: message.id, error: { code: -32000, message: 'Cannot navigate to invalid URL', data: 'bad url' } };
      }
      return undefined;
    },
  });
  await assert.rejects(
    () => connection.send('Page.navigate', { url: 'x' }),
    (error) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, 'CDP_ERROR');
      assert.match(error.message, /Page\.navigate/);
      assert.match(error.message, /Cannot navigate/);
      assert.equal(error.details.method, 'Page.navigate');
      assert.equal(error.details.code, -32000);
      assert.equal(error.details.data, 'bad url');
      return true;
    },
  );
});

test('send：单条超时抛 TIMEOUT，且连接仍可继续用', async (t) => {
  const { server, connection } = await openConnection(t, {
    handler: (message) => {
      if (message.method === 'Test.ping') return { id: message.id, result: { pong: true } };
      return undefined;
    },
  });
  connection.sendTimeoutMs = 60;
  await assert.rejects(
    () => connection.send('Test.hang'),
    (error) => error instanceof BrowserError && error.code === 'TIMEOUT' && error.details.method === 'Test.hang',
  );
  // 超时只影响那一条请求；后续请求正常。
  connection.sendTimeoutMs = 3000;
  const result = await connection.send('Test.ping');
  assert.deepEqual(result, { pong: true });
  // 服务器确实收到了那条挂起请求。
  assert.ok(server.client.parsed.some((message) => message.method === 'Test.hang'));
});

test('连接关闭时所有 pending 请求全部 reject（CONNECT_FAILED）', async (t) => {
  const { server, connection } = await openConnection(t);
  const first = connection.send('Test.hangA');
  const second = connection.send('Test.hangB');
  // 等服务器收到两条请求后再粗暴断开。
  await server.client.waitForMethod('Test.hangB');
  server.client.destroy();
  for (const pending of [first, second]) {
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, 'CONNECT_FAILED');
      assert.match(error.message, /关闭/);
      return true;
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(connection.closed, true);
  // 已关闭后再 send 立即 NOT_CONNECTED。
  await assert.rejects(
    () => connection.send('Test.afterClose'),
    (error) => error instanceof BrowserError && error.code === 'NOT_CONNECTED',
  );
});

test('on()：事件分发与取消订阅', async (t) => {
  const { server, connection } = await openConnection(t);
  const seenA = [];
  const seenB = [];
  const offA = connection.on('Test.event', (params) => seenA.push(params));
  connection.on('Test.event', (params) => seenB.push(params));

  server.client.send({ method: 'Test.event', params: { n: 1 } });
  await waitFor(() => seenA.length === 1 && seenB.length === 1, '两个监听器都应收到事件');

  offA();
  server.client.send({ method: 'Test.event', params: { n: 2 } });
  await waitFor(() => seenB.length === 2, '取消订阅后 B 应继续收到');
  assert.deepEqual(seenA, [{ n: 1 }], 'A 取消后不应再收到');
  assert.deepEqual(seenB, [{ n: 1 }, { n: 2 }]);
});

test('on()：一个监听器抛错不影响其它监听器', async (t) => {
  const { server, connection } = await openConnection(t);
  const seen = [];
  connection.on('Test.event', () => {
    throw new Error('listener boom');
  });
  connection.on('Test.event', (params) => seen.push(params));
  server.client.send({ method: 'Test.event', params: { ok: true } });
  await waitFor(() => seen.length === 1, '抛错的监听器不应阻断后续监听器');
  assert.deepEqual(seen, [{ ok: true }]);
});

test('on()：sessionId 作为第二参数传给监听器', async (t) => {
  const { server, connection } = await openConnection(t);
  const seen = [];
  connection.on('Runtime.consoleAPICalled', (params, sessionId) => seen.push({ params, sessionId }));
  server.client.send({ method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: 's-1' });
  server.client.send({ method: 'Runtime.consoleAPICalled', params: { type: 'error' } });
  await waitFor(() => seen.length === 2, '应收到两个事件');
  assert.deepEqual(seen[0], { params: { type: 'log' }, sessionId: 's-1' });
  assert.deepEqual(seen[1], { params: { type: 'error' }, sessionId: undefined });
});

test('on()：非法参数抛 INVALID_ARGUMENT', async (t) => {
  const { connection } = await openConnection(t);
  assert.throws(() => connection.on('', () => {}), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => connection.on('X', 'not-a-function'), (error) => error.code === 'INVALID_ARGUMENT');
});

test('once()：等到事件返回 params，超时抛 TIMEOUT', async (t) => {
  const { server, connection } = await openConnection(t);
  const pending = connection.once('Test.once', 2000);
  server.client.send({ method: 'Test.once', params: { value: 7 } });
  assert.deepEqual(await pending, { value: 7 });

  await assert.rejects(
    () => connection.once('Test.never', 80),
    (error) => error instanceof BrowserError && error.code === 'TIMEOUT' && error.details.event === 'Test.never',
  );
});

test('once()：连接关闭时 reject CONNECT_FAILED', async (t) => {
  const { server, connection } = await openConnection(t);
  const pending = connection.once('Test.never', 5000);
  await connection.close();
  await assert.rejects(pending, (error) => error instanceof BrowserError && error.code === 'CONNECT_FAILED');
  assert.equal(connection.closed, true);
});

test('onClose()：连接关闭时回调；已关闭时异步立即回调', async (t) => {
  const { server, connection } = await openConnection(t);
  let called = 0;
  const off = connection.onClose(() => { called += 1; });
  server.client.destroy();
  await waitFor(() => called === 1, '连接断开应触发 onClose');
  await waitFor(() => connection.closed, 'connection.closed 应为 true');
  off();
  // 已关闭的连接：注册即异步回调。
  let lateCalled = 0;
  connection.onClose(() => { lateCalled += 1; });
  await waitFor(() => lateCalled === 1, '已关闭时 onClose 应立即异步回调');
});

test('非 JSON 消息不会破坏连接（作为 protocol.error 事件暴露）', async (t) => {
  const { server, connection } = await openConnection(t, {
    handler: (message) => {
      if (message.method === 'Test.stillAlive') return { id: message.id, result: { alive: true } };
      return undefined;
    },
  });
  const seen = [];
  connection.on('protocol.error', (params) => seen.push(params));
  server.client.sendRaw('this is not json');
  await waitFor(() => seen.length === 1, '应收到 protocol.error 事件');
  // 连接仍能用。
  assert.deepEqual(await connection.send('Test.stillAlive'), { alive: true });
});

test('close() 幂等，关闭后 closed 为 true', async (t) => {
  const { connection } = await openConnection(t);
  assert.equal(connection.closed, false);
  await connection.close();
  assert.equal(connection.closed, true);
  await connection.close(); // 第二次不应抛。
  assert.equal(connection.closed, true);
});

test('CdpConnection.open：连接后 url 已脱敏', async (t) => {
  const server = await startFakeCdpServer();
  t.after(async () => {
    await server.close();
  });
  const connection = await CdpConnection.open(server.url);
  t.after(async () => {
    await connection.close();
  });
  assert.ok(connection.url.startsWith('ws://127.0.0.1:'));
  assert.ok(!connection.url.includes('@'));
});

// ---------------------------------------------------------------------------
// CdpBrowser / TargetSession
// ---------------------------------------------------------------------------

/** 打开一个 CdpBrowser 并注册清理。 */
async function openBrowser(t, options = {}) {
  const server = await startFakeCdpServer(options);
  let browser;
  try {
    browser = await CdpBrowser.open(server.url, { timeoutMs: 3000 });
  } catch (error) {
    await server.close();
    throw error;
  }
  t.after(async () => {
    try {
      await browser.close();
    } catch {
      // 清理失败不掩盖断言结果。
    }
    await server.close();
  });
  return { server, browser };
}

test('CdpBrowser.open：version 来自 Browser.getVersion，并开启 target 发现/自动附着', async (t) => {
  const { server, browser } = await openBrowser(t);
  assert.deepEqual(browser.version, {
    browser: 'Chrome/155.0.7600.0',
    protocolVersion: '1.3',
    userAgent: 'FakeChrome/155.0.0',
  });
  const methods = server.client.parsed.map((message) => message.method);
  assert.ok(methods.includes('Target.setDiscoverTargets'), '应调用 Target.setDiscoverTargets');
  assert.ok(methods.includes('Target.setAutoAttach'), '应调用 Target.setAutoAttach');
  assert.deepEqual(browser.warnings, []);
  assert.equal(browser.closed, false);
});

test('CdpBrowser.open：Browser.getVersion 失败时清理连接并抛错', async (t) => {
  const server = await startFakeCdpServer({
    handler: (message) => {
      if (message.method === 'Browser.getVersion') {
        return { id: message.id, error: { code: -32601, message: 'method not found' } };
      }
      return undefined;
    },
  });
  t.after(async () => {
    await server.close();
  });
  await assert.rejects(
    () => CdpBrowser.open(server.url, { timeoutMs: 3000 }),
    (error) => error instanceof BrowserError && error.code === 'CDP_ERROR',
  );
});

test('CdpBrowser.listTargets：只返回 page，字段齐全', async (t) => {
  const { browser } = await openBrowser(t);
  const pages = await browser.listTargets();
  assert.equal(pages.length, 2, '应过滤掉 service_worker / background_page');
  assert.deepEqual(pages[0], {
    targetId: 'target-a',
    type: 'page',
    url: 'https://example.test/a',
    title: 'A',
    attached: false,
  });
  assert.equal(pages[1].targetId, 'target-b');
  assert.equal(pages[1].openerId, 'target-a', '有 openerId 时应带上');
  assert.equal('openerId' in pages[0], false, '没有 openerId 时不应有该键');
});

test('CdpBrowser.createTarget / closeTarget', async (t) => {
  const { server, browser } = await openBrowser(t);
  const created = await browser.createTarget('data:text/html,hi');
  assert.deepEqual(created, { targetId: 'target-created' });
  const request = await server.client.waitForMethod('Target.createTarget');
  assert.equal(request.params.url, 'data:text/html,hi');

  await browser.closeTarget('target-created');
  const closeRequest = await server.client.waitForMethod('Target.closeTarget');
  assert.equal(closeRequest.params.targetId, 'target-created');
});

test('CdpBrowser.closeTarget：target 已不存在时静默成功（幂等）', async (t) => {
  const { browser } = await openBrowser(t, {
    handler: (message) => {
      if (message.method === 'Target.closeTarget') {
        return { id: message.id, error: { code: -32602, message: 'No target with given id found' } };
      }
      return undefined;
    },
  });
  await browser.closeTarget('already-gone');
});

test('CdpBrowser.closeTarget：其它 CDP 错误照常抛出', async (t) => {
  const { browser } = await openBrowser(t, {
    handler: (message) => {
      if (message.method === 'Target.closeTarget') {
        return { id: message.id, error: { code: -32602, message: 'permission denied' } };
      }
      return undefined;
    },
  });
  await assert.rejects(
    () => browser.closeTarget('target-a'),
    (error) => error instanceof BrowserError && error.code === 'CDP_ERROR',
  );
});

test('CdpBrowser.attach：建 session、复用 session、sessionId 正确', async (t) => {
  const { server, browser } = await openBrowser(t);
  const session = await browser.attach('target-a');
  assert.equal(session.targetId, 'target-a');
  assert.equal(session.sessionId, 'session-for-target-a');
  assert.equal(session.detached, false);

  const again = await browser.attach('target-a');
  assert.equal(again, session, '同一 target 应复用同一个 TargetSession');

  // 服务器只应收到一次 attachToTarget。
  const attachCalls = server.client.parsed.filter((message) => message.method === 'Target.attachToTarget');
  assert.equal(attachCalls.length, 1);
  assert.deepEqual(attachCalls[0].params, { targetId: 'target-a', flatten: true });
});

test('CdpBrowser.attach：target 不存在时抛 TARGET_NOT_FOUND', async (t) => {
  const { browser } = await openBrowser(t, {
    handler: (message) => {
      if (message.method === 'Target.attachToTarget') {
        return { id: message.id, error: { code: -32602, message: 'No target with given id found' } };
      }
      return undefined;
    },
  });
  await assert.rejects(
    () => browser.attach('missing-target'),
    (error) => error instanceof BrowserError && error.code === 'TARGET_NOT_FOUND' && error.details.targetId === 'missing-target',
  );
});

test('CdpBrowser.attach：优先复用 auto-attach 得到的 session', async (t) => {
  const { server, browser } = await openBrowser(t);
  // 模拟 Chrome 在 setAutoAttach 后推送的事件。
  server.client.send({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'auto-session-1', targetInfo: { targetId: 'target-b', type: 'page' }, waitingForDebugger: false },
  });
  // 事件经本地 WebSocket 到达需要一两个事件循环；等到浏览器侧把它记录下来（用 attach 的复用行为验证）。
  await delay(50);
  const session = await browser.attach('target-b');
  assert.equal(session.sessionId, 'auto-session-1');
  // 不应再发显式 attachToTarget。
  const attachCalls = server.client.parsed.filter((message) => message.method === 'Target.attachToTarget');
  assert.equal(attachCalls.length, 0);
});

test('CdpBrowser.detach：发 detachFromTarget 并标记 session 失效', async (t) => {
  const { server, browser } = await openBrowser(t);
  const session = await browser.attach('target-a');
  await browser.detach('target-a');
  const detachRequest = await server.client.waitForMethod('Target.detachFromTarget');
  assert.equal(detachRequest.params.sessionId, 'session-for-target-a');
  assert.equal(session.detached, true);
  // detach 后再 send 立即失败。
  await assert.rejects(
    () => session.send('Runtime.evaluate', { expression: '1' }),
    (error) => error instanceof BrowserError && error.code === 'NOT_CONNECTED',
  );
});

test('TargetSession.send：自动携带 sessionId', async (t) => {
  const { server, browser } = await openBrowser(t);
  const session = await browser.attach('target-a');
  await session.send('Runtime.enable');
  const request = await server.client.waitForMethod('Runtime.enable');
  assert.equal(request.sessionId, 'session-for-target-a');
});

test('TargetSession.on：只收本 session 的事件', async (t) => {
  const { server, browser } = await openBrowser(t);
  const session = await browser.attach('target-a');
  const seen = [];
  const off = session.on('Runtime.consoleAPICalled', (params) => seen.push(params));
  server.client.send({ method: 'Runtime.consoleAPICalled', params: { from: 'other' }, sessionId: 'other-session' });
  server.client.send({ method: 'Runtime.consoleAPICalled', params: { from: 'mine' }, sessionId: 'session-for-target-a' });
  await waitFor(() => seen.length === 1, '只应收到本 session 的事件');
  assert.deepEqual(seen, [{ from: 'mine' }]);
  off();
  server.client.send({ method: 'Runtime.consoleAPICalled', params: { from: 'mine-2' }, sessionId: 'session-for-target-a' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen.length, 1, '取消订阅后不应再收到');
});

test('TargetSession.waitFor：支持 predicate 与纯 timeout 两种调用', async (t) => {
  const { server, browser } = await openBrowser(t);
  const session = await browser.attach('target-a');
  const pending = session.waitFor('Page.loadEventFired', (params) => params?.timestamp === 42, 2000);
  server.client.send({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'session-for-target-a' });
  server.client.send({ method: 'Page.loadEventFired', params: { timestamp: 42 }, sessionId: 'session-for-target-a' });
  assert.deepEqual(await pending, { timestamp: 42 });

  // 第二参数是数字时视为 timeoutMs。
  const pendingAny = session.waitFor('Page.frameNavigated', 2000);
  server.client.send({ method: 'Page.frameNavigated', params: { frame: {} }, sessionId: 'session-for-target-a' });
  assert.deepEqual(await pendingAny, { frame: {} });
});

test('TargetSession.waitFor：超时抛 TIMEOUT，连接关闭抛 CONNECT_FAILED', async (t) => {
  const { server, browser } = await openBrowser(t);
  const session = await browser.attach('target-a');
  await assert.rejects(
    () => session.waitFor('Page.never', 80),
    (error) => error instanceof BrowserError && error.code === 'TIMEOUT',
  );
  const pending = session.waitFor('Page.never', 5000);
  server.client.destroy();
  await assert.rejects(pending, (error) => error instanceof BrowserError && error.code === 'CONNECT_FAILED');
});

test('Target.detachedFromTarget 事件会让 session 失效', async (t) => {
  const { server, browser } = await openBrowser(t);
  const session = await browser.attach('target-a');
  server.client.send({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-for-target-a', targetId: 'target-a' } });
  await waitFor(() => session.detached, '收到 detachedFromTarget 后 session 应失效');
  await assert.rejects(
    () => session.send('Runtime.evaluate', { expression: '1' }),
    (error) => error.code === 'NOT_CONNECTED',
  );
});

test('CdpBrowser.onClose：连接断开时回调，closed 变 true', async (t) => {
  const { server, browser } = await openBrowser(t);
  let called = 0;
  browser.onClose(() => { called += 1; });
  server.client.destroy();
  await waitFor(() => called === 1, '连接断开应触发 browser.onClose');
  await waitFor(() => browser.closed, 'browser.closed 应为 true');
});

test('CdpBrowser.close 幂等', async (t) => {
  const { browser } = await openBrowser(t);
  await browser.close();
  assert.equal(browser.closed, true);
  await browser.close();
  assert.equal(browser.closed, true);
});

/** 轮询等待条件成立（避免依赖固定 sleep 的抖动）。 */
async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等待条件超时：${message}`);
}

/** 固定等待（只用于「本地 WebSocket 消息到达」这种没有可观察点的时序）。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
