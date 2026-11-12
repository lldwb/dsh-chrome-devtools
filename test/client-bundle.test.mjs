/**
 * `client.js`（手写 ModuleLoader bundle）与 `locale/*.json` 的离线单测。
 *
 * 本文件不启动浏览器、不渲染 React，只验证四件事：
 *
 * 1. bundle 是合法的 JS，且用 `window.__ModuleLoader__.load({ id, factory })` 注册；
 * 2. 工厂只 `require` 静态模块表里的两个说明符（`react/jsx-runtime` 与
 *    `@deepseek-ai/dsh-client-ui-primitives`），exports 出 `apply` / `inject`；
 * 3. `apply` 在假 ctx 上能跑通，并把设置页注册到 `plugins.item` 槽位（id 与设置
 *    命名空间一致 = `chrome-devtools`）；
 * 4. 页面内嵌的中英词典 key 完全对齐，locale JSON 合法且四段文案齐全。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, '..');
const clientPath = path.join(packageRoot, 'client.js');

/** 期望的 bundle id（= 包名）。 */
const BUNDLE_ID = 'dsh-chrome-devtools';

/** 期望的设置命名空间（= Loader 行 id，不是包名）。 */
const SETTINGS_NS = 'chrome-devtools';

/** 期望的 RPC 通道（与 Host 半 lib/settings.mjs 的常量一致）。 */
const RPC_CHANNEL = '/dsh-chrome-devtools';

/** 读取 client.js 源码。 */
function readClientSource() {
  return readFileSync(clientPath, 'utf8');
}

/**
 * 在 vm 里执行 client.js，捕获它传给 `window.__ModuleLoader__.load` 的 definition。
 *
 * factory 闭包的作用域是 vm 的全局环境，所以浏览器全局（setInterval / setTimeout）
 * 必须由 sandbox 提供：controller 构造时就会调 `setInterval` 做状态轮询，宿主
 * `globalThis` 上的替换对它无效。这里给的是不真实调度的假定时器，测试进程不会被
 * 轮询挂住。
 *
 * @returns {{ definition: object, sandbox: object }}
 */
function loadBundleDefinition() {
  const source = readClientSource();
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          sandbox.captured = definition;
        },
      },
    },
    setInterval: () => ({ fakeTimer: true }),
    clearInterval: () => {},
    setTimeout: (callback) => {
      void callback;
      return 0;
    },
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(sandbox.captured, 'client.js 必须调用 window.__ModuleLoader__.load({ id, factory })');
  return { definition: sandbox.captured, sandbox };
}

/** 页面对 `react/jsx-runtime` 的最小替身。 */
const jsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
};

/** 页面对 `@deepseek-ai/dsh-client-ui-primitives` 的最小替身。 */
function fakePrimitives(options = {}) {
  /** 各字段的暂存文本（按用例配置；默认全空）。 */
  const fieldText = options.fieldText ?? {};
  class FakeSettingsFormModel {
    constructor(scope, fields, secrets) {
      this.scope = scope;
      this.fields = fields;
      this.secrets = secrets;
      this.actionsObject = {
        edit: () => {},
        resetField: () => {},
        save: () => {},
        discard: () => {},
      };
    }

    bind(project) {
      const store = {
        value: undefined,
        get() {
          return project();
        },
        set(next) {
          store.value = next;
        },
      };
      return store;
    }

    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
    }

    field(field) {
      return {
        text: typeof fieldText[field] === 'string' ? fieldText[field] : '',
        overridden: false,
        invalid: false,
      };
    }

    actions() {
      return this.actionsObject;
    }

    dispose() {}
  }

  const fieldType = (field) => ({
    field,
    format: (value) => (value === undefined || value === null ? '' : String(value)),
    parse: (text) => ({ kind: 'set', value: text }),
  });

  return {
    SettingsFormModel: FakeSettingsFormModel,
    SettingsForm: function SettingsForm() {
      return null;
    },
    SettingsValueField: function SettingsValueField() {
      return null;
    },
    SettingsSecretField: function SettingsSecretField() {
      return null;
    },
    Switch: function Switch() {
      return null;
    },
    Checkbox: function Checkbox() {
      return null;
    },
    settingsTextField: fieldType,
    settingsNumberField: (field) => ({
      field,
      format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
      parse: (text) => (String(text ?? '').trim() === '' ? { kind: 'clear' } : { kind: 'set', value: Number(text) }),
    }),
  };
}

