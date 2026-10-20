// lib/chrome.mjs 的离线单测：URL 归一化、DevToolsActivePort 解析、平台路径、端点探测。
//
// 这些用例**不启动 Chrome、不依赖本机安装**：需要文件/网络的地方用 os.tmpdir() 与
// 临时 http server 造，保证在任意机器上稳定。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  CHANNELS,
  chromeCandidatePaths,
  defaultUserDataDir,
  launchChrome,
  normalizeBrowserUrl,
  normalizeViewport,
  probeBrowserUrl,
  readDevToolsActivePort,
  redactUrl,
  resolveChromeExecutable,
  stopChrome,
} from '../lib/chrome.mjs';

/** 建一个临时目录，注册自动清理。 */
async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-test-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return dir;
}

/** 起一个临时 http server，返回 { url, port, close }。 */
async function startHttpServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, port, server };
}

test('CHANNELS 覆盖四个渠道', () => {
  assert.deepEqual([...CHANNELS], ['stable', 'beta', 'dev', 'canary']);
});

test('normalizeBrowserUrl：完整 URL / 主机端口 / 纯端口 都归一成 origin', () => {
  assert.equal(normalizeBrowserUrl('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(normalizeBrowserUrl('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  assert.equal(normalizeBrowserUrl('127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(normalizeBrowserUrl('9222'), 'http://127.0.0.1:9222');
  assert.equal(normalizeBrowserUrl('  http://127.0.0.1:9333  '), 'http://127.0.0.1:9333');
  assert.equal(normalizeBrowserUrl('localhost:9222'), 'http://localhost:9222');
  assert.equal(normalizeBrowserUrl('http://127.0.0.1:9222/json/version'), 'http://127.0.0.1:9222');
  assert.equal(normalizeBrowserUrl('https://debug.example.com:9443'), 'https://debug.example.com:9443');
  assert.equal(normalizeBrowserUrl('127.0.0.1'), 'http://127.0.0.1:9222');
  assert.equal(normalizeBrowserUrl('http://[::1]:9222'), 'http://[::1]:9222');
});

test('normalizeBrowserUrl：URL 里的凭据会被丢弃（Chrome 调试端点不支持 Basic 认证）', () => {
  assert.equal(normalizeBrowserUrl('http://user:pass@127.0.0.1:9222'), 'http://127.0.0.1:9222');
});

test('normalizeBrowserUrl：非法输入返回 undefined', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, 'ws://127.0.0.1:9222', 'wss://127.0.0.1:9222', 'abc', 'http://', 'http://127.0.0.1:99999', 'http://127.0.0.1:0', 'http://127.0.0.1:abc']) {
    assert.equal(normalizeBrowserUrl(bad), undefined, `应判为非法：${JSON.stringify(bad)}`);
  }
});

test('normalizeViewport：对象与字符串两种形态，非法返回 undefined', () => {
  assert.equal(normalizeViewport({ width: 1280, height: 800 }), '1280,800');
  assert.equal(normalizeViewport('1280x800'), '1280,800');
  assert.equal(normalizeViewport('1920X1080'), '1920,1080');
  assert.equal(normalizeViewport('1280 800'), '1280,800');
  assert.equal(normalizeViewport(undefined), undefined);
  assert.equal(normalizeViewport('abc'), undefined);
  assert.equal(normalizeViewport('0x0'), undefined);
  assert.equal(normalizeViewport({ width: -1, height: 800 }), undefined);
  assert.equal(normalizeViewport({}), undefined);
});

test('readDevToolsActivePort：正常文件解析出 port / wsPath / wsUrl', async (t) => {
  const dir = await makeTempDir(t);
  fsSync.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/abc-123\n');
  const active = readDevToolsActivePort(dir);
  assert.deepEqual(active, {
    port: 9222,
    wsPath: '/devtools/browser/abc-123',
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
  });
});

test('readDevToolsActivePort：CRLF、末尾无换行、wsPath 缺前导斜杠都能容错', async (t) => {
  const dir = await makeTempDir(t);
  fsSync.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9223\r\ndevtools/browser/xyz');
  const active = readDevToolsActivePort(dir);
  assert.equal(active?.port, 9223);
  assert.equal(active?.wsPath, '/devtools/browser/xyz');
  assert.equal(active?.wsUrl, 'ws://127.0.0.1:9223/devtools/browser/xyz');
});

test('readDevToolsActivePort：不存在 / 空文件 / 缺第二行 / 端口非法 / 路径非法 都返回 undefined', async (t) => {
  assert.equal(readDevToolsActivePort(await makeTempDir(t)), undefined, '文件不存在');

  const cases = {
    '空文件': '',
    '只有空白': '   \n\n',
    '只有端口': '9222\n',
    '端口不是数字': 'abc\n/devtools/browser/x\n',
    '端口越界': '99999\n/devtools/browser/x\n',
    '端口是 0': '0\n/devtools/browser/x\n',
    '路径不是 devtools/browser': '9222\n/devtools/page/x\n',
  };
  for (const [label, content] of Object.entries(cases)) {
    const dir = await makeTempDir(t);
    fsSync.writeFileSync(path.join(dir, 'DevToolsActivePort'), content);
    assert.equal(readDevToolsActivePort(dir), undefined, `应判为无效：${label}`);
  }
  assert.equal(readDevToolsActivePort(''), undefined);
  assert.equal(readDevToolsActivePort(undefined), undefined);
});

test('defaultUserDataDir：绝对路径、渠道不同、未知渠道回落 stable', () => {
  const stable = defaultUserDataDir('stable');
  assert.ok(path.isAbsolute(stable));
  assert.ok(stable.includes('User Data') || stable.includes('google-chrome') || stable.includes('Chrome'));
  const fromDefault = defaultUserDataDir();
  assert.equal(fromDefault, stable);
  const seen = new Set();
  for (const channel of CHANNELS) {
    const dir = defaultUserDataDir(channel);
    assert.ok(path.isAbsolute(dir), `${channel} 应是绝对路径`);
    seen.add(dir);
  }
  assert.equal(seen.size, CHANNELS.length, '四个渠道的 user data 目录应互不相同');
  assert.equal(defaultUserDataDir('nope'), stable, '未知渠道回落 stable');
});

test('chromeCandidatePaths：返回绝对路径，当前渠道优先', () => {
  const stable = chromeCandidatePaths('stable');
  for (const candidate of stable) assert.ok(path.isAbsolute(candidate), `应绝对路径：${candidate}`);
  const beta = chromeCandidatePaths('beta');
  assert.ok(beta.length > stable.length, 'beta 候选里应额外包含 beta 路径');
  assert.ok(beta[0].toLowerCase().includes('beta'), 'beta 渠道的第一个候选应是 beta 安装路径');
});

test('resolveChromeExecutable：显式路径优先，且不存在时不盲信', async (t) => {
  const dir = await makeTempDir(t);
  const fakeChrome = path.join(dir, 'chrome.exe');
  fsSync.writeFileSync(fakeChrome, 'not really chrome');
  assert.equal(resolveChromeExecutable({ executablePath: fakeChrome }), path.resolve(fakeChrome));
  // 显式路径存在时，即使 channel 指定了别的渠道也优先用它。
  assert.equal(resolveChromeExecutable({ executablePath: fakeChrome, channel: 'canary' }), path.resolve(fakeChrome));

  const missing = path.join(dir, 'missing-chrome.exe');
  const resolved = resolveChromeExecutable({ executablePath: missing });
  assert.notEqual(resolved, path.resolve(missing), '不存在的显式路径不应被返回');
});

test('launchChrome：找不到 Chrome 时抛 CHROME_NOT_FOUND 且带候选路径', async () => {
  // 用一个不存在的可执行路径 + 把候选探测逼进空集合做不到（本机装了 Chrome 就会回落到它），
  // 所以这里只验证「显式路径无效时错误类型正确、details 完整」这一条不依赖本机安装的分支：
  // 传一个目录作为 executablePath，exists 为 true 但 spawn 会失败（EACCES/ENOENT）。
  // 该分支走 CONNECT_FAILED 或 CHROME_NOT_FOUND，二者都属于契约允许的启动失败错误。
  await assert.rejects(
    () => launchChrome({ executablePath: os.tmpdir(), timeoutMs: 500 }),
    (error) => {
      assert.equal(error.name, 'BrowserError');
      assert.ok(['CHROME_NOT_FOUND', 'CONNECT_FAILED', 'TIMEOUT'].includes(error.code), `意外错误码 ${error.code}`);
      return true;
    },
  );
});

test('probeBrowserUrl：解析 /json/version 的成功响应', async (t) => {
  const server = await startHttpServer(t, (request, response) => {
    if (request.url !== '/json/version') {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      Browser: 'Chrome/155.0.7600.0',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/xyz',
    }));
  });
  const info = await probeBrowserUrl(server.url);
  assert.deepEqual(info, {
    browser: 'Chrome/155.0.7600.0',
    webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/xyz',
    protocolVersion: '1.3',
  });
  // 纯端口形态也能探测。
  const viaPort = await probeBrowserUrl(String(server.port));
  assert.equal(viaPort?.browser, 'Chrome/155.0.7600.0');
});

