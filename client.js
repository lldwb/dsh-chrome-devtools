/**
 * `dsh-chrome-devtools` —— 浏览器半（设置页）。
 *
 * 手写 bundle，形态与内置设置页一致：`window.__ModuleLoader__.load({ id, factory })`
 * 配一个惰性 CJS 工厂。DSH 的模块清单会根据本包的 `dsh.client` 声明发现它，并在
 * `/plugins/dsh-chrome-devtools/client.js` 上提供它。
 *
 * 本页编辑的是 `chrome-devtools` 设置命名空间（= Loader 行 id，见
 * `cordis.patch.yml`），也就是 Host 半 `lib/config.mjs` 的 `Config`。只有当 Host
 * 提供该命名空间（Loader 行存在）时页面才会挂载，因此没有装这个插件的 profile
 * 看不到任何痕迹。
 *
 * 这里的 `require` 只解析两个说明符 —— `react/jsx-runtime` 与
 * `@deepseek-ai/dsh-client-ui-primitives` —— 二者都是 shell 自身模块表中的静态
 * 模块。也就是说本页不能直接 `require('react')`：所有本地状态（动作进行中、RPC
 * 结果、状态轮询快照、方案探测结果）都放进 controller 的 snapshot store，由槽位
 * 注入的 `useChromeDevtools` hook 推送重渲染。轮询 interval 与各类订阅都由
 * controller 的 `dispose()` 在插件卸载时统一清理。
 *
 * RPC 走 Host 半在 `/dsh-chrome-devtools` 上注册的 prefix 路由：`status` / `probe`
 * / `connect` / `disconnect` / `openBrowserPage`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-devtools',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react_jsx_runtime = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // #region locales
    /** 英文文案。 */
    const en = {
      title: 'Chrome browser',
      description:
        'Choose how the plugin connects to Chrome, configure the debugging endpoint and launch options, test the connection, and inspect the status.',
      sectionScheme: 'Connection scheme',
      sectionTools: 'Tools and timeouts',
      scheme: 'Connection scheme',
      schemeHint: 'Pick how the plugin reaches Chrome. Scheme B reuses the browser you are using now and keeps cookies and logins.',
      schemeLaunch: 'Scheme A: launch a new browser',
      schemeLaunchHint: 'The plugin starts its own Chrome with an isolated profile and never touches the browser you are using.',
      schemeAutoConnect: 'Scheme B: reuse the current browser (autoConnect)',
      schemeAutoConnectHint:
        'Reuse the Chrome you already have open, keeping logins and tabs. Needs Chrome 144+ with remote debugging allowed at chrome://inspect/#remote-debugging.',
      schemeBrowserUrl: 'Scheme C: connect to a debugging port (browser-url)',
      schemeBrowserUrlHint: 'Connect to a Chrome that was started manually with --remote-debugging-port.',
      schemeWsEndpoint: 'Scheme D: direct WebSocket endpoint (wsEndpoint)',
      schemeWsEndpointHint: 'Connect straight to a given WebSocket endpoint; useful for remote or containerised Chrome.',
      executablePath: 'Chrome executable path',
      executablePathHint: 'Leave blank to detect it from the platform and channel.',
      executablePathPlaceholder: 'Detected automatically',
      channel: 'Chrome channel',
      channelHint: 'Used when detecting the executable and the default profile directory.',
      channelStable: 'Stable',
      channelBeta: 'Beta',
      channelDev: 'Dev',
      channelCanary: 'Canary',
      headless: 'Headless mode',
      headlessHint: 'Run without a visible browser window.',
      isolated: 'Temporary profile',
      isolatedHint: 'Use a throwaway profile that is deleted on disconnect; turn this off to reuse the user data directory.',
      userDataDir: 'Profile directory',
      userDataDirHint: 'Leave blank to detect it from the channel. Used by scheme A (when not isolated) and scheme B overrides.',
      userDataDirPlaceholder: 'Detected automatically',
      viewport: 'Window size',
      viewportHint: 'Width x height, for example 1280x800.',
      viewportPlaceholder: '1280x800',
      browserUrl: 'Debugging endpoint',
      browserUrlHint: 'Accepts http://127.0.0.1:9222, 127.0.0.1:9222, or just a port number.',
      browserUrlPlaceholder: 'http://127.0.0.1:9222',
      wsEndpoint: 'WebSocket endpoint',
      wsEndpointHint: 'For example ws://127.0.0.1:9222/devtools/browser/<id>. Basic auth can be embedded as user:pass@.',
      wsEndpointPlaceholder: 'ws://127.0.0.1:9222/devtools/browser/…',
      wsHeaders: 'Custom headers',
      wsHeadersHint: 'JSON object string, for example {"Authorization":"Bearer …"}.',
      wsHeadersPlaceholder: '{"Authorization":"Bearer …"}',
      toolset: 'Toolset',
      toolsetHint: 'Slim registers only the five core tools, which helps when context is tight.',
      toolsetFull: 'Full',
      toolsetSlim: 'Slim',
      screenshotDir: 'Screenshot directory',
      screenshotDirHint: 'Leave blank to use $DSH_HOME/chrome-devtools/screenshots.',
      screenshotDirPlaceholder: 'Default directory',
      connectTimeoutMs: 'Connect timeout (ms)',
      connectTimeoutMsHint: 'Longest wait while establishing a connection.',
      actionTimeoutMs: 'Action timeout (ms)',
      actionTimeoutMsHint: 'Longest wait for a single page action.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      save: 'Save configuration',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      statusTitle: 'Status',
      statusConnection: 'Connection',
      statusConnected: 'connected',
      statusDisconnected: 'not connected',
      statusScheme: 'Current scheme',
      statusBrowserVersion: 'Browser version',
      statusWsUrl: 'WebSocket endpoint',
      statusPageCount: 'Pages',
      statusLastError: 'Last error',
      statusUnavailable: 'Connection status unavailable',
      statusConfigMismatch: 'The saved scheme differs from the current connection; press "Apply and connect" to use it.',
      autoConnectGuide: 'Scheme B needs Chrome 144+, and remote debugging must be allowed at chrome://inspect/#remote-debugging.',
      probeTitle: 'Scheme availability',
      probeRefresh: 'Probe again',
      probing: 'Probing…',
      probeAvailable: 'available',
      probeUnavailable: 'unavailable',
      probeUnavailableNote: 'No probe results yet; you can still press "Test connection".',
      probeCurrent: 'current',
      test: 'Test connection',
      testing: 'Connecting…',
      apply: 'Apply and connect',
      applying: 'Applying…',
      disconnect: 'Disconnect',
      disconnecting: 'Disconnecting…',
      openPage: 'Open a new tab',
      openingPage: 'Opening…',
      actionSuccess: 'Done.',
      actionFailed: 'The action failed.',
      saveBlocked: 'The form still has unsaved or invalid fields, so this action was cancelled.',
      testSuccess: 'Connection succeeded',
      applySuccess: 'Applied and connected',
      disconnectSuccess: 'Disconnected',
      closedOwnedBrowser: 'closed the browser this plugin launched',
      openPageSuccess: 'Opened a new tab',
      versionLabel: 'Chrome version',
      reusedBrowser: 'reused an existing browser',
      launchedBrowser: 'launched a new browser',
      summaryJoin: ': ',
      summarySeparator: ', ',
      unknownValue: '—'
    };

    /** 简体中文文案。 */
    const zh = {
      title: 'Chrome 浏览器',
      description: '选择 Chrome 连接方案，配置调试端点与启动参数，测试连接并查看状态。',
      sectionScheme: '连接方案',
      sectionTools: '工具与超时',
      scheme: '连接方案',
      schemeHint: '选择插件如何连接到 Chrome。方案 B 复用你正在用的浏览器，能保留 Cookie 与登录态。',
      schemeLaunch: '方案 A：启动全新浏览器',
      schemeLaunchHint: '插件自己启动一个全新的 Chrome（独立 profile），不碰你正在用的浏览器。',
      schemeAutoConnect: '方案 B：复用当前浏览器（autoConnect）',
      schemeAutoConnectHint:
        '直接复用你当前打开的 Chrome，保留登录态与标签页；需要 Chrome 144+ 并在 chrome://inspect/#remote-debugging 里允许远程调试。',
      schemeBrowserUrl: '方案 C：连接调试端口（browser-url）',
      schemeBrowserUrlHint: '连接一个已手动带 --remote-debugging-port 启动的 Chrome。',
      schemeWsEndpoint: '方案 D：WebSocket 直连（wsEndpoint）',
      schemeWsEndpointHint: '直接连接给定的 WebSocket 端点，适合远程或容器里的 Chrome。',
      executablePath: 'Chrome 可执行文件路径',
      executablePathHint: '留空表示按平台与渠道自动探测。',
      executablePathPlaceholder: '留空自动探测',
      channel: 'Chrome 渠道',
      channelHint: '自动探测可执行文件与用户 profile 目录时使用。',
      channelStable: '稳定版',
      channelBeta: 'Beta',
      channelDev: 'Dev',
      channelCanary: 'Canary',
      headless: '无头模式',
      headlessHint: '开启后不显示浏览器窗口。',
      isolated: '临时 profile',
      isolatedHint: '开启后使用临时 profile，断开时删除；关闭则复用 profile 目录。',
      userDataDir: 'Profile 目录',
      userDataDirHint: '留空表示按渠道自动探测；方案 A 在关闭「临时 profile」时使用它，方案 B 也用它覆盖默认目录。',
      userDataDirPlaceholder: '留空自动探测',
      viewport: '窗口尺寸',
      viewportHint: '形如 1280x800。',
      viewportPlaceholder: '1280x800',
      browserUrl: '调试端点',
      browserUrlHint: '可填 http://127.0.0.1:9222、127.0.0.1:9222 或只填端口。',
      browserUrlPlaceholder: 'http://127.0.0.1:9222',
      wsEndpoint: 'WebSocket 端点',
      wsEndpointHint: '形如 ws://127.0.0.1:9222/devtools/browser/<id>；可用 user:pass@ 内嵌 Basic 认证。',
      wsEndpointPlaceholder: 'ws://127.0.0.1:9222/devtools/browser/…',
      wsHeaders: '自定义请求头',
      wsHeadersHint: 'JSON 对象字符串，例如 {"Authorization":"Bearer …"}。',
      wsHeadersPlaceholder: '{"Authorization":"Bearer …"}',
      toolset: '工具集',
      toolsetHint: 'slim 只注册 5 个核心工具，适合上下文紧张的模型。',
      toolsetFull: '完整（full）',
      toolsetSlim: '精简（slim）',
      screenshotDir: '截图目录',
      screenshotDirHint: '留空表示 $DSH_HOME/chrome-devtools/screenshots。',
      screenshotDirPlaceholder: '留空使用默认目录',
      connectTimeoutMs: '连接超时（毫秒）',
      connectTimeoutMsHint: '建立连接的最长等待时间。',
      actionTimeoutMs: '动作超时（毫秒）',
      actionTimeoutMsHint: '单个页面动作的最长等待时间。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值。',
      save: '保存配置',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      statusTitle: '状态',
      statusConnection: '连接',
      statusConnected: '已连接',
      statusDisconnected: '未连接',
      statusScheme: '当前方案',
      statusBrowserVersion: '浏览器版本',
      statusWsUrl: 'WebSocket 端点',
      statusPageCount: '页面数',
      statusLastError: '最近错误',
      statusUnavailable: '无法读取连接状态',
      statusConfigMismatch: '配置里的方案与当前连接不同，点「应用并连接」生效。',
      autoConnectGuide: '方案 B 需要 Chrome 144+，并在 chrome://inspect/#remote-debugging 里允许远程调试。',
      probeTitle: '方案探测',
      probeRefresh: '重新探测',
      probing: '探测中…',
      probeAvailable: '可用',
      probeUnavailable: '不可用',
      probeUnavailableNote: '取不到探测结果，可直接点「测试连接」尝试。',
      probeCurrent: '当前',
      test: '测试连接',
      testing: '连接中…',
      apply: '应用并连接',
      applying: '应用中…',
      disconnect: '断开连接',
      disconnecting: '断开中…',
      openPage: '打开新标签页',
      openingPage: '打开中…',
      actionSuccess: '完成。',
      actionFailed: '操作失败。',
      saveBlocked: '表单还有未保存或无效的字段，已取消本次操作。',
      testSuccess: '连接成功',
      applySuccess: '已应用并连接',
      disconnectSuccess: '已断开连接',
      closedOwnedBrowser: '已关闭本插件启动的浏览器',
      openPageSuccess: '已打开新标签页',
      versionLabel: 'Chrome 版本',
      reusedBrowser: '复用已有浏览器',
      launchedBrowser: '启动新浏览器',
      summaryJoin: '：',
      summarySeparator: '，',
      unknownValue: '—'
    };
    // #endregion

    /** 本插件拥有的词典命名空间（仅设置页正文，用于 plugins.item 槽位的 locale）。 */
    const NS = 'settings.chromeDevtools';

    /**
     * 本页面所编辑的 Host 设置命名空间。写死而不是导入：客户端包不能依赖 Host 包。
     * 它等于 Loader 行 id，也就是 Host 半 `lib/config.mjs` 所属行的 id。
     */
    const SETTINGS_NS = 'chrome-devtools';

    /** Host 半注册的 RPC 通道。 */
    const RPC_CHANNEL = '/dsh-chrome-devtools';

    /** 状态轮询间隔（毫秒）。status 很轻（只读 manager 内存状态），可以密一点。 */
    const STATUS_POLL_MS = 3000;

    /** 保存回退路径：最长等待与轮询间隔（毫秒）。 */
    const SAVE_WAIT_MS = 5000;
    const SAVE_POLL_MS = 50;

    /** 主色：与官方设置页一致的橙色主按钮。 */
    const COLOR_PRIMARY = '#ff5a1f';

    /** 失败与成功的结果色。 */
    const COLOR_ERROR = '#d92d20';
    const COLOR_SUCCESS = '#12805c';

    /** 自定义字段行与内置字段行共用的分隔线。 */
    const SEPARATOR = '0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))';

    /** 一个字段行的基础布局（与内置字段一致）。 */
    const FIELD_BASE_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '12px 0'
    };

    /** 字段行标题行。 */
    const HEAD_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' };

    /** 字段标签。 */
    const LABEL_STYLE = {
      flex: '1 1 auto',
      minWidth: 0,
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-primary, inherit)'
    };

    /** 字段提示文字。 */
    const HINT_STYLE = {
      margin: 0,
      fontSize: '12px',
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-tertiary, inherit)'
    };

    /** 控件行。 */
    const CONTROL_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '12px' };

    /** 灰色圆角面板：把整组字段包起来。 */
    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      margin: '8px 0 4px',
      padding: '2px 20px',
      background: 'rgba(128, 128, 128, 0.09)',
      borderRadius: '12px'
    };

    /** 区块（状态 / 探测 / 动作）的外框样式。 */
    const SECTION_STYLE = { padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '6px' };

    /** 区块标题。 */
    const SECTION_TITLE_STYLE = {
      margin: '10px 0 2px',
      fontSize: '13px',
      fontWeight: 600,
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-primary, inherit)'
    };

    /** 信息行（状态区里的一「标签 + 值」）。 */
    const INFO_ROW_STYLE = { display: 'flex', gap: '8px', fontSize: '12px', lineHeight: 1.6, minWidth: 0 };

    /** 动作按钮行的布局。 */
    const BUTTON_ROW_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' };

    /** 方案探测列表里的一行。 */
    const PROBE_ROW_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px', fontSize: '12px', lineHeight: 1.6 };

    /**
     * 四个连接方案（客户端重复一份：浏览器半不能 import Host 包）。
     * 顺序与 `lib/config.mjs` 的 `SCHEME_OPTIONS`、`lib/schemes.mjs` 的 `SCHEMES` 一致。
     */
    const SCHEMES = [
      { id: 'launch', labelKey: 'schemeLaunch', hintKey: 'schemeLaunchHint' },
      { id: 'auto-connect', labelKey: 'schemeAutoConnect', hintKey: 'schemeAutoConnectHint' },
      { id: 'browser-url', labelKey: 'schemeBrowserUrl', hintKey: 'schemeBrowserUrlHint' },
      { id: 'ws-endpoint', labelKey: 'schemeWsEndpoint', hintKey: 'schemeWsEndpointHint' }
    ];

    /** Chrome 渠道下拉选项。 */
    const CHANNELS = [
      { id: 'stable', labelKey: 'channelStable' },
      { id: 'beta', labelKey: 'channelBeta' },
      { id: 'dev', labelKey: 'channelDev' },
      { id: 'canary', labelKey: 'channelCanary' }
    ];

    /** 工具集下拉选项。 */
    const TOOLSETS = [
      { id: 'full', labelKey: 'toolsetFull' },
      { id: 'slim', labelKey: 'toolsetSlim' }
    ];

    /**
     * {@link P.SettingsFormModel} 用的一种布尔字段类型。
     *
     * 内置的字段类型只有文本和数字；开关需要自己的类型，但契约很小 —— `format` 把
     * 存储值渲染成暂存文本，`parse` 把暂存文本变回一次写入。
     *
     * @param field - 配置字段名。
     * @returns 字段规格。
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text === 'true' })
      };
    }

    /**
     * 数字字段的兜底实现（内置 `settingsNumberField` 缺失时使用，保证本页可加载）。
     *
     * @param field - 配置字段名。
     * @returns 字段规格。
     */
    function settingsNumberTextField(field) {
      return {
        field,
        format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
        parse: (text) => {
          const trimmed = String(text ?? '').trim();
          if (trimmed === '') return { kind: 'clear' };
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) return undefined;
          return { kind: 'set', value: parsed };
        }
      };
    }

    /** 共享设置表单所渲染的标签。 */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving')
      };
    }

    /** 任意抛出值的展示文案。 */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      if (error && typeof error.message === 'string') return error.message;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }

    /**
     * RPC 失败信封 → 展示文案。
     *
     * Host 的失败形状是 `{ ok: false, error: { code, message, details } }`；这里把
     * `message` 作为主体显示，`code` 存在时作为前缀帮助定位。
     */
    function describeRpcError(error) {
      const code = error && typeof error.code === 'string' ? error.code : '';
      const message = error && typeof error.message === 'string' ? error.message : '';
      if (message !== '' && code !== '') return `${code}${message ? '：' : ''}${message}`;
      if (message !== '') return message;
      if (code !== '') return code;
      return '';
    }

    /**
     * 把 WS URL 里内嵌的凭据打码（Host 侧已经打过一次，这里再兜一次底）。
     *
     * @param url - 原始 URL。
     * @returns 打码后的 URL。
     */
    function maskUrl(url) {
      if (typeof url !== 'string' || url.length === 0) return '';
      return url.replace(/\/\/[^/@\s]+@/u, '//***@');
    }

    /** 下拉框样式：模仿内置字段的输入框。 */
    function selectStyle(disabled) {
      return {
        width: '100%',
        height: '34px',
        padding: '0 12px',
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.06))',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, inherit)',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
    }

    /** 按钮样式：`primary` 为橙色主按钮，其余为描边次要按钮。 */
    function buttonStyle(variant, disabled) {
      const base = {
        height: '34px',
        padding: '0 18px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
      if (variant === 'primary') {
        return { ...base, border: 'none', background: COLOR_PRIMARY, color: '#ffffff' };
      }
      return {
        ...base,
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)'
      };
    }

    /**
     * 一行「标签 + 控件」，垂直布局与内置字段一致。
     */
    function FieldRow(props) {
      const style = { ...FIELD_BASE_STYLE };
      if (props.separator === 'top') style.borderTop = SEPARATOR;
      if (props.separator === 'bottom') style.borderBottom = SEPARATOR;
      return react_jsx_runtime.jsxs('div', {
        style,
        children: [
          react_jsx_runtime.jsx('div', {
            style: HEAD_STYLE,
            children: react_jsx_runtime.jsx('label', {
              htmlFor: props.id,
              style: LABEL_STYLE,
              children: props.label
            })
          }),
          react_jsx_runtime.jsx('div', { style: CONTROL_ROW_STYLE, children: props.control }),
          props.hint ? react_jsx_runtime.jsx('p', { style: HINT_STYLE, children: props.hint }) : null
        ]
      });
    }

    /** 原生下拉行。 */
    function SelectRow(props) {
      return react_jsx_runtime.jsx(FieldRow, {
        id: props.id,
        label: props.label,
        hint: props.hint,
        separator: props.separator,
        control: react_jsx_runtime.jsx('select', {
          id: props.id,
          style: selectStyle(props.disabled),
          value: props.value,
          disabled: props.disabled,
          onChange: (event) => {
            props.onChange(event.target.value);
          },
          children: props.options.map((option) =>
            react_jsx_runtime.jsx('option', { value: option.value, children: option.label }, option.value)
          )
        })
      });
    }

    /**
     * 一个开关行。内置表单没有布尔字段组件，因此围绕导出的 `Switch` 原语渲染与
     * 文本字段相同的形态 —— 标签、控件、提示。
     */
    function ToggleRow(props) {
      return react_jsx_runtime.jsx(FieldRow, {
        id: props.id,
        label: props.label,
        hint: props.hint,
        separator: props.separator,
        control: react_jsx_runtime.jsx(P.Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: (next) => {
            props.onEdit(next === true);
          }
        })
      });
    }

    /** 状态区里的一行信息。 */
    function InfoRow(props) {
      return react_jsx_runtime.jsxs('div', {
        style: INFO_ROW_STYLE,
        children: [
          react_jsx_runtime.jsxs('span', {
            style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, inherit)' },
            children: [props.label, props.separator]
          }),
          react_jsx_runtime.jsx('span', {
            style: {
              minWidth: 0,
              wordBreak: 'break-all',
              color: props.tone === 'error' ? COLOR_ERROR : props.tone === 'success' ? COLOR_SUCCESS : 'var(--dsw-alias-label-secondary, inherit)'
            },
            children: props.value
          })
        ]
      });
    }

    /**
     * 一个文本字段。
     *
     * @param t - 页面词典读取器。
     * @param state - 页面快照。
     * @param disabled - 是否禁用。
     * @param props - 槽位注入的面孔（`edit` / `resetField`）。
     * @param field - Config 字段名。
     * @param keys - 文案 key：`label` / `hint` / `placeholder`，可带 `numeric`。
     * @returns 字段元素。
     */
    function valueField(t, state, disabled, props, field, keys) {
      return react_jsx_runtime.jsx(
        P.SettingsValueField,
        {
          id: `chrome-devtools-${field}`,
          label: t(keys.label),
          hint: keys.hint === undefined ? undefined : t(keys.hint),
          placeholder: keys.placeholder === undefined ? undefined : t(keys.placeholder),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          numeric: keys.numeric === true,
          disabled,
          ...state[field],
          onEdit: (text) => {
            props.edit(field, text);
          },
          onReset: () => {
            props.resetField(field);
          }
        },
        field
      );
    }

    /**
     * 状态区：连接状态、当前方案、浏览器版本、WS 端点、页面数、最近错误。
     *
     * 数据来自每 3 秒一次的 `status` RPC；Host 还没回答或不可达时显示不可用文案。
     */
    function StatusSection(props) {
      const { t, state } = props;
      const status = state.status;
      const statusError = state.statusError;
      const unknown = t('unknownValue');
      const connected = status !== null && status.connected === true;
      const schemeText =
        status !== null && typeof status.schemeLabel === 'string' && status.schemeLabel !== ''
          ? status.schemeLabel
          : status !== null && typeof status.scheme === 'string' && status.scheme !== ''
            ? status.scheme
            : unknown;
      const mismatch =
        status !== null &&
        typeof status.configScheme === 'string' &&
        typeof status.scheme === 'string' &&
        status.configScheme !== status.scheme;
      // 只有「配置是 auto-connect、当前没连上」时才提示授权路径，避免每条错误都刷屏。
      const guide =
        !connected && status !== null && status.configScheme === 'auto-connect' ? t('autoConnectGuide') : '';

      return react_jsx_runtime.jsxs('div', {
        style: { ...SECTION_STYLE, borderTop: SEPARATOR },
        children: [
          react_jsx_runtime.jsx('p', { style: SECTION_TITLE_STYLE, children: t('statusTitle') }),
          status === null && statusError !== ''
            ? react_jsx_runtime.jsx(InfoRow, {
                label: t('statusUnavailable'),
                value: statusError,
                tone: 'error',
                separator: t('summaryJoin')
              })
            : null,
          react_jsx_runtime.jsx(InfoRow, {
            label: t('statusConnection'),
            value: connected ? t('statusConnected') : t('statusDisconnected'),
            tone: connected ? 'success' : 'error',
            separator: t('summaryJoin')
          }),
          react_jsx_runtime.jsx(InfoRow, { label: t('statusScheme'), value: schemeText, separator: t('summaryJoin') }),
          react_jsx_runtime.jsx(InfoRow, {
            label: t('statusBrowserVersion'),
            value: status !== null && typeof status.browserVersion === 'string' && status.browserVersion !== '' ? status.browserVersion : unknown,
            separator: t('summaryJoin')
          }),
          react_jsx_runtime.jsx(InfoRow, {
            label: t('statusWsUrl'),
            value: status !== null && typeof status.wsUrl === 'string' && status.wsUrl !== '' ? maskUrl(status.wsUrl) : unknown,
            separator: t('summaryJoin')
          }),
          react_jsx_runtime.jsx(InfoRow, {
            label: t('statusPageCount'),
            value:
              status !== null && typeof status.pageCount === 'number' && status.pageCount >= 0
                ? String(status.pageCount)
                : unknown,
            separator: t('summaryJoin')
          }),
          status !== null && typeof status.lastError === 'string' && status.lastError !== ''
            ? react_jsx_runtime.jsx(InfoRow, {
                label: t('statusLastError'),
                value: status.lastError,
                tone: 'error',
                separator: t('summaryJoin')
              })
            : null,
          mismatch
            ? react_jsx_runtime.jsx('p', { style: { ...HINT_STYLE, color: COLOR_ERROR, marginTop: '2px' }, children: t('statusConfigMismatch') })
            : null,
          guide !== ''
            ? react_jsx_runtime.jsx('p', { style: { ...HINT_STYLE, marginTop: '2px' }, children: guide })
            : null
        ]
      });
    }

    /**
     * 方案探测区：四个方案在当前配置下是否可用，附「重新探测」按钮。
     *
     * 探测有真实 IO（读 DevToolsActivePort、探调试端口），所以不跟 status 一起轮询，
     * 只在页面挂载与用户手动刷新时跑一次。
     */
    function ProbeSection(props) {
      const { t, state, onRefresh } = props;
      const probe = state.probe;
      const schemes = probe !== null && Array.isArray(probe.schemes) ? probe.schemes : [];
      const busy = state.probeBusy === true;
      const disabled = busy || state.action !== null || !state.writable;

      return react_jsx_runtime.jsxs('div', {
        style: { ...SECTION_STYLE, borderTop: SEPARATOR },
        children: [
          react_jsx_runtime.jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
            children: [
              react_jsx_runtime.jsx('p', { style: { ...SECTION_TITLE_STYLE, margin: 0, flex: '1 1 auto' }, children: t('probeTitle') }),
              react_jsx_runtime.jsx('button', {
                type: 'button',
                style: buttonStyle('secondary', disabled),
                disabled,
                onClick: onRefresh,
                children: busy ? t('probing') : t('probeRefresh')
              })
            ]
          }),
          schemes.length === 0
            ? react_jsx_runtime.jsx('p', {
                style: HINT_STYLE,
                role: 'status',
                children: state.probeError !== '' ? state.probeError : t('probeUnavailableNote')
              })
            : schemes.map((item) =>
                react_jsx_runtime.jsxs(
                  'div',
                  {
                    style: PROBE_ROW_STYLE,
                    children: [
                      react_jsx_runtime.jsx('span', {
                        style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, inherit)' },
                        children: item.label || item.id
                      }),
                      react_jsx_runtime.jsx('span', {
                        style: {
                          flex: '0 0 auto',
                          fontWeight: 500,
                          color: item.available === true ? COLOR_SUCCESS : COLOR_ERROR
                        },
                        children: item.available === true ? t('probeAvailable') : t('probeUnavailable')
                      }),
                      item.isCurrent === true
                        ? react_jsx_runtime.jsx('span', {
                            style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, inherit)' },
                            children: `(${t('probeCurrent')})`
                          })
                        : null,
                      item.detail
                        ? react_jsx_runtime.jsx('span', {
                            style: {
                              flex: '1 1 100%',
                              minWidth: 0,
                              wordBreak: 'break-all',
                              color: 'var(--dsw-alias-label-tertiary, inherit)'
                            },
                            children: item.detail
                          })
                        : null
                    ]
                  },
                  item.id
                )
              )
        ]
      });
    }

    /**
     * 动作按钮区：测试连接 / 应用并连接、断开连接 / 打开新标签页，以及结果文案。
     *
     * 保存按钮由 `SettingsForm` 自己渲染（footer），其标题来自同一份词典的 `save`
     * 词条，所以这里不再重复一个「保存配置」按钮。
     */
    function ActionSection(props) {
      const { t, state, onTest, onApply, onDisconnect, onOpenPage } = props;
      const disabled = !state.writable || state.saving || state.action !== null;
      const message = state.message;

      return react_jsx_runtime.jsxs('div', {
        style: { ...SECTION_STYLE, borderTop: SEPARATOR },
        children: [
          react_jsx_runtime.jsxs('div', {
            style: BUTTON_ROW_STYLE,
            children: [
              react_jsx_runtime.jsx('button', {
                type: 'button',
                style: buttonStyle('secondary', disabled),
                disabled,
                onClick: onTest,
                children: state.action === 'test' ? t('testing') : t('test')
              }),
              react_jsx_runtime.jsx('button', {
                type: 'button',
                style: buttonStyle('primary', disabled),
                disabled,
                onClick: onApply,
                children: state.action === 'apply' ? t('applying') : t('apply')
              })
            ]
          }),
          react_jsx_runtime.jsxs('div', {
            style: BUTTON_ROW_STYLE,
            children: [
              react_jsx_runtime.jsx('button', {
                type: 'button',
                style: buttonStyle('secondary', disabled),
                disabled,
                onClick: onDisconnect,
                children: state.action === 'disconnect' ? t('disconnecting') : t('disconnect')
              }),
              react_jsx_runtime.jsx('button', {
                type: 'button',
                style: buttonStyle('secondary', disabled),
                disabled,
                onClick: onOpenPage,
                children: state.action === 'openPage' ? t('openingPage') : t('openPage')
              })
            ]
          }),
          message
            ? react_jsx_runtime.jsx('p', {
                style: {
                  margin: 0,
                  fontSize: '12px',
                  lineHeight: 1.5,
                  color: message.tone === 'error' ? COLOR_ERROR : COLOR_SUCCESS
                },
                role: 'status',
                children: message.text
              })
            : null
        ]
      });
    }

    /**
     * 设置页里的 Chrome 浏览器卡片。
     *
     * `props.view === 'summary'` 时插件列表只要一句话说明；详情视图渲染整张表单。
     * 组件本身不持有 hooks 之外的本地状态：动作进度、RPC 结果、状态轮询与方案探测
     * 全部来自 controller 注入的 `useChromeDevtools` store。
     */
    function ChromeDevtoolsCard(props) {
      const { t } = props;
      const state = props.useChromeDevtools((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');

      const disabled = !state.writable || state.saving || state.action !== null;
      const schemeText = state.scheme && typeof state.scheme.text === 'string' ? state.scheme.text : '';
      const scheme = SCHEMES.some((item) => item.id === schemeText) ? schemeText : 'auto-connect';
      const schemeOption = SCHEMES.find((item) => item.id === scheme) ?? SCHEMES[1];

      const rows = [];
      // 方案选择（所有方案共用）
      rows.push(
        react_jsx_runtime.jsx(SelectRow, {
          id: 'chrome-devtools-scheme',
          label: t('scheme'),
          hint: t(schemeOption.hintKey),
          disabled,
          value: scheme,
          options: SCHEMES.map((item) => ({ value: item.id, label: t(item.labelKey) })),
          onChange: (value) => {
            props.edit('scheme', value);
          }
        })
      );

      // 方案相关字段：只渲染当前方案用得到的那些，避免整页 14 个字段糊在一起。
      if (scheme === 'launch') {
        rows.push(
          valueField(t, state, disabled, props, 'executablePath', {
            label: 'executablePath',
            hint: 'executablePathHint',
            placeholder: 'executablePathPlaceholder'
          }),
          react_jsx_runtime.jsx(SelectRow, {
            id: 'chrome-devtools-channel',
            label: t('channel'),
            hint: t('channelHint'),
            disabled,
            value: state.channel && typeof state.channel.text === 'string' && state.channel.text !== '' ? state.channel.text : 'stable',
            options: CHANNELS.map((item) => ({ value: item.id, label: t(item.labelKey) })),
            onChange: (value) => {
              props.edit('channel', value);
            }
          }),
          react_jsx_runtime.jsx(ToggleRow, {
            id: 'chrome-devtools-headless',
            label: t('headless'),
            hint: t('headlessHint'),
            checked: state.headless && state.headless.text !== 'false',
            disabled,
            onEdit: (next) => {
              props.edit('headless', next ? 'true' : 'false');
            }
          }),
          react_jsx_runtime.jsx(ToggleRow, {
            id: 'chrome-devtools-isolated',
            label: t('isolated'),
            hint: t('isolatedHint'),
            checked: !state.isolated || state.isolated.text !== 'false',
            disabled,
            onEdit: (next) => {
              props.edit('isolated', next ? 'true' : 'false');
            }
          }),
          valueField(t, state, disabled, props, 'userDataDir', {
            label: 'userDataDir',
            hint: 'userDataDirHint',
            placeholder: 'userDataDirPlaceholder'
          }),
          valueField(t, state, disabled, props, 'viewport', {
            label: 'viewport',
            hint: 'viewportHint',
            placeholder: 'viewportPlaceholder'
          })
        );
      } else if (scheme === 'auto-connect') {
        rows.push(
          react_jsx_runtime.jsx(SelectRow, {
            id: 'chrome-devtools-channel',
            label: t('channel'),
            hint: t('channelHint'),
            disabled,
            value: state.channel && typeof state.channel.text === 'string' && state.channel.text !== '' ? state.channel.text : 'stable',
            options: CHANNELS.map((item) => ({ value: item.id, label: t(item.labelKey) })),
            onChange: (value) => {
              props.edit('channel', value);
            }
          }),
          valueField(t, state, disabled, props, 'userDataDir', {
            label: 'userDataDir',
            hint: 'userDataDirHint',
            placeholder: 'userDataDirPlaceholder'
          })
        );
      } else if (scheme === 'browser-url') {
        rows.push(
          valueField(t, state, disabled, props, 'browserUrl', {
            label: 'browserUrl',
            hint: 'browserUrlHint',
            placeholder: 'browserUrlPlaceholder'
          })
        );
      } else if (scheme === 'ws-endpoint') {
        rows.push(
          valueField(t, state, disabled, props, 'wsEndpoint', {
            label: 'wsEndpoint',
            hint: 'wsEndpointHint',
            placeholder: 'wsEndpointPlaceholder'
          }),
          valueField(t, state, disabled, props, 'wsHeaders', {
            label: 'wsHeaders',
            hint: 'wsHeadersHint',
            placeholder: 'wsHeadersPlaceholder'
          })
        );
      }

      return react_jsx_runtime.jsx(P.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: react_jsx_runtime.jsxs('div', {
          style: PANEL_STYLE,
          children: [
            react_jsx_runtime.jsx('p', { style: SECTION_TITLE_STYLE, children: t('sectionScheme') }),
            rows,
            react_jsx_runtime.jsx('p', { style: { ...SECTION_TITLE_STYLE, borderTop: SEPARATOR, paddingTop: '12px' }, children: t('sectionTools') }),
            react_jsx_runtime.jsx(SelectRow, {
              id: 'chrome-devtools-toolset',
              label: t('toolset'),
              hint: t('toolsetHint'),
              disabled,
              value: state.toolset && typeof state.toolset.text === 'string' && state.toolset.text !== '' ? state.toolset.text : 'full',
              options: TOOLSETS.map((item) => ({ value: item.id, label: t(item.labelKey) })),
              onChange: (value) => {
                props.edit('toolset', value);
              }
            }),
            valueField(t, state, disabled, props, 'screenshotDir', {
              label: 'screenshotDir',
              hint: 'screenshotDirHint',
              placeholder: 'screenshotDirPlaceholder'
            }),
            valueField(t, state, disabled, props, 'connectTimeoutMs', {
              label: 'connectTimeoutMs',
              hint: 'connectTimeoutMsHint',
              numeric: true
            }),
            valueField(t, state, disabled, props, 'actionTimeoutMs', {
              label: 'actionTimeoutMs',
              hint: 'actionTimeoutMsHint',
              numeric: true
            }),
            react_jsx_runtime.jsx(StatusSection, { t, state }),
            react_jsx_runtime.jsx(ProbeSection, { t, state, onRefresh: props.refreshProbe }),
            react_jsx_runtime.jsx(ActionSection, {
              t,
              state,
              onTest: props.test,
              onApply: props.apply,
              onDisconnect: props.disconnect,
              onOpenPage: props.openPage
            })
          ]
        })
      });
    }

    /**
     * 把设置作用域与 Host RPC 桥接到页面上。
     *
     * 页面显示的全部内容由这里的一块 snapshot store 发布：表单字段的暂存状态来自
     * {@link P.SettingsFormModel}，其余（动作进度、结果文案、status 轮询快照、方案
     * 探测结果）都是本类的字段。页面组件不持有 hooks，因此每 3 秒的轮询与各类订阅
     * 都由 {@link ChromeDevtoolsCardController#dispose} 在插件卸载时清理。
     */
    class ChromeDevtoolsCardController {
      /**
       * @param scope - `chrome-devtools` 设置命名空间已绑定的设置作用域。
       * @param ctx - 页面插件的上下文（`connection.rpc`）。
       * @param t - 本页词典读取器。
       */
      constructor(scope, ctx, t) {
        this.scope = scope;
        this.ctx = ctx;
        this.t = t;
        this.action = null;
        this.message = null;
        this.status = null;
        this.statusError = '';
        this.statusSerialized = '';
        this.statusPolling = false;
        this.probe = null;
        this.probeError = '';
        this.probeBusy = false;
        this.disposed = false;
        this.timer = undefined;

        // 数字字段优先用内置种类；内置缺失时退到本页的等价实现，保证整页可加载。
        const numberField =
          typeof P.settingsNumberField === 'function' ? P.settingsNumberField : settingsNumberTextField;
        this.form = new P.SettingsFormModel(
          scope,
          [
            P.settingsTextField('scheme'),
            P.settingsTextField('browserUrl'),
            P.settingsTextField('wsEndpoint'),
            P.settingsTextField('wsHeaders'),
            P.settingsTextField('channel'),
            P.settingsTextField('executablePath'),
            settingsBooleanField('headless'),
            settingsBooleanField('isolated'),
            P.settingsTextField('userDataDir'),
            P.settingsTextField('viewport'),
            P.settingsTextField('toolset'),
            P.settingsTextField('screenshotDir'),
            numberField('connectTimeoutMs'),
            numberField('actionTimeoutMs')
          ],
          []
        );
        this.store = this.form.bind(() => this.projection());

        // 设置命名空间本身变化时（例如别处改了配置）刷新一次状态展示。
        this.unsubscribe = typeof scope?.subscribe === 'function' ? scope.subscribe(() => { this.pollStatus(); }) : () => {};

        // 挂载后立即取一次状态，之后每 3 秒刷新；方案探测单独跑一次。
        this.timer = setInterval(() => {
          this.pollStatus();
        }, STATUS_POLL_MS);
        this.pollStatus();
        this.refreshProbe();
      }

      /** 用表单当前的读取结果与页面自有状态构建页面快照。 */
      projection() {
        const shell = this.form.shell();
        const busy = this.action !== null;
        return {
          ...shell,
          // 动作进行中把「保存配置」也一并禁用：SettingsForm 的 footer 按钮在
          // invalid 为真时禁用，这里借用该条件覆盖内置按钮，不另外引用其 API。
          invalid: shell.invalid || busy,
          scheme: this.form.field('scheme'),
          browserUrl: this.form.field('browserUrl'),
          wsEndpoint: this.form.field('wsEndpoint'),
          wsHeaders: this.form.field('wsHeaders'),
          channel: this.form.field('channel'),
          executablePath: this.form.field('executablePath'),
          headless: this.form.field('headless'),
          isolated: this.form.field('isolated'),
          userDataDir: this.form.field('userDataDir'),
          viewport: this.form.field('viewport'),
          toolset: this.form.field('toolset'),
          screenshotDir: this.form.field('screenshotDir'),
          connectTimeoutMs: this.form.field('connectTimeoutMs'),
          actionTimeoutMs: this.form.field('actionTimeoutMs'),
          action: this.action,
          message: this.message,
          status: this.status,
          statusError: this.statusError,
          probe: this.probe,
          probeError: this.probeError,
          probeBusy: this.probeBusy
        };
      }

      /** 把当前快照推给页面。 */
      publish() {
        if (this.disposed) return;
        this.store.set(this.projection());
      }

      /**
       * 保存表单，返回是否已干净落盘。
       *
       * `SettingsFormModel` 的公开动作集中在 `form.actions()`；不同版本对顶层
       * `form.save()` 的暴露并不一致。这里先做特性检测：有顶层异步 `save()` 就用它
       * （能准确等到落盘），否则用 `actions().save()` 触发并轮询 `shell().saving`
       * 直到保存结束，避免运行时 `this.form.save is not a function`。
       *
       * @returns 保存后表单没有失败、没有无效字段、也没有遗留暂存。
       */
      async save() {
        const form = this.form;
        if (typeof form.save === 'function') {
          await form.save();
        } else {
          form.actions().save();
          const deadline = Date.now() + SAVE_WAIT_MS;
          while (form.shell().saving === true && Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, SAVE_POLL_MS);
            });
          }
        }
        const shell = form.shell();
        return !shell.failed && !shell.invalid && !shell.dirty;
      }

      /**
       * 调用一个 RPC 端点，把 `{ ok, value | error }` 信封翻译成返回值或异常。
       *
       * @param endpoint - RPC 端点名。
       * @param payload - 请求负载。
       * @returns RPC 成功时的 value。
       */
      async call(endpoint, payload) {
        const result = await this.ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload === undefined ? {} : payload);
        if (result && result.ok === true) return result.value;
        const text = describeRpcError(result ? result.error : undefined);
        throw new Error(text !== '' ? text : this.t('actionFailed'));
      }

      /** 拉取一次连接状态，内容变化时才发布快照。 */
      async pollStatus() {
        if (this.disposed || this.statusPolling) return;
        this.statusPolling = true;
        try {
          const result = await this.ctx.connection.rpc.call(RPC_CHANNEL, 'status', {});
          if (this.disposed) return;
          if (result && result.ok === true) {
            this.status = result.value === undefined ? null : result.value;
            this.statusError = '';
          } else {
            this.statusError = describeRpcError(result ? result.error : undefined) || this.t('statusUnavailable');
          }
        } catch (error) {
          if (this.disposed) return;
          this.status = null;
          this.statusError = messageOf(error) || this.t('statusUnavailable');
        } finally {
          this.statusPolling = false;
          if (!this.disposed) {
            // 状态快照只在内容变化时刷新，避免每 3 秒无谓重渲染。
            const serialized = `${JSON.stringify(this.status)}|${this.statusError}`;
            if (serialized !== this.statusSerialized) {
              this.statusSerialized = serialized;
              this.publish();
            }
          }
        }
      }

      /** 拉取一次四方案探测结果（有 IO，不跟状态轮询一起跑）。 */
      async refreshProbe() {
        if (this.disposed || this.probeBusy) return;
        this.probeBusy = true;
        this.probeError = '';
        this.publish();
        try {
          const value = await this.call('probe');
          if (this.disposed) return;
          this.probe = value === undefined ? null : value;
          this.probeError = '';
        } catch (error) {
          if (this.disposed) return;
          this.probe = null;
          this.probeError = messageOf(error) || this.t('probeUnavailableNote');
        } finally {
          this.probeBusy = false;
          this.publish();
        }
      }

      /**
       * 把连接结果压成一句摘要，例如「连接成功：Chrome 版本 Chrome/155.0，复用已有浏览器」。
       *
       * @param prefixKey - 前缀文案 key（testSuccess / applySuccess）。
       * @param value - RPC 返回的 connect 值。
       * @returns 摘要文案。
       */
      connectSummary(prefixKey, value) {
        const parts = [];
        if (value && typeof value.browserVersion === 'string' && value.browserVersion !== '') {
          parts.push(`${this.t('versionLabel')} ${value.browserVersion}`);
        }
        if (value && value.reused === true) {
          parts.push(this.t('reusedBrowser'));
        } else if (value && Number.isFinite(value.launchedPid) && value.launchedPid > 0) {
          parts.push(`${this.t('launchedBrowser')} (PID ${value.launchedPid})`);
        }
        const prefix = this.t(prefixKey);
        if (parts.length === 0) return prefix;
        return `${prefix}${this.t('summaryJoin')}${parts.join(this.t('summarySeparator'))}`;
      }

      /**
       * 把动作结果翻译成一句摘要文案。
       *
       * @param kind - 动作名（test / apply / disconnect / openPage）。
       * @param value - RPC 返回的 value。
       * @returns 摘要文案。
       */
      successText(kind, value) {
        if (kind === 'test') return this.connectSummary('testSuccess', value);
        if (kind === 'apply') return this.connectSummary('applySuccess', value);
        if (kind === 'disconnect') {
          const closed = value && value.closedOwnedBrowser === true ? this.t('closedOwnedBrowser') : '';
          if (closed === '') return this.t('disconnectSuccess');
          return `${this.t('disconnectSuccess')}${this.t('summarySeparator')}${closed}`;
        }
        if (kind === 'openPage') {
          const url = value && typeof value.url === 'string' && value.url !== '' ? value.url : 'about:blank';
          return `${this.t('openPageSuccess')}${this.t('summaryJoin')}${url}`;
        }
        return this.t('actionSuccess');
      }

      /**
       * 执行一个动作：先保存表单，保存不干净则取消；再调用对应 RPC。
       *
       * @param kind - 用于按钮文案的动作名（test / apply / disconnect / openPage）。
       * @param endpoint - RPC 端点名。
       */
      async runAction(kind, endpoint) {
        if (this.action !== null || this.disposed) return;
        this.action = kind;
        this.message = null;
        this.publish();
        try {
          const saved = await this.save();
          if (!saved) {
            this.message = { tone: 'error', text: this.t('saveBlocked') };
            return;
          }
          const value = await this.call(endpoint);
          this.message = { tone: 'success', text: this.successText(kind, value) };
        } catch (error) {
          this.message = { tone: 'error', text: messageOf(error) || this.t('actionFailed') };
        } finally {
          this.action = null;
          this.publish();
          this.pollStatus();
          // connect / disconnect 会改变「当前方案」，探测结果要跟着刷新。
          if (kind === 'test' || kind === 'apply' || kind === 'disconnect') this.refreshProbe();
        }
      }

      /** 构建页面槽位注册所注入的那张「面孔」。 */
      inject() {
        const actions = this.form.actions();
        return {
          hooks: { chromeDevtools: this.store },
          ...actions,
          // actions().save 丢弃了底层 Promise；动作按钮需要等真正落盘后再调 RPC。
          save: () => this.save(),
          test: () => this.runAction('test', 'connect'),
          apply: () => this.runAction('apply', 'connect'),
          disconnect: () => this.runAction('disconnect', 'disconnect'),
          openPage: () => this.runAction('openPage', 'openBrowserPage'),
          refreshProbe: () => this.refreshProbe()
        };
      }

      /** 释放轮询 interval 与全部订阅。 */
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer !== undefined) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
        this.unsubscribe();
        this.form.dispose();
      }
    }

    /** 必需的服务（cordis fiber inject）。 */
    const inject = ['slots', 'locale', 'configForms', 'connection'];

    /**
     * 在 Host 提供其命名空间期间挂载设置页。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chrome-devtools: 词典');

      const card = new ChromeDevtoolsCardController(ctx.configForms.get(SETTINGS_NS), ctx, t);
      ctx.effect(
        () => () => {
          card.dispose();
        },
        'dsh-chrome-devtools: 表单订阅与状态轮询'
      );
      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_NS], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'chrome-devtools',
                  order: 43,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => card.inject()
                },
                ChromeDevtoolsCard
              )
            )
          ),
        'dsh-chrome-devtools: 设置页'
      );
    }

    exports.NS = NS;
    exports.SETTINGS_NS = SETTINGS_NS;
    exports.RPC_CHANNEL = RPC_CHANNEL;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