/**
 * 执行 bundle 工厂，返回 exports 与 require 过的说明符。
 *
 * @param {object} [options] - 传给 `fakePrimitives` 的选项（例如 `fieldText`）。
 * @returns {{ module: object, requested: string[] }}
 */
function instantiateBundle(options = {}) {
  const { definition } = loadBundleDefinition();
  const requested = [];
  const module = definition.factory((specifier) => {
    requested.push(specifier);
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives(options);
    throw new Error(`client.js require 了静态模块表之外的模块: ${specifier}`);
  });
  return { module, requested };
}

// ─── bundle 形态 ───────────────────────────────────────────

test('client.js 是合法 JS（vm 与 new Function 都能解析）', () => {
  const source = readClientSource();
  assert.doesNotThrow(() => new Function(source));
  assert.doesNotThrow(() => loadBundleDefinition());
});

test('bundle 以包名为 id 注册，工厂可执行并导出 apply / inject', () => {
  const { definition } = loadBundleDefinition();
  assert.equal(definition.id, BUNDLE_ID);
  assert.equal(typeof definition.factory, 'function');

  const { module } = instantiateBundle();
  assert.equal(typeof module.apply, 'function');
  assert.ok(Array.isArray(module.inject), 'exports.inject 必须是数组');
  for (const required of ['slots', 'locale', 'configForms', 'connection']) {
    assert.ok(module.inject.includes(required), `inject 必须包含 ${required}`);
  }
  assert.equal(module.SETTINGS_NS, SETTINGS_NS);
  assert.equal(module.RPC_CHANNEL, RPC_CHANNEL);
  assert.equal(typeof module.NS, 'string');
  assert.ok(module.NS.length > 0);
});

test('工厂只 require 静态模块表里的两个说明符', () => {
  const { requested } = instantiateBundle();
  assert.deepEqual(requested.slice().sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react/jsx-runtime']);
});

test('client.js 不写死本机绝对路径、不展示 emoji', () => {
  const source = readClientSource();
  assert.equal(source.includes('E:\\'), false, 'client.js 不能写死本机绝对路径');
  assert.equal(source.includes('/E:/'), false, 'client.js 不能写死本机绝对路径');
  assert.equal(/[A-Za-z]:\\\\/u.test(source), false, 'client.js 不能出现 Windows 盘符路径');
  // 只拦常见的 emoji 区段（任务要求界面不展示 emoji）。
  assert.equal(
    /[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(source),
    false,
    'client.js 不能包含 emoji',
  );
});

// ─── apply 冒烟 ────────────────────────────────────────────

/**
 * 默认的 connect RPC 返回值（方案 B：连用户正在用的浏览器）。
 * 单个用例要测别的形状时用 `fakeClientCtx({ connectValue })` 覆盖。
 */
const DEFAULT_CONNECT_VALUE = {
  connected: true,
  scheme: 'auto-connect',
  schemeLabel: '方案 B：复用当前浏览器（autoConnect）',
  wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
  browserVersion: 'Chrome/155.0',
  reused: false,
  connectionReused: false,
  browserReused: true,
  launchedPid: 0,
  note: '已连接到正在使用的 Chrome',
};

/**
 * 假浏览器插件上下文：记录 locale/槽位注册，并让 effect 立即执行、可回收。
 *
 * controller 构造时会调 `setInterval`（状态轮询）；测试期间换成假定时器，避免
 * 进程被 interval 挂住。
 *
 * @param {object} [options] - `connectValue`：connect 端点返回的 value（默认方案 B 形状）。
 */
function fakeClientCtx(options = {}) {
  const state = {
    registered: null,
    localeRegistered: null,
    whileServed: null,
    settingsNamespace: null,
    slot: null,
    effects: [],
    rpcCalls: [],
  };
  /** 已注册的词典（namespace -> { zh, en }），供 locale.bind 解析真实文案。 */
  const localeDictionaries = {};
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ value: {} }),
  };
  const ctx = {
    effect: (fn, label) => {
      const result = fn();
      state.effects.push({ label, dispose: typeof result === 'function' ? result : () => {} });
      return () => {
        if (typeof result === 'function') result();
      };
    },
    locale: {
      // 与真实页面一致：先注册词典再绑定；中文优先（断言的是 zh 文案）。
      bind: (namespace) => (key) => {
        const dictionaries = localeDictionaries[namespace];
        const value = dictionaries && dictionaries.zh ? dictionaries.zh[key] : undefined;
        return typeof value === 'string' ? value : `${namespace}.${key}`;
      },
      register: (namespace, dictionaries) => {
        localeDictionaries[namespace] = dictionaries;
        state.localeRegistered = { namespace, dictionaries };
        return () => {};
      },
    },
    configForms: {
      get: (namespace) => {
        state.settingsNamespace = namespace;
        return scope;
      },
      whileServed: (namespaces, callback) => {
        state.whileServed = namespaces;
        return callback();
      },
    },
    slots: {
      inject: (name, callback) => {
        state.slot = name;
        return callback();
      },
      register: (specification, component) => {
        state.registered = { specification, component };
        return () => {};
      },
    },
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          // 记录 payload：0.1.7 起「测试连接 / 应用并连接」必须显式带上表单选中的方案。
          // payload 由 vm 里的 client.js 创建（跨 realm），转成本 realm 的普通对象再比较。
          state.rpcCalls.push([channel, endpoint, payload === undefined ? undefined : JSON.parse(JSON.stringify(payload))]);
          if (endpoint === 'connect') return { ok: true, value: options.connectValue ?? DEFAULT_CONNECT_VALUE };
          return {
            ok: true,
            value:
              endpoint === 'probe'
                ? { currentScheme: 'auto-connect', schemes: [] }
                : { connected: false, scheme: 'auto-connect', configScheme: 'auto-connect' },
          };
        },
      },
    },
  };
  return { ctx, state };
}

