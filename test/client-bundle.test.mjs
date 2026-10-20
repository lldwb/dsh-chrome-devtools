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
function fakePrimitives() {
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
      return { text: '', overridden: false, invalid: false };
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
 * @returns {{ module: object, requested: string[] }}
 */
function instantiateBundle() {
  const { definition } = loadBundleDefinition();
  const requested = [];
  const module = definition.factory((specifier) => {
    requested.push(specifier);
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives();
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
 * 假浏览器插件上下文：记录 locale/槽位注册，并让 effect 立即执行、可回收。
 *
 * controller 构造时会调 `setInterval`（状态轮询）；测试期间换成假定时器，避免
 * 进程被 interval 挂住。
 */
function fakeClientCtx() {
  const state = {
    registered: null,
    localeRegistered: null,
    whileServed: null,
    settingsNamespace: null,
    slot: null,
    effects: [],
    rpcCalls: [],
  };
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
      bind: (namespace) => (key) => `${namespace}.${key}`,
      register: (namespace, dictionaries) => {
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
        call: async (channel, endpoint) => {
          state.rpcCalls.push([channel, endpoint]);
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
  assert.equal(specification.label(), `${module.NS}.title`);

  // 注入给页面的面孔：一个 hook store + 表单动作 + 四个 RPC 动作 + 方案探测刷新。
  const injected = specification.inject();
  assert.ok(injected.hooks && injected.hooks.chromeDevtools, '必须注入 useChromeDevtools 背后的 store');
  for (const action of ['save', 'test', 'apply', 'disconnect', 'openPage', 'refreshProbe', 'edit', 'resetField']) {
    assert.equal(typeof injected[action], 'function', `注入的面孔缺少 ${action}`);
  }

  // 构造期发起过 status 与 probe 两个 RPC，通道与端点正确。
  assert.deepEqual(state.rpcCalls[0], [RPC_CHANNEL, 'status']);
  assert.deepEqual(state.rpcCalls[1], [RPC_CHANNEL, 'probe']);

  // 回收 effect（controller.dispose 会清掉假 interval 与订阅）。
  for (const effect of state.effects.reverse()) effect.dispose();
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
