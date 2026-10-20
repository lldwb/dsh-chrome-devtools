// lib/schemes.mjs 的离线单测：方案元数据、配置归一化、wsHeaders 解析、四方案的
// probe / plan 分支（不启动 Chrome；需要端点的部分用 os.tmpdir() 与临时 http server 造）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  SCHEMES,
  getScheme,
  isSchemeId,
  normalizeConfig,
  parseWsHeaders,
  planScheme,
  probeAllSchemes,
  probeScheme,
} from '../lib/schemes.mjs';

/** 建临时目录并注册清理。 */
async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-schemes-test-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return dir;
}

/** 起临时 http server（/json/version 可配置），注册清理。 */
async function startVersionServer(t, options = {}) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/json/version') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (options.fail === true) {
      response.writeHead(500);
      response.end('boom');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        Browser: 'Chrome/155.0.7600.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, port };
}

/** 在临时目录里造一个可被 fs.existsSync 命中的假 Chrome（只测「显式路径优先」逻辑）。 */
async function makeFakeChrome(t, dir) {
  const file = path.join(dir, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  fsSync.writeFileSync(file, '');
  return file;
}

/** 写一个合法的 DevToolsActivePort。 */
async function writeActivePort(dir, port = 9333) {
  fsSync.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake-browser\n`);
}

test('SCHEMES：四个方案、顺序与契约一致、元数据字段齐全', () => {
  assert.equal(SCHEMES.length, 4);
  assert.deepEqual(
    SCHEMES.map((scheme) => scheme.id),
    ['launch', 'auto-connect', 'browser-url', 'ws-endpoint'],
  );
  for (const scheme of SCHEMES) {
    assert.equal(typeof scheme.label, 'string');
    assert.ok(scheme.label.length > 0, `${scheme.id} 缺少 label`);
    assert.equal(typeof scheme.labelEn, 'string');
    assert.ok(scheme.labelEn.length > 0, `${scheme.id} 缺少 labelEn`);
    assert.equal(typeof scheme.description, 'string');
    assert.ok(Array.isArray(scheme.fields) && scheme.fields.length > 0, `${scheme.id} 缺少 fields`);
    assert.equal(typeof scheme.needsChrome, 'boolean');
  }
});

test('isSchemeId / getScheme：精确匹配四个 id', () => {
  for (const scheme of SCHEMES) {
    assert.equal(isSchemeId(scheme.id), true);
    assert.equal(getScheme(scheme.id)?.id, scheme.id);
  }
  for (const bad of ['', 'launch ', 'Launch', 'chrome', null, undefined, 42, {}]) {
    assert.equal(isSchemeId(bad), false);
    assert.equal(getScheme(bad), undefined);
  }
});

test('DEFAULT_CONFIG：包含契约 §5.1 的连接相关默认值', () => {
  assert.equal(DEFAULT_CONFIG.scheme, 'auto-connect');
  assert.equal(DEFAULT_CONFIG.browserUrl, 'http://127.0.0.1:9222');
  assert.equal(DEFAULT_CONFIG.wsEndpoint, '');
  assert.equal(DEFAULT_CONFIG.wsHeaders, '');
  assert.equal(DEFAULT_CONFIG.channel, 'stable');
  assert.equal(DEFAULT_CONFIG.executablePath, '');
  assert.equal(DEFAULT_CONFIG.headless, false);
  assert.equal(DEFAULT_CONFIG.isolated, true);
  assert.equal(DEFAULT_CONFIG.userDataDir, '');
  assert.equal(DEFAULT_CONFIG.viewport, '1280x800');
  assert.equal(DEFAULT_CONFIG.connectTimeoutMs, 15000);
  assert.equal(DEFAULT_CONFIG.actionTimeoutMs, 10000);
});

test('normalizeConfig：补齐默认值、纠正类型、保留未知字段', () => {
  const empty = normalizeConfig(undefined);
  assert.deepEqual(empty, { ...DEFAULT_CONFIG });
  const nullConfig = normalizeConfig(null);
  assert.deepEqual(nullConfig, { ...DEFAULT_CONFIG });

  const partial = normalizeConfig({ scheme: 'launch', headless: 'yes', isolated: 'no', connectTimeoutMs: '3000', extra: 'keep' });
  assert.equal(partial.scheme, 'launch');
  assert.equal(partial.headless, false, '非 true 一律 false');
  assert.equal(partial.isolated, true, '只有显式 false 才关闭');
  assert.equal(partial.connectTimeoutMs, 3000);
  assert.equal(partial.extra, 'keep', '未知字段应保留');

  const cleaned = normalizeConfig({ scheme: '  ', channel: '', viewport: '  ' });
  assert.equal(cleaned.scheme, DEFAULT_CONFIG.scheme);
  assert.equal(cleaned.channel, DEFAULT_CONFIG.channel);
  assert.equal(cleaned.viewport, DEFAULT_CONFIG.viewport);

  const badNumbers = normalizeConfig({ connectTimeoutMs: -5, actionTimeoutMs: 'abc' });
  assert.equal(badNumbers.connectTimeoutMs, DEFAULT_CONFIG.connectTimeoutMs);
  assert.equal(badNumbers.actionTimeoutMs, DEFAULT_CONFIG.actionTimeoutMs);

  const isolatedFalse = normalizeConfig({ isolated: false });
  assert.equal(isolatedFalse.isolated, false);
});

test('parseWsHeaders：空值 / 合法 JSON / 非法 JSON / 数组 / null 值', () => {
  assert.deepEqual(parseWsHeaders(''), { ok: true, headers: {} });
  assert.deepEqual(parseWsHeaders('   '), { ok: true, headers: {} });
  assert.deepEqual(parseWsHeaders(undefined), { ok: true, headers: {} });
  assert.deepEqual(parseWsHeaders('{"Authorization":"Basic abc","X-N":1}'), {
    ok: true,
    headers: { Authorization: 'Basic abc', 'X-N': '1' },
  });
  assert.deepEqual(parseWsHeaders('{"Skip":null}'), { ok: true, headers: {} }, 'null 值应被跳过');

  const broken = parseWsHeaders('{not json');
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /JSON/);

  const array = parseWsHeaders('["a"]');
  assert.equal(array.ok, false);
  assert.match(array.reason, /对象/);
});

test('probeScheme：未知方案返回不可用且永不抛', async () => {
  for (const bad of ['nope', '', null, undefined, 42, {}]) {
    const probe = await probeScheme(bad, {});
    assert.equal(probe.available, false);
    assert.equal(typeof probe.detail, 'string');
    assert.ok(probe.detail.length > 0);
  }
});

test('probeScheme(launch)：找到 Chrome 时可用并给出路径', async (t) => {
  const dir = await makeTempDir(t);
  const fakeChrome = await makeFakeChrome(t, dir);
  const probe = await probeScheme('launch', { executablePath: fakeChrome });
  assert.equal(probe.available, true);
  assert.equal(probe.target, path.resolve(fakeChrome));
  assert.match(probe.detail, /Chrome/);
});

test('probeScheme(auto-connect)：无 DevToolsActivePort 时给出可执行指引', async (t) => {
  const emptyDir = await makeTempDir(t);
  const probe = await probeScheme('auto-connect', { userDataDir: emptyDir });
  assert.equal(probe.available, false);
  assert.match(probe.detail, /DevToolsActivePort/);
  assert.match(probe.detail, /chrome:\/\/inspect/);

  const withPort = await makeTempDir(t);
  await writeActivePort(withPort, 9444);
  const ok = await probeScheme('auto-connect', { userDataDir: withPort });
  assert.equal(ok.available, true);
  assert.equal(ok.target, 'ws://127.0.0.1:9444/devtools/browser/fake-browser');
  assert.match(ok.detail, /9444/);
});

test('probeScheme(browser-url)：端点可用 / 不可用 / URL 非法', async (t) => {
  const server = await startVersionServer(t);
  const available = await probeScheme('browser-url', { browserUrl: server.url });
  assert.equal(available.available, true);
  assert.equal(available.target, `ws://127.0.0.1:${server.port}/devtools/browser/fake`);
  assert.match(available.detail, /Chrome\/155/);

  const unavailable = await probeScheme('browser-url', { browserUrl: 'http://127.0.0.1:1' });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.detail, /json\/version/);

  const invalid = await probeScheme('browser-url', { browserUrl: 'not a host' });
  assert.equal(invalid.available, false);
  assert.match(invalid.detail, /browserUrl/);
});