/** 等一轮微任务/定时器，让 controller 构造期发起的 RPC 结算。 */
function flush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

test('apply 在假 ctx 上跑通，并把设置页注册到 plugins.item（id = 设置命名空间）', async () => {
  const { module } = instantiateBundle();
  const { ctx, state } = fakeClientCtx();
  assert.doesNotThrow(() => module.apply(ctx));
  await flush();

  // 词典注册在自己的命名空间上，中英双语齐全。
  assert.equal(state.localeRegistered.namespace, module.NS);
  assert.equal(typeof state.localeRegistered.dictionaries.zh, 'object');
  assert.equal(typeof state.localeRegistered.dictionaries.en, 'object');

  // 命名空间守卫用的是行 id（数组由 vm realm 创建，逐项比较而不是 deepStrictEqual）。
  assert.equal(state.whileServed.length, 1);
  assert.equal(state.whileServed[0], SETTINGS_NS);
  assert.equal(state.settingsNamespace, SETTINGS_NS);
  assert.equal(state.slot, 'plugins.item');
  assert.ok(state.registered, '设置页必须注册到 plugins.item 槽位');
  const { specification, component } = state.registered;
  assert.equal(specification.name, 'plugins.item');
  assert.equal(specification.id, SETTINGS_NS, '槽位 id 必须等于设置命名空间');
  assert.equal(typeof specification.order, 'number');
  assert.equal(specification.locale, module.NS);
  assert.equal(typeof component, 'function');
  // locale.bind 在假 ctx 里解析真实词典：label 就是中文标题（不是 `ns.key` 占位）。
  assert.equal(specification.label(), 'Chrome 浏览器');

  // 注入给页面的面孔：一个 hook store + 表单动作 + 四个 RPC 动作 + 方案探测刷新。
  const injected = specification.inject();
  assert.ok(injected.hooks && injected.hooks.chromeDevtools, '必须注入 useChromeDevtools 背后的 store');
  for (const action of ['save', 'test', 'apply', 'disconnect', 'openPage', 'refreshProbe', 'edit', 'resetField']) {
    assert.equal(typeof injected[action], 'function', `注入的面孔缺少 ${action}`);
  }

  // 构造期发起过 status 与 probe 两个 RPC，通道、端点与空 payload 正确。
  assert.deepEqual(state.rpcCalls[0], [RPC_CHANNEL, 'status', {}]);
  assert.deepEqual(state.rpcCalls[1], [RPC_CHANNEL, 'probe', {}]);

  // 回收 effect（controller.dispose 会清掉假 interval 与订阅）。
  for (const effect of state.effects.reverse()) effect.dispose();
});

