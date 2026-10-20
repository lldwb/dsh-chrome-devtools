#!/usr/bin/env node
/**
 * 页面语义层的真机端到端验证（手动运行，**不**进 `node --test` 的默认 glob）。
 *
 *   node test/e2e-page.mjs
 *
 * ## 为什么需要这个脚本（真实事故）
 *
 * `browser_snapshot` 曾在真实 Loader 里抛
 * `ReferenceError: normalizeStep is not defined`：`cssPathFromParts` 被 `toString()`
 * 内联进页面后引用了模块作用域的函数。离线单测（假 session 按 `/* dsh-cdp:* *​/` 标记
 * 返回固定值、从不真正执行内联脚本）全绿也发现不了。所以这个脚本**真的启动 Chrome、
 * 真的执行内联脚本**，把 PageHandle 的每个动作跑一遍；CI 里可以不跑，改动 page.mjs
 * 之后必须手动跑一次。
 *
 * ## 安全边界
 *
 * 只用方案 A（`launch` + `headless` + 独立临时 profile）：**绝不**连接用户正在用的
 * Chrome，结束时 `manager.dispose()` 关掉自己启动的进程并删临时 profile。
 *
 * 退出码：全部通过打印 OK 并 exit 0；任一失败打印 FAIL 并 exit 1。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveOptions } from '../lib/config.mjs';
import { BrowserManager } from '../lib/connection.mjs';
import { buildTools } from '../lib/tools.mjs';

/** 测试页面：一个按钮（onclick 计数）+ 一个输入框 + 一个可点击链接。 */
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Page E2E</title></head>
<body>
  <h1>Hello E2E</h1>
  <button id="inc" onclick="window.__clicks = (window.__clicks || 0) + 1">Increase</button>
  <input name="q" value="">
  <textarea id="note"></textarea>
  <script>console.log('page-ready');</script>
</body></html>`;

const DATA_URL = `data:text/html;base64,${Buffer.from(PAGE_HTML, 'utf8').toString('base64')}`;

const results = [];
let failures = 0;

/** 记录一条通过。 */
function pass(name, detail = '') {
  results.push({ status: 'PASS', name, detail });
  console.log(`PASS  ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

/** 记录一条失败。 */
function fail(name, message) {
  failures += 1;
  results.push({ status: 'FAIL', name, detail: message });
  console.log(`FAIL  ${name} — ${message}`);
}

