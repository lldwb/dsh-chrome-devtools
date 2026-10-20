/**
 * 工具定义的**独立** schema 审计（不依赖 dsh 内部实现，也不复用 tools.test 的断言）。
 *
 * 为什么自己写一份校验器：`ctx.tools.register()` 拿到的是编译后的严格 JSON Schema，
 * 只支持 `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` /
 * `enum` / `const` + 注释键；`required` 必须是字符串数组且名字都在 `properties` 里。
 * 只要有一个属性写错（最经典的是属性级 `required: true`），**整个插件都不会激活**；
 * 而 `execute` 的返回值不匹配 `output.schema` 时报 `tool returned invalid output`。
 * 这两道校验都只在运行时才失败，所以必须在单测里镜像一遍。
 *
 * 本文件的实现与 `test/lead-schema-audit.mjs`（Lead 另写的一份）互相独立：两份都过的
 * 工具定义才值得相信。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PageHandle } from '../lib/page.mjs';
import { SLIM_TOOL_NAMES, TOOL_NAMES, buildTools } from '../lib/tools.mjs';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* ------------------------------------------------------------------ *
 * 镜像：dsh 的严格 JSON Schema 子集
 * ------------------------------------------------------------------ */

/** 受支持的约束关键字。 */
const CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);

/** 允许的注解关键字。 */
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples']);

/** 允许的 `type` 取值（单个字符串）。 */
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** 只允许出现在标量节点上的关键字。 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** 每种 type 允许出现的关键字（enum/const 只允许出现在标量节点上）。 */
const ALLOWED_FOR_TYPE = {
  properties: new Set(['object']),
  required: new Set(['object']),
  additionalProperties: new Set(['object']),
  items: new Set(['array']),
  enum: new Set(['string', 'number', 'integer', 'boolean', 'null']),
  const: new Set(['string', 'number', 'integer', 'boolean', 'null']),
};