// ─── 连接摘要文案与 RPC payload（0.1.7 修复） ────────────────

/** 方案 A 启动的浏览器：RPC connect 返回值的默认形状。 */
function launchConnectValue(overrides = {}) {
  return {
    connected: true,
    scheme: 'launch',
    schemeLabel: '方案 A：启动全新浏览器',
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
    browserVersion: 'Chrome/155.0',
    reused: false,
    connectionReused: false,
    browserReused: false,
    launchedPid: 1001,
    note: '已启动新的 Chrome（pid 1001）',
    ...overrides,
  };
}

/**
 * 跑一次「测试连接 / 应用并连接」，返回结果文案、RPC 调用记录与页面快照。
 *
 * apply/test 都是 async：内部先 save 再调 RPC，`await` 之后还要 flush 一轮，
 * 让 finally 里的状态轮询 / 方案探测结算，再从注入的 store 读快照。
 *
 * @param {'test' | 'apply'} action - 动作名。
 * @param {object} [options] - `fieldText`（表单暂存文本）与 `connectValue`（connect 返回值）。
 * @returns {Promise<{ text: string, snapshot: object, state: object }>}
 */
async function runConnectAction(action, options = {}) {
  const { module } = instantiateBundle({ fieldText: options.fieldText });
  const { ctx, state } = fakeClientCtx({ connectValue: options.connectValue });
  module.apply(ctx);
  await flush();
  const injected = state.registered.specification.inject();
  await injected[action]();
  await flush();
  const snapshot = injected.hooks.chromeDevtools.get();
  for (const effect of state.effects.reverse()) effect.dispose();
  return { text: snapshot && snapshot.message ? snapshot.message.text : '', snapshot, state };
}

test('连接摘要：方案 A 复用已建立的连接时显示方案标签与「复用已建立的连接」，不出现「复用已有浏览器」', async () => {
  const connectValue = launchConnectValue({
    reused: true,
    connectionReused: true,
    launchedPid: 1001,
    note: '复用已建立的连接（方案 A：启动全新浏览器）',
  });
  for (const [action, prefix] of [
    ['test', '连接成功'],
    ['apply', '已应用并连接'],
  ]) {
    const { text } = await runConnectAction(action, { fieldText: { scheme: 'launch' }, connectValue });
    assert.ok(text.startsWith(`${prefix}：`), `${action}：摘要前缀应为「${prefix}：」，实际：${text}`);
    assert.ok(text.includes('方案 A：启动全新浏览器'), `${action}：摘要必须含实际方案标签，实际：${text}`);
    assert.ok(text.includes('复用已建立的连接'), `${action}：摘要应说明复用已建立的连接，实际：${text}`);
    assert.equal(text.includes('复用已有浏览器'), false, `${action}：不得再出现方案 B 的措辞，实际：${text}`);
    assert.equal(
      text.includes('复用你正在用的浏览器'),
      false,
      `${action}：不得把「复用连接」渲染成「复用浏览器」，实际：${text}`,
    );
  }
});

test('连接摘要：方案 A 新启动浏览器时显示「启动新浏览器」与 PID', async () => {
  const { text } = await runConnectAction('apply', {
    fieldText: { scheme: 'launch' },
    connectValue: launchConnectValue(),
  });
  assert.ok(text.includes('方案 A：启动全新浏览器'), `摘要必须含实际方案标签，实际：${text}`);
  assert.ok(text.includes('启动新浏览器'), `摘要应说明新启动，实际：${text}`);
  assert.ok(text.includes('PID 1001'), `摘要应带 PID，实际：${text}`);
  assert.equal(text.includes('复用已建立的连接'), false, `新启动不是复用连接，实际：${text}`);
  assert.equal(text.includes('复用你正在用的浏览器'), false, `新启动不是复用浏览器，实际：${text}`);
});

