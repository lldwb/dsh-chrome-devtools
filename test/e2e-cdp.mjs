#!/usr/bin/env node
/**
 * 真机端到端验证（手动运行，**不**进 `node --test` 的默认 glob）。
 *
 *   node test/e2e-cdp.mjs
 *
 * 覆盖两条真实路径：
 *
 * 1. **方案 A（launch）**：真的启动一个 headless Chrome（`--remote-debugging-port=0` +
 *    独立 user-data-dir），读 `DevToolsActivePort`，走完整 `CdpBrowser`：`Browser.getVersion`
 *    → `Target.getTargets` → `Target.createTarget(data: URL)` → flat session attach →
 *    `Runtime.evaluate` → `Page.captureScreenshot`，最后清理进程与临时 profile。
 *
 * 2. **方案 B（auto-connect）只读验证**：读用户日常 Chrome 的 `DevToolsActivePort`，用裸
 *    `CdpConnection` 连上去，只调 `Browser.getVersion` 与 `Target.getTargets` 就断开。
 *    **绝不**导航、点击、关闭 tab、attach 页面或 kill 用户正在用的 Chrome；也**不**用
 *    `CdpBrowser.open()`（它会 `Target.setAutoAttach` 附着到用户所有 tab）。
 *
 * 退出码：方案 A 必须通过；方案 B 没有可用端点时记为 SKIP（环境问题，不算失败），
 * 有端点但连不上时记为 WARN 并打印原因（不重试）。全部通过打印 OK。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { CdpBrowser, CdpConnection } from '../lib/cdp.mjs';
import { defaultUserDataDir, launchChrome, readDevToolsActivePort, stopChrome } from '../lib/chrome.mjs';

/** 简单 sleep。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const results = [];
let failures = 0;

/** 记录一条通过。 */
function pass(name, detail = '') {
  results.push({ status: 'PASS', name, detail });
  console.log(`PASS  ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

/** 记录一条失败（方案 A 的失败会影响退出码）。 */
function fail(name, message) {
  failures += 1;
  results.push({ status: 'FAIL', name, detail: message });
  console.log(`FAIL  ${name} — ${message}`);
}

/** 记录一条跳过（环境不具备，不算失败）。 */
function skip(name, detail) {
  results.push({ status: 'SKIP', name, detail });
  console.log(`SKIP  ${name} — ${detail}`);
}

/** 记录一条警告（探测到了但连不上；不重试、不算失败）。 */
function warn(name, detail) {
  results.push({ status: 'WARN', name, detail });
  console.log(`WARN  ${name} — ${detail}`);
}

/** 断言辅助：条件不成立就抛错（由调用方捕获并记 fail）。 */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * 方案 A：启动 headless Chrome，跑完整 CDP 流程。
 */
async function testLaunchScheme() {
  console.log('\n=== 方案 A：启动全新 Chrome（headless） ===');
  /** @type {{ pid: number, port: number, wsUrl: string, userDataDir: string, isolated: boolean } | undefined} */
  let launched;
  /** @type {CdpBrowser | undefined} */
  let browser;
  let failed = false;
  try {
    launched = await launchChrome({ headless: true, viewport: { width: 1280, height: 800 }, timeoutMs: 20000 });
    check(typeof launched.pid === 'number' && launched.pid > 0, `启动结果没有有效 pid：${JSON.stringify(launched)}`);
    check(launched.port > 0 && launched.port !== 9222, `方案 A 应使用 --remote-debugging-port=0 自选端口，实际 port=${launched.port}`);
    check(launched.wsUrl.startsWith(`ws://127.0.0.1:${launched.port}/devtools/browser/`), `wsUrl 形状不对：${launched.wsUrl}`);
    pass('launch: Chrome 进程已启动', `pid=${launched.pid} port=${launched.port} profile=${launched.userDataDir}`);

    browser = await CdpBrowser.open(launched.wsUrl, { timeoutMs: 20000 });
    const version = browser.version;
    check(/Chrome|HeadlessChrome/i.test(version.browser), `Browser.getVersion 返回异常：${JSON.stringify(version)}`);
    check(version.protocolVersion !== '', 'Browser.getVersion 缺少 protocolVersion');
    pass('launch: Browser.getVersion', `${version.browser} · protocol ${version.protocolVersion}`);
    if (browser.warnings.length > 0) console.log(`       (非致命告警：${browser.warnings.join('; ')})`);

    const pages = await browser.listTargets();
    check(pages.length >= 1, `Target.getTargets 应至少有一个 page，实际 ${pages.length}`);
    check(pages.every((page) => page.type === 'page'), 'listTargets 返回了非 page 类型');
    pass('launch: Target.getTargets', `page 数=${pages.length} url=${JSON.stringify(pages[0].url)}`);

    const created = await browser.createTarget('data:text/html,<title>CDP E2E</title><h1 id="h">hello</h1>');
    check(typeof created.targetId === 'string' && created.targetId !== '', 'Target.createTarget 没有返回 targetId');
    const session = await browser.attach(created.targetId);
    check(session.sessionId !== '', 'attach 没有拿到 sessionId');
    await session.send('Runtime.enable');
    pass('launch: Target.createTarget + attach', `targetId=${created.targetId} sessionId=${session.sessionId}`);

    // 打开 data: URL 后页面是异步 ready 的，轮询到内容就绪（最多 ~8s）。
    let value;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const evaluated = await session.send('Runtime.evaluate', {
        expression: '({ title: document.title, text: document.querySelector("#h")?.textContent ?? "", ready: document.readyState })',
        returnByValue: true,
        awaitPromise: true,
      });
      value = evaluated?.result?.value;
      if (value?.ready === 'complete' && value?.text === 'hello') break;
      await sleep(100);
    }
    check(value?.text === 'hello', `Runtime.evaluate 没拿到 data: URL 内容：${JSON.stringify(value)}`);
    check(value.title === 'CDP E2E', `document.title 不对：${JSON.stringify(value.title)}`);
    pass('launch: Runtime.evaluate', `title=${JSON.stringify(value.title)} text=${JSON.stringify(value.text)} ready=${value.ready}`);

    const shot = await session.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 20000 });
    const pngBytes = Buffer.from(String(shot?.data ?? ''), 'base64').length;
    check(pngBytes > 100, `Page.captureScreenshot 返回数据过小：${pngBytes} bytes`);
    // 同时验证 PNG 魔数（89 50 4e 47）。
    const prefix = Buffer.from(String(shot.data).slice(0, 8), 'base64').subarray(0, 4).toString('hex');
    check(prefix === '89504e47', `截图不是 PNG（魔数 ${prefix}）`);
    pass('launch: Page.captureScreenshot', `${pngBytes} bytes · PNG`);

    await session.detach();
    pass('launch: session detach', '');
  } catch (error) {
    failed = true;
    fail('launch 方案', error instanceof Error ? error.message : String(error));
  } finally {
    // 清理顺序：先断 CDP，再 kill 进程，最后删临时 profile（Windows 上要等文件句柄释放）。
    if (browser !== undefined) {
      try {
        await browser.close();
      } catch {
        // 清理失败不影响结论。
      }
    }
    if (launched !== undefined) {
      try {
        await stopChrome(launched.pid);
        const gone = await waitForProcessGone(launched.pid, 5000);
        if (gone) pass('launch: Chrome 进程已清理', `pid=${launched.pid}`);
        else fail('launch: 清理进程', `pid=${launched.pid} 在 5s 内仍未退出`);
      } catch (error) {
        fail('launch: 清理进程', error instanceof Error ? error.message : String(error));
      }
      if (launched.isolated === true) {
        try {
          await fs.rm(launched.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
          pass('launch: 临时 profile 已删除', launched.userDataDir);
        } catch (error) {
          fail('launch: 删除临时 profile', error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (!failed) console.log('       （方案 A 全流程通过）');
  }
}

/** 轮询等待进程退出（pid 探测）。 */
async function waitForProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

/**
 * 方案 B：复用用户当前 Chrome 的只读验证。
 *
 * 安全约束（必须遵守）：
 * - 只用裸 `CdpConnection`，不用 `CdpBrowser`（后者会 setAutoAttach，附着到用户所有 tab）；
 * - 只调 `Browser.getVersion` 与 `Target.getTargets`；
 * - 不导航 / 不点击 / 不关闭 tab / 不 attach / 不 kill 用户 Chrome。
 */
async function testAutoConnectScheme() {
  console.log('\n=== 方案 B：复用当前 Chrome（只读探测） ===');
  const userDataDir = defaultUserDataDir('stable');
  const activePort = readDevToolsActivePort(userDataDir);
  if (activePort === undefined) {
    skip('auto-connect: DevToolsActivePort', `没有端点文件（${path.join(userDataDir, 'DevToolsActivePort')}）`);
    console.log('       需要 Chrome 144+ 运行中，并在 chrome://inspect/#remote-debugging 里允许远程调试。');
    return;
  }
  pass('auto-connect: 读到 DevToolsActivePort', `port=${activePort.port} wsPath=${activePort.wsPath}`);

  /** @type {CdpConnection | undefined} */
  let connection;
  try {
    connection = await CdpConnection.open(activePort.wsUrl, { timeoutMs: 10000 });
    pass('auto-connect: WebSocket 握手', '101 Switching Protocols');

    const version = await connection.send('Browser.getVersion');
    check(typeof version?.product === 'string' && version.product !== '', `Browser.getVersion 返回异常：${JSON.stringify(version)}`);
    pass('auto-connect: Browser.getVersion', version.product);

    const targets = await connection.send('Target.getTargets');
    const targetInfos = Array.isArray(targets?.targetInfos) ? targets.targetInfos : [];
    const pageCount = targetInfos.filter((target) => target.type === 'page').length;
    check(targetInfos.length >= 1, 'Target.getTargets 返回为空');
    pass('auto-connect: Target.getTargets', `target 数=${targetInfos.length} page 数=${pageCount}`);
    console.log('       （只读验证：没有导航、没有 attach、没有关闭任何 tab、没有碰用户 Chrome 进程）');
  } catch (error) {
    // 环境可能有端点但拒绝连接（例如用户刚关掉授权）：记为 WARN，不重试、不算失败。
    warn('auto-connect 方案', error instanceof Error ? error.message : String(error));
  } finally {
    if (connection !== undefined) {
      try {
        await connection.close();
        pass('auto-connect: 已断开（未影响浏览器）', '');
      } catch {
        // 忽略。
      }
    }
  }
}

/** 主流程。 */
async function main() {
  console.log('dsh-chrome-devtools — 真机 CDP 端到端验证');
  console.log(`node ${process.version} · ${process.platform}/${process.arch} · ${new Date().toISOString()}`);
  await testLaunchScheme();
  await testAutoConnectScheme();

  const passed = results.filter((entry) => entry.status === 'PASS').length;
  const skipped = results.filter((entry) => entry.status === 'SKIP').length;
  const warned = results.filter((entry) => entry.status === 'WARN').length;
  console.log(`\n结果：PASS ${passed} · FAIL ${failures} · SKIP ${skipped} · WARN ${warned}`);
  if (failures > 0) {
    console.log('E2E FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('OK');
}

main().catch((error) => {
  console.error('E2E 崩溃：', error);
  process.exitCode = 1;
});