test('probeScheme(ws-endpoint)：配置校验（空 / 协议 / headers 限制）', async () => {
  const empty = await probeScheme('ws-endpoint', {});
  assert.equal(empty.available, false);
  assert.match(empty.detail, /wsEndpoint/);

  const badProtocol = await probeScheme('ws-endpoint', { wsEndpoint: 'http://127.0.0.1:9222' });
  assert.equal(badProtocol.available, false);
  assert.match(badProtocol.detail, /ws:\/\//);

  const ok = await probeScheme('ws-endpoint', { wsEndpoint: 'wss://debug.example.test/devtools/browser/x' });
  assert.equal(ok.available, true);
  assert.equal(ok.target, 'wss://debug.example.test/devtools/browser/x');

  const withHeaders = await probeScheme('ws-endpoint', { wsEndpoint: 'ws://127.0.0.1:9222/x', wsHeaders: '{"X-Api-Key":"k"}' });
  assert.equal(withHeaders.available, false);
  assert.match(withHeaders.detail, /握手头/);

  const brokenHeaders = await probeScheme('ws-endpoint', { wsEndpoint: 'ws://127.0.0.1:9222/x', wsHeaders: '{bad' });
  assert.equal(brokenHeaders.available, false);
  assert.match(brokenHeaders.detail, /JSON/);
});

test('planScheme(launch)：给出 launch 计划，配置透传', async (t) => {
  const dir = await makeTempDir(t);
  const fakeChrome = await makeFakeChrome(t, dir);
  const plan = await planScheme('launch', {
    executablePath: fakeChrome,
    channel: 'beta',
    headless: true,
    isolated: false,
    userDataDir: dir,
    viewport: '1920x1080',
    connectTimeoutMs: 4321,
  });
  assert.equal(plan.kind, 'launch');
  assert.equal(plan.scheme, 'launch');
  assert.deepEqual(plan.executablePath, path.resolve(fakeChrome));
  assert.equal(plan.channel, 'beta');
  assert.equal(plan.headless, true);
  assert.equal(plan.isolated, false);
  assert.equal(plan.userDataDir, path.resolve(dir));
  assert.equal(plan.viewport, '1920x1080');
  assert.equal(plan.timeoutMs, 4321);

  const defaults = await planScheme('launch', {});
  assert.equal(defaults.kind, 'launch');
  assert.equal(defaults.headless, false);
  assert.equal(defaults.isolated, true);
  assert.equal(defaults.userDataDir, undefined, '未配置 userDataDir 时交给 launchChrome 用临时目录');
  assert.equal(defaults.executablePath, undefined, '未配置 executablePath 时交给 launchChrome 自动探测');
});

test('planScheme(auto-connect)：有端口文件给 ws 计划，没有则 invalid', async (t) => {
  const emptyDir = await makeTempDir(t);
  const invalid = await planScheme('auto-connect', { userDataDir: emptyDir });
  assert.equal(invalid.kind, 'invalid');
  assert.match(invalid.reason, /DevToolsActivePort/);

  const dir = await makeTempDir(t);
  await writeActivePort(dir, 9555);
  const plan = await planScheme('auto-connect', { userDataDir: dir });
  assert.equal(plan.kind, 'ws');
  assert.equal(plan.source, 'auto-connect');
  assert.equal(plan.wsUrl, 'ws://127.0.0.1:9555/devtools/browser/fake-browser');
  assert.equal(plan.userDataDir, dir);
});

test('planScheme(auto-connect)：缺省用 channel 推断的 profile 目录', async () => {
  // 不依赖本机是否真的开了调试：只断言「会去读那个目录」，没有文件时 invalid 的 reason 里带路径。
  const plan = await planScheme('auto-connect', { channel: 'canary' });
  if (plan.kind === 'invalid') {
    assert.match(plan.reason, /DevToolsActivePort/);
  } else {
    assert.equal(plan.kind, 'ws');
    assert.equal(plan.source, 'auto-connect');
  }
});

test('planScheme(browser-url)：/json/version 可用时给出 ws 计划', async (t) => {
  const server = await startVersionServer(t);
  const plan = await planScheme('browser-url', { browserUrl: server.url });
  assert.equal(plan.kind, 'ws');
  assert.equal(plan.source, 'browser-url');
  assert.equal(plan.wsUrl, `ws://127.0.0.1:${server.port}/devtools/browser/fake`);
  assert.equal(plan.browserUrl, server.url);

  const invalid = await planScheme('browser-url', { browserUrl: '127.0.0.1:1' });
  assert.equal(invalid.kind, 'invalid');
  assert.match(invalid.reason, /json\/version/);

  const badUrl = await planScheme('browser-url', { browserUrl: 'nope' });
  assert.equal(badUrl.kind, 'invalid');
  assert.match(badUrl.reason, /browserUrl/);
});

test('planScheme(ws-endpoint)：正常计划 / 校验失败分支', async () => {
  const plan = await planScheme('ws-endpoint', { wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/x' });
  assert.equal(plan.kind, 'ws');
  assert.equal(plan.source, 'ws-endpoint');
  assert.equal(plan.wsUrl, 'ws://127.0.0.1:9222/devtools/browser/x');
  assert.equal(plan.headers, undefined, '无 wsHeaders 时不应有 headers 字段');

  const withHeaders = await planScheme('ws-endpoint', {
    wsEndpoint: 'ws://127.0.0.1:9222/x',
    wsHeaders: '{"Authorization":"Bearer t"}',
  });
  assert.equal(withHeaders.kind, 'ws');
  assert.deepEqual(withHeaders.headers, { Authorization: 'Bearer t' });

  for (const config of [
    {},
    { wsEndpoint: 'http://127.0.0.1:9222' },
    { wsEndpoint: 'ws://127.0.0.1:9222/x', wsHeaders: '{bad' },
  ]) {
    const invalid = await planScheme('ws-endpoint', config);
    assert.equal(invalid.kind, 'invalid');
    assert.equal(typeof invalid.reason, 'string');
    assert.ok(invalid.reason.length > 0);
  }
});

test('planScheme：未知方案 → invalid', async () => {
  for (const bad of ['nope', '', null, 42]) {
    const plan = await planScheme(bad, {});
    assert.equal(plan.kind, 'invalid');
    assert.match(plan.reason, /未知连接方案/);
  }
});

test('probeAllSchemes：四个方案、字段严格符合契约、isCurrent 正确', async (t) => {
  const dir = await makeTempDir(t);
  const fakeChrome = await makeFakeChrome(t, dir);
  const versionServer = await startVersionServer(t);
  const results = await probeAllSchemes(
    {
      executablePath: fakeChrome,
      userDataDir: dir,
      browserUrl: versionServer.url,
      wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/x',
    },
    'browser-url',
  );
  assert.equal(results.length, 4);
  assert.deepEqual(
    results.map((entry) => entry.id),
    ['launch', 'auto-connect', 'browser-url', 'ws-endpoint'],
  );
  for (const entry of results) {
    assert.deepEqual(Object.keys(entry).sort(), ['available', 'detail', 'id', 'isCurrent', 'label']);
    assert.equal(typeof entry.available, 'boolean');
    assert.equal(typeof entry.detail, 'string');
    assert.equal(typeof entry.label, 'string');
  }
  assert.deepEqual(results.map((entry) => entry.isCurrent), [false, false, true, false]);
  assert.equal(results[0].available, true, 'launch 应可用（executablePath 指向真实文件）');
  assert.equal(results[2].available, true, 'browser-url 应可用');
  assert.equal(results[3].available, true, 'ws-endpoint 应可用');
});

test('probeAllSchemes：配置为空也不抛，四方案都给出结果', async () => {
  const results = await probeAllSchemes(undefined, undefined);
  assert.equal(results.length, 4);
  for (const entry of results) {
    assert.equal(typeof entry.available, 'boolean');
    assert.equal(entry.isCurrent, false);
  }
});