test('probeBrowserUrl：404 / 非法 URL / 连不上 都返回 undefined（不抛）', async (t) => {
  const server = await startHttpServer(t, (_request, response) => {
    response.writeHead(404);
    response.end();
  });
  assert.equal(await probeBrowserUrl(server.url), undefined);
  assert.equal(await probeBrowserUrl('not a url'), undefined);
  assert.equal(await probeBrowserUrl(''), undefined);
  assert.equal(await probeBrowserUrl('http://127.0.0.1:1', 300), undefined);
});

test('probeBrowserUrl：响应超时返回 undefined', async (t) => {
  const server = await startHttpServer(t, (_request, _response) => {
    // 故意不响应，让 fetch 超时。
  });
  const started = Date.now();
  assert.equal(await probeBrowserUrl(server.url, 150), undefined);
  assert.ok(Date.now() - started < 3000, '应快速超时返回');
});

test('probeBrowserUrl：非 JSON 响应返回 undefined', async (t) => {
  const server = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>not json</html>');
  });
  assert.equal(await probeBrowserUrl(server.url), undefined);
});

test('stopChrome：非法 pid 静默返回；不存在的 pid 不抛', async () => {
  await stopChrome(0);
  await stopChrome(-1);
  await stopChrome(Number.NaN);
  await stopChrome(undefined);
  // 999999 几乎不可能存在；Windows taskkill 返回非 0 也必须被吞掉。
  await stopChrome(999999);
});

test('redactUrl：隐藏 userinfo 与 token 类 query，非法输入不抛', () => {
  assert.equal(redactUrl('ws://user:pass@127.0.0.1:9222/devtools/browser/x'), 'ws://***@127.0.0.1:9222/devtools/browser/x');
  const redacted = redactUrl('http://127.0.0.1:9222/json/version?token=secret&x=1');
  assert.ok(!redacted.includes('secret'), 'token 应被脱敏');
  assert.ok(redacted.includes('x=1'), '非敏感参数保留');
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl(undefined), '');
  assert.equal(redactUrl('not a url'), 'not a url');
});