/** `oneOf` 旁不允许出现的关键字。 */
const ONEOF_FORBIDDEN = new Set(['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);

/** 普通 JSON 记录。 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** 紧凑的普通数组（没有额外属性、没有空洞）。 */
function isPlainArray(value) {
  if (!Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

/** lossless 有限 JSON 数字。 */
function isJsonNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

/** 标量是否匹配声明类型。 */
function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return isJsonNumber(value);
    case 'integer':
      return isJsonNumber(value) && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** 是否是 lossless JSON（undefined / NaN / -0 / 函数 / 稀疏数组 / 循环都判否）。 */
function isLosslessJson(value, seen = new Set()) {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return isJsonNumber(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (!isPlainArray(value)) return false;
      return value.every((entry) => isLosslessJson(entry, seen));
    }
    if (!isPlainRecord(value)) return false;
    return Object.keys(value).every((key) => value[key] !== undefined && isLosslessJson(value[key], seen));
  } finally {
    seen.delete(value);
  }
}

/**
 * 递归收集 schema 里离开受支持子集的点。
 *
 * @param {unknown} schema - 待检查节点。
 * @param {string} [where] - 诊断路径。
 * @param {string[]} [violations] - 收集器。
 * @param {Set<unknown>} [seen] - 循环引用检测。
 * @returns {string[]} 违规列表（空 = 合法）。
 */
function collectSchemaViolations(schema, where = 'schema', violations = [], seen = new Set()) {
  if (!isPlainRecord(schema)) {
    violations.push(`${where} must be a schema object`);
    return violations;
  }
  if (seen.has(schema)) {
    violations.push(`${where} is circular`);
    return violations;
  }
  seen.add(schema);
  try {
    const node = /** @type {Record<string, unknown>} */ (schema);
    for (const key of Object.keys(node)) {
      if (!CONSTRAINT_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) {
        violations.push(`${where}.${key} is not a supported keyword`);
      }
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${where}.description must be a string`);
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${where}.title must be a string`);
    }
    for (const annotation of ['default', 'examples']) {
      if (Object.hasOwn(node, annotation) && !isLosslessJson(node[annotation])) {
        violations.push(`${where}.${annotation} must be lossless JSON`);
      }
    }

    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(`${where} cannot declare both type and oneOf`);
      return violations;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONEOF_FORBIDDEN) {
        if (Object.hasOwn(node, key)) violations.push(`${where}.${key} requires type or oneOf`);
      }
      return violations;
    }
    if (hasOneOf) {
      for (const key of ONEOF_FORBIDDEN) {
        if (Object.hasOwn(node, key)) violations.push(`${where}.${key} is not supported beside oneOf`);
      }
      const branches = node.oneOf;
      if (!isPlainArray(branches) || branches.length < 2) {
        violations.push(`${where}.oneOf must be an array of at least two schemas`);
      } else {
        branches.forEach((branch, index) => collectSchemaViolations(branch, `${where}.oneOf[${index}]`, violations, seen));
      }
      return violations;
    }

    const type = node.type;
    if (typeof type !== 'string') {
      violations.push(`${where}.type must be a single type string (type arrays are not supported)`);
      return violations;
    }
    if (!SCHEMA_TYPES.has(type)) {
      violations.push(`${where}.type is not one of ${[...SCHEMA_TYPES].join('/')}`);
      return violations;
    }
    for (const [key, allowed] of Object.entries(ALLOWED_FOR_TYPE)) {
      if (Object.hasOwn(node, key) && !allowed.has(type)) {
        violations.push(`${where}.${key} is not supported on type "${type}"`);
      }
    }

    if (type === 'object') {
      if (Object.hasOwn(node, 'properties')) {
        if (!isPlainRecord(node.properties)) {
          violations.push(`${where}.properties must be an object of schemas`);
        } else {
          for (const [name, child] of Object.entries(node.properties)) {
            collectSchemaViolations(child, `${where}.properties.${name}`, violations, seen);
          }
        }
      }
      if (Object.hasOwn(node, 'required')) {
        if (!isPlainArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
          violations.push(`${where}.required must be an array of strings`);
        } else {
          const properties = isPlainRecord(node.properties) ? node.properties : {};
          for (const name of node.required) {
            if (!Object.hasOwn(properties, name)) violations.push(`${where}.required names "${name}" which is not in properties`);
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${where}.additionalProperties must be a boolean`);
      }
    }

    if (type === 'array' && Object.hasOwn(node, 'items')) {
      collectSchemaViolations(node.items, `${where}.items`, violations, seen);
    }

    if (SCALAR_TYPES.has(type)) {
      if (Object.hasOwn(node, 'enum')) {
        if (!isPlainArray(node.enum) || node.enum.length === 0 || node.enum.some((entry) => !scalarMatches(type, entry))) {
          violations.push(`${where}.enum must be a non-empty array of ${type} values`);
        }
      }
      if (Object.hasOwn(node, 'const') && !scalarMatches(type, node.const)) {
        violations.push(`${where}.const must be a ${type} value`);
      }
    }
    return violations;
  } finally {
    seen.delete(schema);
  }
}

/**
 * 按 schema 校验一个值（镜像 dsh 的 `validateJsonSchemaValue` 语义）。
 *
 * @param {unknown} schema - 严格 schema。
 * @param {unknown} value - 待校验值。
 * @param {string} [where] - 诊断路径。
 * @param {string[]} [violations] - 收集器。
 * @returns {string[]} 违规列表（空 = 通过）。
 */
function collectValueViolations(schema, value, where = 'value', violations = []) {
  const node = /** @type {Record<string, unknown>} */ (schema);
  if (Object.hasOwn(node, 'oneOf')) {
    const branches = node.oneOf;
    const matches = branches.filter((branch) => collectValueViolations(branch, value, where, []).length === 0).length;
    if (matches !== 1) violations.push(`${where} must match exactly one oneOf branch (matched ${matches})`);
    return violations;
  }
  if (!Object.hasOwn(node, 'type')) {
    if (!isLosslessJson(value)) violations.push(`${where} must be a lossless JSON value`);
    return violations;
  }
  const type = node.type;
  switch (type) {
    case 'object': {
      if (!isPlainRecord(value)) {
        violations.push(`${where} must be an object`);
        return violations;
      }
      const record = /** @type {Record<string, unknown>} */ (value);
      const properties = isPlainRecord(node.properties) ? node.properties : {};
      const required = isPlainArray(node.required) ? node.required : [];
      for (const name of required) {
        if (!Object.hasOwn(record, name) || record[name] === undefined) violations.push(`${where} is missing required property "${name}"`);
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(properties, key)) violations.push(`${where}.${key} is not a declared property (additionalProperties: false)`);
        }
      }
      for (const [name, child] of Object.entries(properties)) {
        if (!Object.hasOwn(record, name) || record[name] === undefined) continue;
        collectValueViolations(child, record[name], `${where}.${name}`, violations);
      }
      if (violations.length === 0 && !isLosslessJson(value)) violations.push(`${where} must be a lossless JSON object`);
      return violations;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${where} must be an array`);
        return violations;
      }
      if (Object.hasOwn(node, 'items')) {
        value.forEach((entry, index) => collectValueViolations(node.items, entry, `${where}[${index}]`, violations));
      }
      if (violations.length === 0 && !isLosslessJson(value)) violations.push(`${where} must be a dense lossless JSON array`);
      return violations;
    }
    default: {
      if (!scalarMatches(type, value)) {
        violations.push(`${where} must be a ${type}`);
        return violations;
      }
      if (Object.hasOwn(node, 'enum') && !node.enum.some((entry) => entry === value)) {
        violations.push(`${where} must be one of ${JSON.stringify(node.enum)}`);
      }
      if (Object.hasOwn(node, 'const') && node.const !== value) {
        violations.push(`${where} must be ${JSON.stringify(node.const)}`);
      }
      return violations;
    }
  }
}

/**
 * 镜像 `ctx.tools.register()` 的 register 期检查（另加 parameters 显式门禁）。
 *
 * @param {object} definition - 工具定义。
 * @returns {string[]} 违规列表。
 */
function checkToolDefinition(definition) {
  const violations = [];
  const name = definition?.name;
  if (typeof name !== 'string' || name === '') violations.push('tool definition must declare a name');
  if (typeof definition?.description !== 'string' || definition.description === '') violations.push(`tool "${name}" must declare a description`);
  const output = definition?.output;
  if (output === null || typeof output !== 'object' || typeof output.render !== 'function') {
    violations.push(`tool "${name}" must declare output { schema, render }`);
  } else {
    collectSchemaViolations(output.schema, `output.schema of "${name}"`, violations);
  }
  if (Object.hasOwn(definition ?? {}, 'parameters')) {
    collectSchemaViolations(definition.parameters, `parameters of "${name}"`, violations);
  }
  if (Object.hasOwn(definition ?? {}, 'presentCall') && typeof definition.presentCall !== 'function') {
    violations.push(`tool "${name}" presentCall must be a function`);
  }
  if (name === 'run_code') violations.push('tool name "run_code" is reserved');
  return violations;
}

/**
 * 完整镜像一次工具返回值检查（先 lossless 快照，再按 output.schema 校验）。
 *
 * @param {unknown} schema - output.schema。
 * @param {unknown} value - execute 返回值。
 * @returns {string[]} 违规列表。
 */
function validateToolOutput(schema, value) {
  if (!isLosslessJson(value)) return ['value is not lossless JSON'];
  const detached = JSON.parse(JSON.stringify(value));
  return collectValueViolations(schema, detached, 'value', []);
}

/* ------------------------------------------------------------------ *
 * 假依赖（与 tools.test 独立的一份）
 * ------------------------------------------------------------------ */

const FULL_CONFIG = Object.freeze({
  scheme: 'auto-connect',
  browserUrl: 'http://127.0.0.1:9222',
  wsEndpoint: '',
  channel: 'stable',
  executablePath: '',
  headless: false,
  isolated: true,
  userDataDir: '',
  viewport: '1280x800',
  toolset: 'full',
  screenshotDir: '',
  connectTimeoutMs: 15_000,
  actionTimeoutMs: 10_000,
});

/** 默认 CDP 响应。 */
function fakeResponse(method, params = {}) {
  if (method === 'Runtime.evaluate') {
    const expression = typeof params.expression === 'string' ? params.expression : '';
    if (expression.includes('dsh-cdp:locate')) {
      return { result: { type: 'object', value: { found: true, visible: true, error: '', x: 50, y: 60, width: 100, height: 20, tag: 'button' } } };
    }
    if (expression.includes('dsh-cdp:page-info')) return { result: { type: 'object', value: { url: 'https://example.test/page', title: 'Example Page' } } };
    if (expression.includes('dsh-cdp:fill')) return { result: { type: 'object', value: { ok: true, error: '', value: 'filled' } } };
    if (expression.includes('dsh-cdp:focus')) return { result: { type: 'object', value: { ok: true, error: '' } } };
    if (expression.includes('dsh-cdp:snapshot')) {
      return {
        result: {
          type: 'object',
          value: {
            url: 'https://example.test/',
            title: 'Example',
            items: [{ tag: 'button', type: 'submit', text: 'Go', path: '#go' }],
            text: 'hello world',
          },
        },
      };
    }
    if (expression.includes('dsh-cdp:wait-selector')) return { result: { type: 'object', value: { found: true, error: '' } } };
    if (expression.includes('dsh-cdp:wait-text')) return { result: { type: 'object', value: { found: true, error: '' } } };
    if (expression.includes('dsh-cdp:element-object')) return { result: { type: 'object', objectId: 'OBJ-1' } };
    return { result: { type: 'number', value: 42 } };
  }
  if (method === 'Page.captureScreenshot') return { data: ONE_PIXEL_PNG_BASE64 };
  if (method === 'Page.getLayoutMetrics') {
    return { cssContentSize: { width: 1280, height: 2400 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
  }
  if (method === 'Page.navigate') return { frameId: 'FRAME-1', loaderId: 'LOADER-1' };
  return {};
}

/**
 * 建一套足以让 22 个工具全部执行的假依赖。
 *
 * @param {{ screenshotDir?: string }} [options] - 截图目录覆盖。
 * @returns {object} deps。
 */
function createDeps(options = {}) {
  const listeners = new Map();
  const session = {
    targetId: 'PAGE-1',
    sessionId: 'SESSION-1',
    async send(method, params = {}) {
      return fakeResponse(method, params);
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    async waitFor() {
      return {};
    },
    detach() {},
  };
  const targets = [
    { targetId: 'PAGE-1', type: 'page', url: 'https://example.test/', title: 'Example', attached: true },
    { targetId: 'PAGE-2', type: 'page', url: 'https://example.test/two', title: 'Two', attached: true },
  ];
  const browser = {
    version: { browser: 'Chrome/155.0.0' },
    async listTargets() {
      return targets.map((target) => ({ ...target }));
    },
    async createTarget(url) {
      targets.push({ targetId: 'PAGE-NEW', type: 'page', url, title: '', attached: true });
      return { targetId: 'PAGE-NEW' };
    },
    async closeTarget(targetId) {
      const index = targets.findIndex((target) => target.targetId === targetId);
      if (index >= 0) targets.splice(index, 1);
    },
    async attach() {
      return session;
    },
    async detach() {},
    async close() {},
  };
  const manager = {
    status() {
      return {
        connected: true,
        scheme: 'launch',
        wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
        browserVersion: 'Chrome/155.0.0',
        launchedPid: 4321,
        launchedUserDataDir: '',
        lastError: '',
        pageCount: targets.length,
      };
    },
    async connect(connectOptions = {}) {
      return {
        scheme: connectOptions.scheme ?? 'launch',
        wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
        browserVersion: 'Chrome/155.0.0',
        reused: false,
        launchedPid: 4321,
      };
    },
    async disconnect() {
      return { closedOwnedBrowser: false };
    },
    async browser() {
      return browser;
    },
    async activePage() {
      return { session, page: new PageHandle(session, 'PAGE-1') };
    },
    async dispose() {},
  };
  const config = { ...FULL_CONFIG, screenshotDir: options.screenshotDir ?? '' };
  return {
    manager,
    getConfig: () => config,
    logger: undefined,
    schemes: {
      probeAllSchemes: async () => [
        { id: 'launch', label: '方案 A', available: true, detail: 'ok', isCurrent: true },
        { id: 'auto-connect', label: '方案 B', available: false, detail: 'no file', isCurrent: false },
        { id: 'browser-url', label: '方案 C', available: false, detail: 'no port', isCurrent: false },
        { id: 'ws-endpoint', label: '方案 D', available: false, detail: 'not configured', isCurrent: false },
      ],
    },
  };
}

/** 22 个工具的合法调用参数。 */
function callArgs(uploadFile) {
  return {
    browser_status: {},
    browser_connect: { scheme: 'launch' },
    browser_disconnect: {},
    browser_navigate: { url: 'https://target.test/' },
    browser_list_pages: {},
    browser_select_page: { pageId: 'PAGE-2' },
    browser_close_page: { pageId: 'PAGE-2' },
    browser_screenshot: {},
    browser_snapshot: {},
    browser_console: {},
    browser_network: {},
    browser_click: { selector: 'button' },
    browser_fill: { selector: '#email', value: 'user@example.test' },
    browser_type: { text: 'abc' },
    browser_press_key: { key: 'Tab' },
    browser_hover: { selector: 'a' },
    browser_wait_for: { selector: '#done' },
    browser_handle_dialog: { accept: true },
    browser_upload_file: { selector: 'input[type=file]', files: [uploadFile] },
    browser_drag: { fromSelector: '#a', toSelector: '#b' },
    browser_evaluate: { expression: 'document.title' },
    browser_ping: {},
  };
}

/* ------------------------------------------------------------------ *
 * 审计
 * ------------------------------------------------------------------ */

test('校验器自检：能识别出属性级 required、type 数组、oneOf 旁字段等致命错', () => {
  assert.deepEqual(collectSchemaViolations({ type: 'string' }), []);
  assert.deepEqual(
    collectSchemaViolations({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] }),
    [],
  );
  // 属性级 required: true（最经典的不激活原因）
  assert.ok(collectSchemaViolations({ type: 'object', properties: { a: { type: 'string', required: true } } }).length > 0);
  // type 数组
  assert.ok(collectSchemaViolations({ type: ['string', 'null'] }).length > 0);
  // required 名字不在 properties 里
  assert.ok(collectSchemaViolations({ type: 'object', properties: {}, required: ['ghost'] }).length > 0);
  // required 不是数组
  assert.ok(collectSchemaViolations({ type: 'object', properties: { a: { type: 'string' } }, required: 'a' }).length > 0);
  // oneOf 旁不能有 properties
  assert.ok(collectSchemaViolations({ oneOf: [{ type: 'string' }, { type: 'number' }], properties: {} }).length > 0);
  // 不支持的键
  assert.ok(collectSchemaViolations({ type: 'string', format: 'uri' }).length > 0);
  // items 只能用于 array；properties 只能用于 object
  assert.ok(collectSchemaViolations({ type: 'string', items: { type: 'string' } }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'string', properties: {} }).length > 0);
  // enum 必须是非空标量数组
  assert.ok(collectSchemaViolations({ type: 'string', enum: [] }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'object', enum: ['a'] }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'string', enum: [1] }).length > 0);
});