/** 断言辅助：不成立就抛错。 */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** 跑一个步骤，失败记录但不中断（继续跑后续步骤，输出更完整）。 */
async function step(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail ?? '');
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-page-'));
  /** 与真实运行一致：manager 与工具层读同一份配置。 */
  const getConfig = () =>
    resolveOptions({
      scheme: 'launch',
      headless: true,
      isolated: true,
      channel: 'stable',
      viewport: '1280x800',
      connectTimeoutMs: 30_000,
      actionTimeoutMs: 15_000,
      screenshotDir,
    });
  const manager = new BrowserManager(() => getConfig());

  try {
    /** @type {any} */
    let page;

    await step('launch + activePage：启动 headless Chrome 并拿到页面句柄', async () => {
      const active = await manager.activePage();
      check(active !== null && typeof active === 'object', 'activePage() 没有返回对象');
      check(active.page !== undefined && active.page !== null, 'activePage() 没有返回 PageHandle');
      page = active.page;
      const status = manager.status();
      check(status.connected === true, `连接状态不是 connected：${JSON.stringify(status)}`);
      return `pid=${status.launchedPid} 页面数=${status.pageCount}`;
    });

    await step('navigate：打开 data: 页面', async () => {
      const info = await page.navigate(DATA_URL, { waitUntil: 'load', timeoutMs: 20_000 });
      check(info.title === 'Page E2E', `标题不对：${JSON.stringify(info)}`);
      check(info.url.startsWith('data:text/html'), `URL 不对：${info.url}`);
      return `title=${info.title}`;
    });

    await step('snapshot：不再 ReferenceError，返回元素清单 + 稳定 CSS path（本次事故回归）', async () => {
      const snapshot = await page.snapshot({ maxChars: 12_000 });
      check(typeof snapshot.text === 'string' && snapshot.text.length > 0, 'snapshot.text 为空');
      check(snapshot.text.includes('button'), 'snapshot 里没有 button 元素');
      check(snapshot.text.includes('#inc'), 'snapshot 里缺少 button 的 #inc CSS path');
      check(snapshot.text.includes('input[name="q"]'), 'snapshot 里缺少 input 的 name CSS path');
      check(snapshot.text.includes('textarea'), 'snapshot 里没有 textarea 元素');
      check(snapshot.text.includes('Hello E2E'), 'snapshot 里没有页面可见文本');
      check(snapshot.truncated === false, `不应该截断：${snapshot.text.length} 字符`);
      return `元素数≈${(snapshot.text.match(/^- /gmu) ?? []).length} · ${snapshot.text.split('\n').length} 行`;
    });

    await step('fill：native setter + input/change 让受控/普通输入框真的更新', async () => {
      await page.fill('input[name="q"]', 'hello world');
      const value = await page.evaluate('document.querySelector("input[name=q]").value');
      check(value === 'hello world', `input.value 没被填入：${JSON.stringify(value)}`);
      return `input.value=${value}`;
    });

    await step('fill：textarea 也生效', async () => {
      await page.fill('#note', 'multi line');
      const value = await page.evaluate('document.querySelector("#note").value');
      check(value === 'multi line', `textarea.value 没被填入：${JSON.stringify(value)}`);
      return `textarea.value=${value}`;
    });

    await step('click：Input.dispatchMouseEvent 真的触发了页面 onclick', async () => {
      await page.click('#inc');
      const clicks = await page.evaluate('window.__clicks');
      check(clicks === 1, `onclick 没有被触发（window.__clicks=${JSON.stringify(clicks)}）`);
      return 'window.__clicks=1';
    });

    await step('click 双击：clickCount=2 触发两次 onclick', async () => {
      await page.click('#inc', { clickCount: 2 });
      const clicks = await page.evaluate('window.__clicks');
      check(clicks === 3, `双击后 __clicks 应为 3，实际 ${JSON.stringify(clicks)}`);
      return 'window.__clicks=3';
    });

    await step('waitFor：selector 与 text 都能等到', async () => {
      const bySelector = await page.waitFor({ selector: '#inc', timeoutMs: 5000 });
      check(bySelector.matched === true, `selector 等待失败：${JSON.stringify(bySelector)}`);
      const byText = await page.waitFor({ text: 'Hello E2E', timeoutMs: 5000 });
      check(byText.matched === true, `text 等待失败：${JSON.stringify(byText)}`);
      return `selector ${bySelector.waitedMs}ms / text ${byText.waitedMs}ms`;
    });

    await step('evaluate：表达式求值与异常报告', async () => {
      const sum = await page.evaluate('1 + 2 + 3');
      check(sum === 6, `1+2+3 应为 6，实际 ${JSON.stringify(sum)}`);
      const detail = await page.evaluateDetailed('(() => { throw new Error("boom"); })()');
      check(detail.ok === false, 'evaluateDetailed 应把异常报成 ok=false');
      check(detail.exception.includes('boom'), `异常文本应包含 boom：${detail.exception}`);
      return 'evaluate=6 / exception 已捕获';
    });

    await step('pressKey：Tab 真的移动焦点', async () => {
      await page.evaluate('document.querySelector("#inc").focus()');
      await page.pressKey('Tab');
      const active = await page.evaluate('document.activeElement && document.activeElement.name');
      check(active === 'q', `Tab 后焦点应在 input[name=q]，实际 ${JSON.stringify(active)}`);
      return '焦点移到 input[name=q]';
    });

    await step('type：Input.insertText 逐字符输入', async () => {
      await page.evaluate('document.querySelector("textarea").value = ""');
      await page.type('typed text', { selector: '#note' });
      const value = await page.evaluate('document.querySelector("#note").value');
      check(value === 'typed text', `输入结果不对：${JSON.stringify(value)}`);
      return `textarea.value=${value}`;
    });

    await step('screenshot：真实落盘且 PNG 尺寸 > 0', async () => {
      const target = path.join(screenshotDir, 'page.png');
      const shot = await page.screenshot({ path: target });
      check(shot.path === path.resolve(target), `路径不对：${shot.path}`);
      check(shot.bytes > 1000, `截图字节数太小：${shot.bytes}`);
      check(shot.width > 100 && shot.height > 100, `截图尺寸异常：${shot.width}x${shot.height}`);
      await fs.stat(target);
      return `${shot.width}x${shot.height} · ${shot.bytes} 字节`;
    });

    await step('console：捕获页面 console.log', async () => {
      await page.enableConsoleCapture();
      await page.evaluate('console.log("captured-from-e2e")');
      // 事件是异步到达的，稍等一拍
      await new Promise((resolve) => setTimeout(resolve, 200));
      const messages = page.consoleMessages({ limit: 50 });
      check(
        messages.some((message) => message.text.includes('captured-from-e2e')),
        `没有捕获到 console.log：${JSON.stringify(messages)}`,
      );
      return `已捕获 ${messages.length} 条控制台消息`;
    });

    await step('browser_status 的探测路径（真实 manager.status）', async () => {
      const status = manager.status();
      check(status.connected === true, '状态应为已连接');
      check(typeof status.browserVersion === 'string' && /Chrome/iu.test(status.browserVersion), `version 异常：${status.browserVersion}`);
      return `${status.browserVersion}`;
    });

    await step('工具层全链路：browser_snapshot / fill / click / wait_for / evaluate（事故现场复现）', async () => {
      const tools = buildTools({ manager, getConfig, logger: undefined });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      check(tools.length === 22, `应注册 22 个工具，实际 ${tools.length}`);

      // 事故现场：工具层 browser_snapshot → PageHandle.snapshot → 内联脚本
      const snapshot = await byName.get('browser_snapshot').execute({}, {});
      check(snapshot.text.includes('#inc'), `browser_snapshot 返回里缺少 #inc：${snapshot.text.slice(0, 300)}`);
      check(snapshot.text.includes('input[name="q"]'), 'browser_snapshot 返回里缺少 input[name="q"]');
      check(snapshot.pageUrl.startsWith('data:text/html'), `pageUrl 不对：${snapshot.pageUrl}`);
      const rendered = byName.get('browser_snapshot').output.render({}, snapshot);
      check(Array.isArray(rendered) && rendered[0].text === snapshot.summary, 'render 第一块应是 summary');

      const filled = await byName.get('browser_fill').execute({ selector: '#note', value: 'tool-level-fill' }, {});
      check(filled.filled === 1 && filled.failed === 0, `browser_fill 失败：${JSON.stringify(filled)}`);
      const value = await page.evaluate('document.querySelector("#note").value');
      check(value === 'tool-level-fill', `工具层 fill 没生效：${JSON.stringify(value)}`);

      const clicked = await byName.get('browser_click').execute({ selector: '#inc' }, {});
      check(clicked.ok === true, 'browser_click 失败');
      const clicks = await page.evaluate('window.__clicks');
      check(clicks === 4, `工具层 click 后 __clicks 应为 4，实际 ${JSON.stringify(clicks)}`);

      const waited = await byName.get('browser_wait_for').execute({ selector: '#inc', timeoutMs: 5000 }, {});
      check(waited.matched === true, `browser_wait_for 失败：${JSON.stringify(waited)}`);

      const evaluated = await byName.get('browser_evaluate').execute({ expression: 'document.title' }, {});
      check(evaluated.ok === true && evaluated.result === 'Page E2E', `browser_evaluate 失败：${JSON.stringify(evaluated)}`);

      return `${tools.length} 个工具已注册 · 5 个真实调用通过`;
    });
  } finally {
    try {
      await manager.dispose();
    } catch (error) {
      console.log(`WARN  清理时出错（忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
    await fs.rm(screenshotDir, { recursive: true, force: true });
  }

  console.log(`\n结果：${results.filter((entry) => entry.status === 'PASS').length} 通过 / ${failures} 失败`);
  if (failures > 0) {
    console.log('FAILED');
    process.exit(1);
  }
  console.log('OK: 页面语义层真机回归通过（snapshot 无 ReferenceError）');
}

await main();
