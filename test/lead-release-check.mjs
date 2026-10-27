// 交付前自检：包完整性 / 无本机路径 / 无密钥 / 版本与 CHANGELOG 一致 / 工具数量与 schema。
//
// 用法：node test/lead-release-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

/** 读 UTF-8 文本。 */
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const manifest = JSON.parse(read('package.json'));

// 1) 清单字段
const expectedFiles = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  '.gitignore',
  '.gitattributes',
  'locale/en.json',
  'locale/zh.json',
  'lib/config.mjs',
  'lib/settings.mjs',
  'lib/errors.mjs',
  'lib/chrome.mjs',
  'lib/cdp.mjs',
  'lib/schemes.mjs',
  'lib/connection.mjs',
  'lib/page.mjs',
  'lib/observe.mjs',
  'lib/tools.mjs',
];
for (const rel of expectedFiles) {
  if (!fs.existsSync(path.join(root, rel))) failures.push(`缺少文件: ${rel}`);
}

// 2) exports 全部可解析
const exportsMap = manifest.exports ?? {};
for (const [key, target] of Object.entries(exportsMap)) {
  if (key.includes('*')) continue;
  const rel = String(target).replace(/^\.\//u, '');
  if (!fs.existsSync(path.join(root, rel))) failures.push(`exports["${key}"] 指向不存在的文件: ${target}`);
}
if (exportsMap['.'] === undefined) failures.push('exports 缺少 "."');
if (exportsMap['./client'] === undefined) failures.push('exports 缺少 "./client"');

// 3) dsh 声明
if (manifest.dsh?.bundle?.patch === undefined) failures.push('package.json 缺 dsh.bundle.patch');
if (manifest.dsh?.client === undefined) failures.push('package.json 缺 dsh.client（设置页）');
if (manifest.type !== 'module') failures.push('package.json 必须是 "type": "module"');
if (manifest.license !== 'MIT') failures.push(`license 应为 MIT（开源），实际 ${manifest.license}`);
if (manifest.private !== true) failures.push('private 应为 true（不发布到 npm）');

// 4) 版本与 CHANGELOG 首条一致
const version = manifest.version;
if (read('CHANGELOG.md').includes(`## ${version}`) === false) {
  failures.push(`CHANGELOG.md 里没有当前版本 ${version} 的条目`);
}
notes.push(`版本: ${version}`);

// 5) 无本机绝对路径
const scanRoots = ['lib', 'test', 'locale'];
const scanFiles = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'package.json'];
const sourceFiles = [];
for (const dir of scanRoots) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isFile()) sourceFiles.push(`${dir}/${entry.name}`);
  }
}
sourceFiles.push(...scanFiles);
const localPathPattern = /E:\\dsh-plugins|C:\\Users\\32471/u;
const secretPattern = /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}/u;
/** 设置页与 locale 是界面文案：不要 emoji（工具 summary 里用 ✅ 之类是 dsh 卡片惯例，不在检查范围）。 */
const UI_TEXT_FILES = new Set(['client.js', 'locale/en.json', 'locale/zh.json']);
for (const rel of sourceFiles) {
  const text = read(rel);
  if (localPathPattern.test(text)) failures.push(`${rel}: 含本机绝对路径`);
  if (secretPattern.test(text)) failures.push(`${rel}: 疑似密钥`);
  if (UI_TEXT_FILES.has(rel) && /[\u{1F300}-\u{1FAFF}]/u.test(text)) {
    failures.push(`${rel}: 界面文案里不要用 emoji`);
  }
}

// 6) 工具定义：数量、命名、schema 审计（复用 lead-schema-audit）
const auditModule = await import('./lead-schema-audit.mjs');
const audit = auditModule.auditToolDefinitions();
if (audit.ok === false) {
  for (const error of audit.errors) failures.push(`schema 审计: ${error}`);
}
if (audit.toolCount !== 22) failures.push(`工具数应为 22，实际 ${audit.toolCount}`);
notes.push(`工具数: ${audit.toolCount}`);

// 7) 21/22 之外：确认这四个核心方案 id 在 scheme 元数据里
const configModule = await import('../lib/config.mjs');
const schemeIds = configModule.SCHEME_IDS ?? [];
for (const id of ['launch', 'auto-connect', 'browser-url', 'ws-endpoint']) {
  if (!schemeIds.includes(id)) failures.push(`方案 id 缺失: ${id}`);
}

// 8) locale 双语 key 对齐
const zh = JSON.parse(read('locale/zh.json'));
const en = JSON.parse(read('locale/en.json'));
for (const section of ['meta', 'settings']) {
  for (const key of Object.keys(zh[section] ?? {})) {
    if (en[section]?.[key] === undefined) failures.push(`locale: en.json 缺 ${section}.${key}`);
  }
}

// 9) client.js bundle 形状
const client = read('client.js');
if (!client.includes('window.__ModuleLoader__.load')) failures.push('client.js 不是 ModuleLoader bundle');
if (!client.includes("id: 'dsh-chrome-devtools'")) failures.push('client.js 的 bundle id 不是 dsh-chrome-devtools');
if (!client.includes("SETTINGS_NS = 'chrome-devtools'")) failures.push('client.js 的设置命名空间不是 chrome-devtools（必须等于 patch 行 id）');
if (!client.includes("'/dsh-chrome-devtools'")) failures.push('client.js 没有走 /dsh-chrome-devtools RPC 通道');

// 10) patch 行 id 与命名空间一致
const patch = read('cordis.patch.yml');
if (!/- id: chrome-devtools/u.test(patch)) failures.push('cordis.patch.yml 缺 - id: chrome-devtools');
if (!/name: dsh-chrome-devtools/u.test(patch)) failures.push('cordis.patch.yml 缺 name: dsh-chrome-devtools');
for (const field of [
  'scheme',
  'browserUrl',
  'wsEndpoint',
  'wsHeaders',
  'channel',
  'executablePath',
  'headless',
  'isolated',
  'userDataDir',
  'viewport',
  'toolset',
  'screenshotDir',
  'connectTimeoutMs',
  'actionTimeoutMs',
]) {
  if (!patch.includes(`${field}:`)) failures.push(`cordis.patch.yml 缺字段 ${field}（id 定向 patch 会整块替换 config）`);
}

console.log('—— 交付前自检 ——');
for (const note of notes) console.log(`  · ${note}`);
if (failures.length === 0) {
  console.log('✅ 全部通过');
} else {
  console.error(`❌ ${failures.length} 个问题：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