test('校验器自检：能识别返回值违规（缺 required / 多字段 / 类型错 / 非 lossless）', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { summary: { type: 'string' }, count: { type: 'number' } },
    required: ['summary', 'count'],
  };
  assert.deepEqual(collectValueViolations(schema, { summary: 'ok', count: 1 }, 'value'), []);
  assert.ok(collectValueViolations(schema, { summary: 'ok' }, 'value').some((entry) => entry.includes('count')));
  assert.ok(collectValueViolations(schema, { summary: 'ok', count: 1, extra: true }, 'value').some((entry) => entry.includes('extra')));
  assert.ok(collectValueViolations(schema, { summary: 1, count: 1 }, 'value').length > 0);
  // 非 lossless：undefined 属性 / NaN
  assert.equal(isLosslessJson({ a: undefined }), false);
  assert.equal(isLosslessJson({ a: Number.NaN }), false);
  assert.equal(isLosslessJson({ a: [1, , 3] }), false);
  assert.equal(isLosslessJson({ a: 1 }), true);
});

test('每个工具定义都通过 register 期镜像校验（含 parameters、output.schema、render）', () => {
  const deps = createDeps();
  for (const definition of buildTools(deps)) {
    const violations = checkToolDefinition(definition);
    assert.deepEqual(violations, [], `${definition.name} 的定义不合法：\n${violations.join('\n')}`);
    assert.match(definition.name, /^[a-z][a-z0-9_]*$/u, `${definition.name} 必须是 snake_case`);
  }
});