test('连接摘要：方案 B 连用户正在用的浏览器时显示「复用你正在用的浏览器」', async () => {
  const { text } = await runConnectAction('apply', {
    fieldText: { scheme: 'auto-connect' },
    connectValue: {
      connected: true,
      scheme: 'auto-connect',
      schemeLabel: '方案 B：复用当前浏览器（autoConnect）',
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
      browserVersion: 'Chrome/155.0',
      reused: false,
      connectionReused: false,
      browserReused: true,
      launchedPid: 0,
      note: '已连接到正在使用的 Chrome',
    },
  });
  assert.ok(text.includes('方案 B：复用当前浏览器（autoConnect）'), `摘要必须含实际方案标签，实际：${text}`);
  assert.ok(text.includes('复用你正在用的浏览器'), `摘要应说明复用浏览器，实际：${text}`);
  assert.equal(text.includes('复用已建立的连接'), false, `这不是复用连接，实际：${text}`);
  assert.equal(text.includes('复用已有浏览器'), false, `旧措辞不应再出现，实际：${text}`);
});

test('连接摘要：方案 C/D 连外部 Chrome 时不冒充「复用你正在用的浏览器」', async () => {
  for (const [scheme, label] of [
    ['browser-url', '方案 C：连接调试端口（browser-url）'],
    ['ws-endpoint', '方案 D：WebSocket 直连（wsEndpoint）'],
  ]) {
    const { text } = await runConnectAction('apply', {
      fieldText: { scheme },
      connectValue: {
        connected: true,
        scheme,
        schemeLabel: label,
        wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
        browserVersion: 'Chrome/155.0',
        reused: false,
        connectionReused: false,
        browserReused: true,
        launchedPid: 0,
        note: '已连接到外部 Chrome',
      },
    });
    assert.ok(text.includes(label), `${scheme}：摘要必须含实际方案标签，实际：${text}`);
    assert.ok(text.includes('已连接到外部 Chrome'), `${scheme}：应说明连的是外部 Chrome，实际：${text}`);
    assert.equal(
      text.includes('复用你正在用的浏览器'),
      false,
      `${scheme}：C/D 不一定是用户日常浏览器，不得说「复用你正在用的浏览器」，实际：${text}`,
    );
  }
});

test('连接摘要：RPC 值缺 schemeLabel 时用客户端词典按 scheme id 补方案标签', async () => {
  const { text } = await runConnectAction('test', {
    fieldText: { scheme: 'launch' },
    connectValue: launchConnectValue({ schemeLabel: undefined }),
  });
  assert.ok(text.includes('方案 A：启动全新浏览器'), `摘要必须含实际方案标签，实际：${text}`);
});

test('应用并连接 / 测试连接：RPC payload 显式携带表单选中的方案 id', async () => {
  const applied = await runConnectAction('apply', {
    fieldText: { scheme: 'launch' },
    connectValue: launchConnectValue(),
  });
  const appliedConnect = applied.state.rpcCalls.filter((call) => call[1] === 'connect');
  assert.equal(appliedConnect.length, 1, '一次动作只应调用一次 connect');
  assert.deepEqual(appliedConnect[0], [RPC_CHANNEL, 'connect', { scheme: 'launch' }]);

  const tested = await runConnectAction('test', {
    fieldText: { scheme: 'auto-connect' },
    connectValue: launchConnectValue(),
  });
  const testedConnect = tested.state.rpcCalls.filter((call) => call[1] === 'connect');
  assert.deepEqual(testedConnect[0], [RPC_CHANNEL, 'connect', { scheme: 'auto-connect' }]);

  // 表单文本不是合法方案 id（或只有空白）时不传，交给 Host 用已保存配置兜底。
  for (const schemeText of ['not-a-scheme', '   ']) {
    const fallback = await runConnectAction('test', {
      fieldText: { scheme: schemeText },
      connectValue: launchConnectValue(),
    });
    const fallbackConnect = fallback.state.rpcCalls.filter((call) => call[1] === 'connect');
    assert.deepEqual(
      fallbackConnect[0],
      [RPC_CHANNEL, 'connect', {}],
      `表单文本 ${JSON.stringify(schemeText)} 不应被当成方案传给 Host`,
    );
  }
});

// ─── 词典与 locale JSON ────────────────────────────────────

/** 从 apply 捕获的内嵌词典（zh / en）。 */
async function captureDictionaries() {
  const { module } = instantiateBundle();
  const { ctx, state } = fakeClientCtx();
  module.apply(ctx);
  await flush();
  for (const effect of state.effects.reverse()) effect.dispose();
  return state.localeRegistered.dictionaries;
}