test('22 个工具名齐全且与契约 §5.2 顺序一致；slim 模式恰好 5 个', () => {
  const full = buildTools(createDeps()).map((definition) => definition.name);
  assert.deepEqual(full, [...TOOL_NAMES]);
  assert.equal(full.length, 22);
  const slim = buildTools({ ...createDeps(), getConfig: () => ({ ...FULL_CONFIG, toolset: 'slim' }) }).map((definition) => definition.name);
  assert.deepEqual(slim, [...SLIM_TOOL_NAMES]);
  assert.equal(slim.length, 5);
  for (const name of slim) assert.ok(TOOL_NAMES.includes(name), `${name} 不在 22 个工具里`);
});

test('所有 output.schema 都是严格 object 且每个声明的属性都在 required 里', () => {
  const deps = createDeps();
  for (const definition of buildTools(deps)) {
    const schema = definition.output.schema;
    assert.equal(schema.type, 'object', `${definition.name}: output 必须 object-rooted`);
    assert.equal(schema.additionalProperties, false, `${definition.name}: output 必须 additionalProperties:false`);
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      Object.keys(schema.properties).sort(),
      `${definition.name}: 所有输出字段都必须 required（可选字段用空值表达）`,
    );
    // 参数 schema 也必须是严格 object
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
  }
});