test('页面内嵌的中英词典 key 完全对齐，且没有空文案', async () => {
  const dictionaries = await captureDictionaries();
  const zhKeys = Object.keys(dictionaries.zh).sort();
  const enKeys = Object.keys(dictionaries.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  assert.ok(zhKeys.length > 40, `词典 key 太少（${zhKeys.length}），页面文案可能缺失`);
  for (const key of zhKeys) {
    assert.equal(typeof dictionaries.zh[key], 'string', `zh.${key} 必须是字符串`);
    assert.equal(typeof dictionaries.en[key], 'string', `en.${key} 必须是字符串`);
    assert.ok(dictionaries.zh[key].trim().length > 0, `zh.${key} 不能为空`);
    assert.ok(dictionaries.en[key].trim().length > 0, `en.${key} 不能为空`);
  }
  for (const key of ['title', 'description', 'scheme', 'test', 'apply', 'disconnect', 'statusTitle', 'probeTitle']) {
    assert.ok(zhKeys.includes(key), `词典缺少 ${key}`);
  }
});

test('locale/*.json 合法，meta 与 settings 四段文案齐全', () => {
  for (const [language, file] of [
    ['zh', 'zh.json'],
    ['en', 'en.json'],
  ]) {
    const raw = readFileSync(path.join(packageRoot, 'locale', file), 'utf8');
    const json = JSON.parse(raw);
    assert.equal(typeof json.meta, 'object', `${file} 缺少 meta`);
    assert.equal(typeof json.meta.title, 'string');
    assert.equal(typeof json.meta.description, 'string');
    assert.ok(json.meta.title.trim().length > 0, `${file} meta.title 为空`);
    assert.ok(json.meta.description.trim().length > 0, `${file} meta.description 为空`);
    assert.equal(typeof json.settings, 'object', `${file} 缺少 settings`);
    assert.equal(typeof json.settings.title, 'string');
    assert.equal(typeof json.settings.description, 'string');
    assert.ok(json.settings.title.trim().length > 0, `${file} settings.title 为空`);
    assert.ok(json.settings.description.trim().length > 0, `${file} settings.description 为空`);
    // 文案里不应出现 emoji（任务要求界面不展示 emoji）。
    assert.equal(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(raw),
      false,
      `${language} 的 locale 文案不能包含 emoji`,
    );
  }
});

test('locale JSON 的标题与页面内嵌词典一致（两处不要各写一套）', async () => {
  const dictionaries = await captureDictionaries();
  for (const [language, file] of [
    ['zh', 'zh.json'],
    ['en', 'en.json'],
  ]) {
    const json = JSON.parse(readFileSync(path.join(packageRoot, 'locale', file), 'utf8'));
    assert.equal(json.settings.title, dictionaries[language].title);
    assert.equal(json.settings.description, dictionaries[language].description);
  }
});

test('连接摘要词典：reusedConnection / reusedBrowser 的中英文案与连接复用语义修复一致', async () => {
  const dictionaries = await captureDictionaries();
  assert.equal(dictionaries.zh.reusedConnection, '复用已建立的连接');
  assert.equal(dictionaries.zh.reusedBrowser, '复用你正在用的浏览器');
  assert.equal(
    dictionaries.zh.reusedBrowser.includes('已有'),
    false,
    'reusedBrowser 不应再写成「复用已有浏览器」（方案 B 的旧措辞）',
  );
  for (const language of ['zh', 'en']) {
    for (const key of ['reusedConnection', 'reusedBrowser', 'externalBrowser', 'launchedBrowser', 'versionLabel', 'summaryJoin', 'summarySeparator']) {
      assert.equal(typeof dictionaries[language][key], 'string', `${language}.${key} 必须是字符串`);
      assert.ok(dictionaries[language][key].trim().length > 0, `${language}.${key} 不能为空`);
    }
  }
  assert.notEqual(dictionaries.en.reusedConnection, dictionaries.zh.reusedConnection, 'en 文案不应是中文');
  assert.notEqual(dictionaries.en.reusedBrowser, dictionaries.zh.reusedBrowser, 'en 文案不应是中文');
});