test('每个工具的 execute 返回值都严格满足自己的 output.schema（22 个全量执行）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-schema-smoke-'));
  try {
    const uploadFile = path.join(directory, 'upload.txt');
    writeFileSync(uploadFile, 'hello', 'utf8');
    const deps = createDeps({ screenshotDir: directory });
    const tools = buildTools(deps);
    const byName = new Map(tools.map((definition) => [definition.name, definition]));
    const args = callArgs(uploadFile);

    for (const name of TOOL_NAMES) {
      await t.test(name, async () => {
        const definition = byName.get(name);
        assert.ok(definition !== undefined, `${name} 未注册`);
        const value = await definition.execute(args[name], {});
        const violations = validateToolOutput(definition.output.schema, value);
        assert.deepEqual(violations, [], `${name} 的返回值不满足 output.schema：\n${violations.join('\n')}`);
        // summary 必须是非空字符串（render 与契约 §5.2 都要求）
        assert.equal(typeof value.summary, 'string');
        assert.ok(value.summary.length > 0);

        // render 必须消费自己的返回值并产出合法 content blocks
        const rendered = definition.output.render(args[name], value);
        assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name}: render 返回空`);
        for (const block of rendered) {
          assert.equal(block.type, 'text', `${name}: render 只能返回 text 块`);
          assert.equal(typeof block.text, 'string', `${name}: block.text 必须是字符串`);
        }
        assert.ok(rendered[0].text.includes(value.summary), `${name}: 第一块应包含 summary`);

        // presentCall 形状
        const present = definition.presentCall(args[name]);
        assert.equal(present.card, 'generic');
        assert.equal(present.kind, 'read');
        assert.equal(typeof present.title, 'string');
        assert.ok(present.title.length > 0);
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('工具描述是英文且说明「需要 Chrome / 先连接」（模型可判断何时调用）', () => {
  const deps = createDeps();
  for (const definition of buildTools(deps)) {
    assert.ok(definition.description.length > 20, `${definition.name}: description 太短`);
    assert.match(definition.description, /[A-Za-z]/u);
    // 每个工具都应说明「需要 Chrome 或先 connect」这一前提（browser_status/connect/ping 也提到 scheme/connected）
    assert.match(
      definition.description,
      /Chrome|connect|connected|connection|scheme/iu,
      `${definition.name}: description 必须说明连接前提`,
    );
  }
});
