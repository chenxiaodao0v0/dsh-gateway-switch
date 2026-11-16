# DSH 客户端插件开发 API 速查手册（实现级）

> 目标机器：DSH Desktop（Electron），安装目录 `D:\install\newDSH`，代码在 `resources/app.asar`。
> 内部包版本：**0.2.1-rc.5**（真实安装版本，见 `/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/package.json` 的 `version`）。
> `DSH_HOME=C:\Users\jiashuai.chen\.dsh`，当前 profile：`C:\Users\jiashuai.chen\.dsh\profiles\desktop`。
> 证据路径中的 `/dsh/...` 指 asar 内部路径；行号对应该 asar 内文件（与提取出的副本行号一致）。
> 提取命令：`node %TEMP%\asar-x.js /dsh/node_modules/@deepseek-ai/<pkg>/<file>`。

---

## 0. TL;DR（先看这 8 条）

| 问题 | 结论 | 证据 |
|---|---|---|
| 客户端 UI 能否手写纯 `.mjs`？ | **不能**。客户端 bundle 必须是 `window.__ModuleLoader__.load({id, factory})` 格式的**预构建单文件**；缺 `lib/client.js` 会明确激活失败 | `dsh-client-modules/README.zh.md#L34,L55`；`index-BXV-oxvX.js#L190` |
| 客户端能 import 什么？ | 只有 **PLATFORM_MODULES 静态表**里的 11 个 id（react、react-dom、cordis、store、ui-slots、ui-primitives、dockkit、zod、tanstack-virtual 等），其余必须由 `dsh.client.external` 声明 | `index-BXV-oxvX.js#L190` |
| 设置页加分区用什么？ | `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))` | `dsh-client-ui-settings-general/lib/client.js#L1299-L1309` |
| 组件 props 从哪来？ | `inject()` 的返回值 + 渲染器注入的 `renderSlot` / `useSnapshot` / `t` + `close` | `dsh-client-ui-settings-models/lib/client.js#L2324-L2337` |
| `hooks` 怎么用？ | `hooks: { snapshot: store }` → 组件里 `const s = useSnapshot(sel)`（**键名首字母大写 + `use` 前缀**） | `settings-general#L690-L691`、`settings-models#L2897` |
| 客户端调服务端？ | 自定义通道：服务端 `connection.rpc.handle('/my-chan', handler)`，客户端 `ctx.get('connection').rpc.call('/my-chan','ep',payload)` | `dsh-web-search-pro/lib/rpc.js#L79-L84`、`lib/client.js#L3070` |
| 凭证能热更新吗？ | **能**。`resolve` 是每次调用现读、无缓存；`set/unset` 及**存储文件被外部编辑**都会发 `credentials/reference-updated` | `dsh-credentials/README.zh.md#L12,L91,L114,L121` |
| settings 页卡住不动？ | 忘记 `ctx.slots.inject(...)`，slot 声明未就绪时直接 `register` 会失败/不显示 | `settings-general#L1058-L1062` |

---

## 1. 插件包结构

### 1.1 一个包同时被服务端与客户端加载

```jsonc
// package.json —— 服务端 + 客户端双入口（最完整样例：dsh-web-search-pro）
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",            // 服务端(Node)入口：Cordis 加载
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":          { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client":   { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }, // 浏览器 bundle
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",              // 只加载浏览器 bundle 的平台，写死 'web'
      "inject": [                     // 依赖/顺序：这些客户端插件先激活
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-settings"
      ],
      "external": []                  // 可选：静态表之外还要 require 的模块（第三方插件包）
    },
    "bundle": { "patch": "./cordis.patch.yml" }   // 本包自带的 loader patch 层
  }
}
```

证据：`dsh-web-search-pro/package.json`（`main`/`exports["./client"]`/`dsh.client.inject`/`platform`/`dsh.bundle.patch`）；
`dsh-client-ui-settings/package.json`（官方包同构，`dsh.client.platform: "web"`）；
`dsh-client-modules/README.zh.md#L34`：「浏览器插件包在其 `package.json` 中以 `platform: 'web'` 声明 `dsh.client`，导出 `./client` bundle，并在 `dsh.client.external` 下列出任何基座之外的模块请求」；
`#L51`：「外壳初始化一张冻结的模块表（`PLATFORM_MODULES`）」；
`#L55`：「宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；缺失 bundle 会明确导致激活失败」。

> `inject` vs `external`：`inject` 是**客户端插件之间的激活顺序依赖**（列包名）；`external` 是**模块请求额外出口**（列 `require` 的模块 id，仅当不在静态表且由别的插件 bundle 提供时）。纯类型 import 会被擦除，不产生请求（`#L51`）。

### 1.2 cordis.patch.yml —— bundle 层的写法

```yaml
# 本包根目录的 cordis.patch.yml：一个顶层 YAML 数组，每个条目是 loader 的一个插件条目
- insert:
    - id: web-search-pro            # 条目 id：profile 的 patch 用它来覆盖 config
      name: dsh-web-search-pro      # 包名或 ./ 相对路径（由 loader 解析）
```
证据：`dsh-web-search-pro/cordis.patch.yml`（全文 12 行，仅一个 `insert`）。

带 config 的形态（来自真实 profile patch）：

```yaml
- insert:
    - id: my-plugin
      name: dsh-my-plugin
      config:                       # 传给 apply(ctx, config) 的第二参数
        endpoint: http://127.0.0.1:8080
        dryRun: true
```
证据：`C:\Users\jiashuai.chen\.dsh\profiles\desktop\cordis.patch.yml`（`- id: agent-default-model / name: ... / config: {provider, model}`；`- id: teamai-experience-bridge / name: ... / config: {...}` 的注释块）。

### 1.3 bundle 与 `dsh.profile.bundles` 的关系

profile 的 `package.json` 决定**哪些包被当作 bundle 安装**；只有装进 `dsh.profile.bundles` 的包，其 `cordis.patch.yml` 才会被应用：

```jsonc
// C:\Users\jiashuai.chen\.dsh\profiles\desktop\package.json
{
  "dependencies": {
    "dsh-web-search-pro": "0.2.3",
    "@openviking/dsh-memory-plugin": "^0.5.32"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-web-search-pro",              // ← 在 bundles 里 → patch 生效 → 插件被 insert
        "@openviking/dsh-memory-plugin"
      ]
    },
    "desktopDeselectedBundles": ["@linxin666/dsh-doctor"]
  }
}
```
证据：`C:\Users\jiashuai.chen\.dsh\profiles\desktop\package.json`；旁证：profile 的 `cordis.patch.yml` 里 teamai-bridge 段被注释掉，注释明确写「从 profile 的 `dsh.profile.bundles` 里移除了插件，插件不会被加载」。

**三层顺序**：`profile.package.json#dsh.profile.bundles`（装哪些 bundle）→ 各 bundle 的 `cordis.patch.yml`（insert 什么条目）→ profile 根 `cordis.patch.yml`（覆盖/禁用/追加，最后应用）。profile 根 patch 首行注释原文：「Your patch layer for this dsh profile, applied after every bundle layer」。

---

## 2. 服务端插件 API

### 2.1 模块契约

```js
// lib/index.js（或 index.mjs）——Cordis 插件三件套
export const name = "dsh-my-plugin";          // 条目名
export const inject = ["tools", "credentials"]; // 需要的服务，就绪后才 apply
export function apply(ctx, config) { /* ... */ }
```
证据：`dsh-plugin-teamai-bridge/index.mjs`（`export const name`、`export const inject = ["llm"]`、`export function apply(ctx, input = {})`）；
`@openviking/dsh-memory-plugin/index.mjs`（同构，`type: module` + `main: index.mjs`）。

### 2.2 ctx 上的能力（按可用性分级）

| 能力 | 用法 | 证据 |
|---|---|---|
| 工具注册 | `ctx.tools.register(defineTool({...}))` | `dsh-tools/README.zh.md#L45` |
| 工具限制/查询 | `ctx.tools.restrict(filter)` / `.get(name, scope)` / `.schemas(scope)` / `.guard(g)` | `dsh-tools/README.zh.md#L85-L89` |
| 凭证 | `ctx.credentials.resolve/describe/set/unset`、`readRecord/modifyRecord/deleteRecord/listRecords` | `dsh-credentials/README.zh.md#L52-L79` |
| 日志 | `const log = ctx.logger ?? console; log.info/warn/debug` | `dsh-plugin-teamai-bridge/index.mjs`（`apply` 首行） |
| 生命周期事件 | `ctx.on("session/flush", fn)` | 同上（`ctx.on("session/flush", (session) => {...})`） |
| 副作用清理 | `ctx.effect(() => disposeFn, "label")` | 同上；官方客户端包同款 |
| 可选子上下文 | `ctx.inject(["connection","webServer"], (c) => {...})` | `dsh-web-search-pro/lib/rpc.js#L80-L83` |
| 取服务 | `ctx.get("connection")`、`ctx.root.connection` | `lib/client.js#L3070`；`rpc.js#L81` |
| LLM 直调 | `ctx.llm.stream({provider, model, system, messages, temperature, signal})` | teamai-bridge `callModel()` |
| 设置 | 服务端**没有**通用 `ctx.settings` 读写 API；业务插件直接读自己的 `config`（loader 传入） | `dsh-settings/README.zh.md#L33,L47`（「业务插件直接读取自己的 Config 引用」） |

> `ctx.settings` 的准确语义：`dsh-settings` 是**Host 侧设置文档的持久化 seam**，它对外提供的是「表单描述符 + 校验 + 写回 profile patch」，不是业务插件的键值存储。自带页面的插件用 `ctx.inject(['settings'], () => ctx.effect(() => configure({ auto: false }, ctx.fiber)))` 关掉自动生成表单（`dsh-settings/README.zh.md#L39`）。

### 2.3 最小服务端插件（注册一个工具 + 读写一个凭证）

```js
// lib/index.js
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

export const name = "dsh-gateway-switch";
export const inject = ["tools", "credentials"];

const KEY = credentialRef("GATEWAY_SWITCH_KEY");   // POSIX 标识符，branded

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console;

  ctx.tools.register(defineTool({
    name: "gateway_switch_status",
    description: "读取凭证是否已配置（永不返回凭证值）。",
    parameters: {
      verbose: { type: "boolean", description: "是否返回来源信息" },
    },
    output: {
      schema: { type: "string" },                                 // 与官方 README 示例同构：先返回字符串
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const info = await ctx.credentials.describe(KEY);           // { configured, source?, writable } —— 永不含值
      return JSON.stringify({
        configured: info.configured,
        source: args.verbose ? (info.source ?? "") : "",
      });
    },
  }));

  // 写凭证（示例：首次启动时兜底写入，空值会被拒绝）
  ctx.effect(() => {
    void (async () => {
      const info = await ctx.credentials.describe(KEY);
      if (!info.configured && config.bootstrapKey) {
        await ctx.credentials.set(KEY, config.bootstrapKey);
        log.info?.("[gateway-switch] bootstrap credential stored");
      }
    })();
  }, "gateway-switch: bootstrap credential");
}
```
依据：`defineTool` 的 `name/description/parameters/output.schema/render/execute(args, exec)` 全部取自 `dsh-tools/README.zh.md#L45-L62`；
`credentialRef` / `describe` / `set` 签名取自 `dsh-credentials/README.zh.md#L52-L59`。

---

## 3. 客户端插件 API（最关键）

### 3.1 加载契约（先搞清机制，否则一定踩坑）

1. 宿主扫每个已启用 loader 条目的 `package.json` → 读 `dsh.client` → 把 `<pkg>/client.js` 注册成 `/plugins/<package>/client.js` 的 combo bundle（`dsh-client-modules/README.zh.md#L12,L34,L38,L79`）。
2. 外壳 `<head>` 注入 `window.__ModuleLoader__` queue facade + bootstrap combo，浏览器**惰性**执行：跑 bundle 只注册 factory，模块体在首次 `require`/物化时才运行（`#L38,L73,L85`）。
3. 因此 **bundle 必须是自包含单文件**，形如：

```js
// lib/client.js —— 唯一合法形态（官方包与第三方插件完全一致）
window.__ModuleLoader__.load({
  id: "dsh-my-plugin",                       // 浏览器模块身份 = 包名
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let jsx = require("react/jsx-runtime");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    /* ... 你的代码 ... */
    exports.name = "my-plugin-client";
    exports.inject = ["slots", "locale", "connection"];
    exports.apply = apply;
    return module.exports;
  },
});
```
证据：`dsh-web-search-pro/lib/client.js` 头尾（`window.__ModuleLoader__.load({ id: "dsh-web-search-pro", factory: (require) => {...}; return module.exports; });`）；
`dsh-client-ui-settings-models/lib/client.js#L1-L9`（官方包同款，`id: "@deepseek-ai/dsh-client-ui-settings-models"`）。

### 3.2 允许 `require` 的模块（PLATFORM_MODULES，rc.5 实测全量）

```js
// dsh-web-frontend/dist/assets/index-BXV-oxvX.js#L190（minified，原样摘录后展开）
{
  "react", "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", "zod", "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit"
}
```
`dsh-client-ui-renderer/README.zh.md#L58` 佐证：「React、React DOM、Cordis、ui-slots 与 ui-primitives 通过 Web 外壳的静态模块表保持同一浏览器身份」。

> **写插件时怎么拿到这些模块的类型？** 它们**没有**被安装进 DSH 的 `node_modules`（asar 里 `/dsh/node_modules/@deepseek-ai/` 共 307 个包，这四个都不在里面——它们被外壳静态打包了），但**在 npm 上都正常发布**，且版本号与宿主一致（实测 `npm view @deepseek-ai/dsh-client-ui-slots@0.2.1-rc.5 version` → 命中）。所以：
> ```bash
> npm i -D @deepseek-ai/dsh-client-ui-slots@0.2.1-rc.5 \
>          @deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.5 \
>          @deepseek-ai/dsh-client-store@0.2.1-rc.5
> ```
> 只装成 devDependency 取类型；**运行时由静态表提供**，所以打包时必须把它们放进 `external`，绝不能 inline 进 bundle（inline 会造出第二份 React/slot 实现，slot 注册直接失效——`ui-renderer/README.zh.md#L58`「保持同一浏览器身份」就是这个意思）。

### 3.3 客户端插件入口与服务

```js
export const name = "my-plugin-client";
export const inject = ["slots", "locale", "connection"];   // 用到的客户端服务
export function apply(ctx) { /* 注册 slot / 字典 / effect */ }
```
客户端 `ctx` 上可用服务（实测自官方包 `inject` 数组）：

| 服务 | 用途 | 证据 |
|---|---|---|
| `slots` | slot 注册表：`inject/register/entries/subscribe/getVersion` | `settings-general#L1063-L1072` |
| `locale` | `register(NS, {zh,en})`、`bind(NS)`、`getSnapshot()` | 同上 + `#L1101-L1104,L1119` |
| `connection` | `ctx.get("connection")` → `.rpc.call(...)`、`.state` | `dsh-web-search-pro/lib/client.js#L3070` |
| `remote` | Typert Host remote 命名空间（`remote.credentials`、`remote.settings`、`remote.llm`、`remote.$on`、`remote.$host`） | `settings-models#L4417-L4427`、`settings-general#L1120` |
| `configForms` | 配置表单：`get(id)`、`whileServed([...], fn)`、`describe()`、`developerTools` | `settings-general#L1085-L1091`；`web-search-pro/lib/client/index.js#L11-L21` |
| `settingsSchema` | schema 重建/校验/嵌套编辑 | `settings-models#L4426` |
| `modules` | 客户端模块系统：`ctx.modules.entries.dismissRelease()` | `settings-general#L1312` |
| `shortcuts` | `ctx.shortcuts.catalog` | `settings-general#L1141` |
| `uiRenderer` | 仅外壳使用：`ctx.uiRenderer.mount(container)` | `ui-renderer/README.zh.md#L28,L32` |

### 3.4 slot 注册模型（核心 API）

```js
ctx.slots.inject(slotType, () => ctx.slots.register(options, Component))
```
- `ctx.slots.inject(type, fn)`：等 `type` 的**声明**进了 ledger 才执行 `fn`，返回 disposer。官方注释原文：「The target slots are declared by ui-settings' apply, whose activation order relative to this one is NOT constrained; registrations depend on their slots through `slots.inject()`」（`settings-general#L1058-L1062`）。
- `ctx.slots.register(options, Component)` 返回 disposer，通常包进 `ctx.effect(...)`。

`options` 的字段（**已按 `@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.5` 的 `lib/types/index.d.ts` 核对**，不再是猜测）：

```ts
// 摘自 lib/types/index.d.ts（rc.5）
type SlotKind  = 'single' | 'list' | 'keyed' | 'chain';          // L83
type SlotScope = 'root' | 'session-maybe' | 'session';           // L85
type SlotLabel = string | (() => string);                        // L559

interface BaseOptions<K, EntryKey, D, H, M, N> {                 // L601-L617
  name: K;                       // 目标 slot key（条目贡献进这个 slot）
  children?: D;                  // 子 slot 声明表：声明 = 授权 = 运行时 spec
  store?: H;                     // store 座位：defineStore 的 handle，或独占 factory
  locale?: N;                    // 声明字典命名空间 → props 上出现类型化 t
  registrant?: string;           // 诊断用身份标签
  // KindOptions（L564-L587）按 kind 分派：
  //   keyed → key（必填）、priority
  //   list  → id（必填）、order、label、priority
  //   chain → select（必填的选路函数）、priority
  //   single→ priority
}
```

| 字段 | 说明 |
|---|---|
| `name` | slot 类型名；必须与 `inject` 的第一个参数一致 |
| `id` | **`list` 必填**，缺失直接 throw；也是导航项 id |
| `key` | **`keyed` 必填**，缺失直接 throw（如右侧栏 tab） |
| `select` | **`chain` 必填**，纯函数 `(owner) => M \| null`，返回非 null 即"当选" |
| `order` | `list` 内排序，小的在前 |
| `priority` | 遮蔽/链路优先级：同 cell 同 priority 的第二次注册**直接 throw**（默认 0） |
| `label` | `string \| (() => string)`；thunk 每次读取重新求值（跟随语言切换） |
| `locale` | 字典命名空间 → 组件拿到类型化 `t`（未安装 locale face 时渲染会报错） |
| `inject` | `(...args) => I`：业务面工厂。`args` 依 scope/store 而定（`root` 且无 store 时为空参数） |
| `children` | `{ "<slotName>": { kind, scope, inline?, inject? } }` |
| `store` | `defineStore(...)` 的 handle；组件经 `PropsStore` 拿到 `actions` |
| `registrant` | 诊断用；运行时通常由框架盖上 fiber 名 |

**注册时会 fail-loud 的 6 种情况**（原文见 `SlotCore.register` 的 JSDoc，`index.d.ts#L762-L792`）：

1. 往**未声明**的 slot 注册 → throw；
2. 声明一个**已被别人声明**的子 slot key → throw（一个 slot 只有唯一声明方，报错会点名先声明者）；
3. 同一个 `defineStore` handle 挂到**不同 scope** 的 slot → throw；
4. `keyed` 缺 `key` / `list` 缺 `id` / `chain` 缺 `select` → throw；
5. 同一 cell、同一 `priority`（默认 0）重复注册 → throw 并点名占用者；
6. **声明了 `children` 却不消费 `renderSlot`** → 编译期报错（`RendersCheck`，`index.d.ts#L588-L599`：「declaring is claiming」）。

**`ctx.slots`（SlotCore）可用的读 API**（`index.d.ts#L716-L901`）：

```ts
ctx.slots.entries(key)              // readonly StoredEntry[]，稳定引用，可作 uSES getSnapshot
ctx.slots.entriesOfSlot(key)        // 每个 cell 的遮蔽赢家（渲染用，每次新数组）
ctx.slots.spec(key) / .specDynamic(key)
ctx.slots.getVersion(key)           // 单调版本，配合 uSES
ctx.slots.subscribe(key, fn)        // 条目变化，微任务批量
ctx.slots.subscribeDeclaration(key, fn)  // 声明生命周期（同步）
ctx.slots.declarationEpoch(key)
ctx.slots.snapshot(root?)           // 导出声明拓扑（无组件/无钩子，可用于排障）
ctx.slots.registerFactory(...) / .factory(name) / .factoryVersion(name)
```
另有 `resolveSlotLabel(label)` 导出（`index.d.ts#L652`），用于把 `label` thunk 解析成当前语言文案。

### 3.5 组件 props 契约（渲染器注入的）

```ts
// 五个 share 的并集，全部由声明推导（ComposedProps，index.d.ts#L478）
type ComposedProps = PropsRuntime    // 父级 renderSlot 传入的 owner props + keyProps
                   & PropsRenderSlots// { renderSlot, renderSlotChain?, SessionProvider? }
                   & PropsRenderFactories // { renderFactorySlot }
                   & PropsStore      // store 的 actions（声明了 store 时）
                   & InjectFace<I>   // 你的 inject() 返回面（hooks 已绑定成 use<Name>）
                   & MatchedShare    // chain 时的 matched
                   & PropsLocale<N>; // 声明 locale 时的 t
```

**`hooks` → `use<Name>` 的转换是机械的**（`PropsSlotHooks`，`index.d.ts#L443-L445`）：

```ts
type PropsSlotHooks<HS> = { [N in keyof HS & string as `use${Capitalize<N>}`]: BoundHookOf<HS[N]> };
// 另有导出函数 standardHookPropName(name) => "use"+首字母大写（renderer.d.ts#L39）
```

所以：`hooks: { snapshot }` → `useSnapshot`、`{ developerTools }` → `useDeveloperTools`、`{ models }` → `useModels`、`{ gateway }` → `useGateway`。
hook 的签名是 `SnapshotSelectorHook`：`useX(selector?, equal?)`，未传 selector 时返回整个快照。

**`hooks` 的值必须是 `HostObservable`**：`{ getSnapshot(): T; subscribe(fn): () => void }`（`renderer.d.ts#L32-L33`）。用官方工具造最省事：

```ts
import { createSnapshotStore, defineStore, shallowEqual } from "@deepseek-ai/dsh-client-store";
const store = createSnapshotStore({ rows: [], status: "idle" });  // 自带 getSnapshot/subscribe/update/set
```

- **`keyedHooks`**：开放键族的源，组件拿到 `useName(key, selector?, equal?)`（`KeyedSnapshotSelectorHook`，`index.d.ts#L419-L429`）。仅在需要"按 key 取不同源"时用。
- **`store` 座位**：`defineStore({...})` 的 handle 挂到 `options.store`，组件从 `PropsStore` 拿 `actions`；但**注意它和 `hooks` 是两条路**——`hooks` 给只读 selector hook，`store` 给可写 actions。
  证据：`dsh-client-store/lib/types/index.d.ts#L89-L91`（`defineStore`）、`#L44-L49`（`createSnapshotStore`）、`contract.d.ts`（`PropsStore`/`BoundActions`/`StoreHandle`）。
- **`inject` 的参数**：`InjectParams`（`index.d.ts#L487`）—— `session` scope 传 `sessionId`；带 `store` 时再追加 `actions`；`root` + 无 store 时**空参数**，所以 `inject: () => ({...})` 是正确的写法。
- **`renderSlot` 的授权是强制的**：只能渲染你 `children` 里声明过的 key，越界抛 `SlotOwnershipError`；声明方已 dispose 后再调用抛 `StaleAuthorizationError`（`renderer.d.ts#L261-L270`）。
- **`close` 不是框架标准座位，是父级的 owner props**：外壳渲染 section 时传的是 `renderSlot("settings.section", { close: onClose }, { only: active })`（`settings-general/lib/client.js#L337`），所以 section 组件能拿到 `close`；你声明的子 slot 组件**不会**自动获得它，要自己在 `renderSlot(name, { close })` 里显式传下去。

> `renderSlot` 的第三参数 `{ only: activeId }` 只在**外壳侧**用（一次只渲染当前激活的 section）；插件内部渲染子 slot 不需要它。

### 3.6 【可直接抄】在设置页加一个分区：列表 + 切换按钮

**目录**
```
dsh-gateway-switch/
├─ package.json
├─ cordis.patch.yml
├─ tsconfig.json
├─ src/
│  ├─ server/index.ts        # 服务端：RPC handler + 可选 ctx.tools
│  └─ client/
│     ├─ index.tsx           # 客户端：注册 settings.section
│     ├─ GatewaySection.tsx  # 分区组件（列表 + 开关 + 按钮）
│     ├─ store.ts            # 控制器（可观察 store + 拉取逻辑）
│     └─ locale.ts           # {zh, en}
└─ lib/                      # 构建产物：index.js / client.js
```

**`src/client/store.ts`** —— 走自定义 RPC 通道取列表（见第 4 节）

```ts
import type { Context } from "@deepseek-ai/cordis";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";

export const CHANNEL = "/dsh-gateway-switch";

export interface GatewayRow { id: string; name: string; active: boolean; }

export type GatewaySnapshot = {
  status: "idle" | "loading" | "ready" | "error";
  rows: GatewayRow[];
  error?: string;
};

/** createSnapshotStore 自带 getSnapshot/subscribe/update/set，正好满足 hooks 需要的 HostObservable */
export function createGatewayController(ctx: Context) {
  const store = createSnapshotStore<GatewaySnapshot>({ status: "idle", rows: [] });

  const rpc = () => {
    const connection = (ctx as any).get?.("connection") ?? (ctx as any).connection;
    return typeof connection?.rpc?.call === "function" ? connection.rpc : undefined;
  };

  async function load() {
    const r = rpc();
    if (!r) return store.update((d) => { d.status = "error"; d.error = "no connection"; });
    store.update((d) => { d.status = "loading"; });
    try {
      const res = await r.call(CHANNEL, "list", {});
      if (!res.ok) throw new Error(res.error?.message ?? "rpc failed");
      store.set({ status: "ready", rows: res.value.rows });
    } catch (e) {
      store.set({ status: "error", rows: [], error: String(e) });
    }
  }

  async function toggle(id: string, active: boolean) {
    const r = rpc();
    if (!r) return;
    const res = await r.call(CHANNEL, "toggle", { id, active });
    if (res.ok) store.set({ status: "ready", rows: res.value.rows });   // 服务端回传最新列表
  }

  return { store, load, toggle };
}
```
依据：`createSnapshotStore(init, {flush?, persist?})` 与 `SnapshotStore.update(draft)/set(next)` 见 `dsh-client-store/lib/types/index.d.ts#L4-L49`；`connection.rpc.call` 的取法照抄 `dsh-web-search-pro/lib/client.js#L3070-L3071`；`{ok, value}|{ok:false,error:{code,message,details}}` 结果形状照抄 `lib/rpc.js#L36-L75`。
（`update` 用 immer draft，所以是 `(d) => { d.status = ... }` 的写法；也可以不用 `createSnapshotStore`，自己实现 `{getSnapshot, subscribe}` 一样合法——`HostObservable` 只要这两个方法。）

**`src/client/GatewaySection.tsx`**

```tsx
import { useEffect } from "react";
import { Button, Switch } from "@deepseek-ai/dsh-client-ui-primitives";

export function GatewaySection(props: any) {
  const { controller, useGateway, close, t } = props;
  const snap = useGateway((s: any) => s);              // hooks: { gateway: controller.store }

  // 首次进入拉一次列表
  useEffect(() => { void controller.load(); }, [controller]);

  if (snap.status === "idle" || snap.status === "loading")
    return <div className="gw-empty">{t("loading")}</div>;

  return (
    <div className="gw-section">
      <header className="gw-header">
        <span>{t("title")}</span>
        <Button size="sm" onClick={() => void controller.load()}>{t("refresh")}</Button>
      </header>

      <ul className="gw-list">
        {snap.rows.map((row: any) => (
          <li key={row.id} className="gw-row">
            <span className="gw-name">{row.name}</span>
            <Switch
              checked={row.active}
              onChange={(next: boolean) => void controller.toggle(row.id, next)}
            />
          </li>
        ))}
      </ul>

      {snap.status === "error" && <div className="gw-error">{snap.error}</div>}
      <footer className="gw-footer">
        <Button variant="ghost" onClick={close}>{t("close")}</Button>
      </footer>
    </div>
  );
}
```
依据：`Button` / `Switch` / `Modal` / `Checkbox` / `SegmentedControl` / `Tooltip` 均从 `@deepseek-ai/dsh-client-ui-primitives` 导出，实测使用清单见 `settings-models` 与 `settings-general` 的 client bundle（`_deepseek_ai_dsh_client_ui_primitives.{Button,Switch,Checkbox,Modal,SegmentedControl,Tooltip,Icon*}`）。
`Button` 的具体 props（`variant`/`size`）**未验证**——请按 `dsh-client-ui-primitives` 的 `Button.d.ts` 校正（asar 内未随包发布 .d.ts）。

**`src/client/index.tsx`** —— 注册分区（这是最关键的一段）

```tsx
import { createGatewayController } from "./store";
import { GatewaySection } from "./GatewaySection";
import { zh, en } from "./locale";

export const name = "dsh-gateway-switch-client";
export const inject = ["slots", "locale", "connection"];

const NS = "gateway-switch";
const SECTION_ID = "gateway-switch";
const CHILD = "gateway-switch.row.action";   // 必须与 children 声明里的 key 完全一致

export function apply(ctx: any) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "gateway-switch: dictionaries");
  const t = ctx.locale.bind(NS);

  const controller = createGatewayController(ctx);

  ctx.effect(
    () => ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: SECTION_ID,
      order: 120,                                  // 排在 general(0)/models(10)… 之后
      label: () => t("nav"),                        // 左侧导航文案（thunk，跟随语言切换）
      locale: NS,                                   // → 组件拿到类型化 t
      inject: () => ({
        controller,
        hooks: { gateway: controller.store },       // → props.useGateway(selector)
        t,
      }),
      children: {
        [CHILD]: { kind: "list", scope: "root" },   // 可选：行内动作扩展点
      },
    }, GatewaySection)),
    "gateway-switch: settings section",
  );
}
```
对照真实样例：`settings-general/lib/client.js#L1299-L1309`（`name/id/order/label/locale/children` + `GeneralSection`）、
`settings-models/lib/client.js#L4485-L4501`（`label: () => t("nav")`、`inject: injected`、`children` 两种 kind）。

> ⚠️ 两个必踩的坑：
> 1. `settings.section` 这个 slot **类型本身是 `@deepseek-ai/dsh-client-ui-settings` 声明**的。你的 `package.json#dsh.client.inject` 必须把它列进去（官方包无一例外），否则你的 bundle 可能先于声明方激活。即便顺序被 `slots.inject` 兜住，「列进去」也是零成本保险。
> 2. 注册必须走 `ctx.slots.inject(slotType, ...)`，不要直接 `ctx.slots.register`——官方注释明确说激活顺序不可依赖（`settings-general#L1058-L1062`）。

**`src/client/locale.ts`**

```ts
export const zh = { nav: "网关切换", title: "网关列表", refresh: "刷新", loading: "加载中…", close: "关闭" };
export const en = { nav: "Gateway", title: "Gateways", refresh: "Refresh", loading: "Loading…", close: "Close" };
```

**`package.json` / `cordis.patch.yml`** 见 1.1 / 1.2（`id: gateway-switch`、`name: dsh-gateway-switch`），并把 `dsh-gateway-switch` 加进 `profiles/desktop/package.json` 的 `dsh.profile.bundles`。

---

## 4. 客户端 ↔ 服务端通信

### 4.1 两条路，选哪条

| 方式 | 适用 | 证据 |
|---|---|---|
| **A. 自定义 RPC 通道**（推荐给第三方插件） | 自己定义 endpoint，自己写 handler；web-search-pro 就是这么做的 | `web-search-pro/lib/rpc.js` |
| B. `ctx.remote.<namespace>.<method>` | 只能用 **Host 已装配的**命名空间（credentials/settings/llm/session/…），第三方无法新增 | `dsh-api-remotes/README.zh.md#L32-L36,L77-L79` |

`dsh-api-remotes` 的原话：「能力集合由构建时显式导入的值固定确定；Client 不会在运行时发现 Host 中已启用的服务或 Remote 定义」「若要增加能力，必须显式导入相应的 `/remote` 值并在此组合中挂载」——即**第三方插件无法注册新的 Typert remote namespace**，必须走 A。

### 4.2 服务端半侧

```js
// lib/index.js（或单独 rpc.js）
export const RPC_CHANNEL = "/dsh-gateway-switch";   // 绝对路径前缀，全局唯一

/** handler 签名：async (endpoint, rawPayload, context) => RemoteResult */
export function createHandler(services) {
  const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  return async (endpoint, rawPayload, context) => {
    try {
      const payload = isRecord(rawPayload) ? rawPayload : {};
      if (endpoint === "list")   return { ok: true, value: { rows: services.list() } };
      if (endpoint === "toggle") {
        if (typeof payload.id !== "string")
          return { ok: false, error: { code: "bad-request", message: "toggle needs id", details: {} } };
        return { ok: true, value: { rows: services.toggle(payload.id, payload.active === true) } };
      }
      return { ok: false, error: { code: "not-found", message: "unknown endpoint: " + endpoint, details: {} } };
    } catch (error) {
      return { ok: false, error: { code: "bad-request", message: String(error).slice(0, 500), details: {} } };
    }
  };
}

/** 挂到 Host 传输层；没有 connection/webServer 时静默不注册 */
export function registerRpc(ctx, services) {
  ctx.inject(["connection", "webServer"], (connectionCtx) => {
    const connection = connectionCtx.root.connection;
    connectionCtx.effect(
      () => connection.rpc.handle(RPC_CHANNEL, createHandler(services)),
      "gateway-switch: rpc channel",
    );
  });
}
```
依据：`dsh-web-search-pro/lib/rpc.js#L32-L84`（handler 三段签名、`{ok,...}` 结果、`ctx.inject(['connection','webServer'], ...)`、`connection.rpc.handle`、`connectionCtx.effect` 包裹）。`RPC_CHANNEL` 定义为绝对前缀见 `lib/rpc-types.js`（`export const RPC_CHANNEL = '/dsh-web-search-pro'`，注释说明与 `dsh-browser` 的 `/dsh-browser-assets` 同机制）。

### 4.3 客户端半侧

```js
const connection = ctx.get("connection") ?? ctx.connection;   // 客户端取法
const rpc = typeof connection?.rpc?.call === "function" ? connection.rpc : undefined;
const result = await rpc.call("/dsh-gateway-switch", "list", {});
if (!result.ok) throw new Error(result.error.message);
const { rows } = result.value;
```
依据：`dsh-web-search-pro/lib/client.js#L3070-L3071`（取 handle 的确切写法，含 `typeof ... === 'function'` 的探测）、`lib/client/form.js#L125-L127`（`rpc.call(channel, endpoint, payload)` + `result.ok` / `result.error.message`）。

> 客户端**必须**能容忍 `rpc === undefined`（旧 Host / 未组合 connection）：官方卡片在拿不到通道时降级而不是崩（`form.js#L130-L131` 注释：「An older plugin build without the channel answers nothing useful: the card falls back to what it can tell by itself.」）。

---

## 5. 凭证（credentials）读写与热更新

### 5.1 存储形态

`C:\Users\jiashuai.chen\.dsh\.credentials.yaml` 是 `credentials-local` 提供方的落盘文件。**实测顶层只有三个键**：`version`、`refs`、`records`。

```yaml
version: <n>
refs:                     # 引用空间：环境变量形状的名字 → 值（9 条实测）
  PROXY_USER_KEY: <secret>
  DEEPSEEK_API_KEY: <secret>
  ANTHROPIC_API_KEY: <secret>
  # …
records:                  # 记录空间：<owner>/<id> → { kind, payload }
  "llm-pi-ai/openai-codex": { kind: grant|api-key|env, payload: {…} }
```

本机实测 `refs` 下 9 条：`PROXY_USER_KEY`、`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、`COPANY_DS_API_KEY`、`ALL_MODEL_API_KEY`、`OPENAI_API_KEY`、`EXEXM_API_KEY`、`OPENVIKING_GATEWAY_KEY`、`EXEM_API_KEY`。

> 交叉印证「配置只带引用」：profile 的 `cordis.patch.yml` 里 LLM 适配器写的是 `apiKeyEnv: PROXY_USER_KEY` / `apiKeyEnv: ANTHROPIC_API_KEY`，值全部落在上面这张表里，配置文件本身不含机密。
> 证据：`C:\Users\jiashuai.chen\.dsh\.credentials.yaml`（结构实测）；`profiles/desktop/cordis.patch.yml`（`apiKeyEnv` 引用）；`dsh-credentials/README.zh.md#L85-L91`。
> `records` 的条目形状按 `credentialKey` / `modifyRecord` 的语义推得（`dsh-credentials/README.zh.md#L65-L79`），本机当前 `records` 段未逐条核对。

### 5.2 官方 API（服务端）

```ts
import { credentialRef, credentialKey } from '@deepseek-ai/dsh-credentials'

const ref = credentialRef('GATEWAY_SWITCH_KEY')   // 品牌化的「环境变量形状」引用
await ctx.credentials.resolve(ref)                // { value, source } | undefined  ← 唯一能拿到明文的方式
await ctx.credentials.describe(ref)               // { configured, source?, writable }  ← 永不含值
await ctx.credentials.set(ref, 'sk-…')            // 存储值优先于环境变量回退
await ctx.credentials.unset(ref)                  // 不存在时是 no-op，之后环境变量回退重新生效

const key = credentialKey('my-plugin', 'openai-codex')   // <owner>/<id> 记录寻址
await ctx.credentials.readRecord(key)
await ctx.credentials.modifyRecord(key, async (current) => ({ kind: 'grant', payload: { token: '…' } }))
await ctx.credentials.deleteRecord(key)
await ctx.credentials.listRecords()               // [{ key, kind }]，不含值
```
证据：`dsh-credentials/README.zh.md#L52-L59`（引用四件套）、`#L67-L79`（记录五件套）。

### 5.3 能否运行时热更新？**能。** 三条独立证据

1. **语义承诺**：「轮换后的已存储密钥会作用于下一次请求，无需重启或修改配置」（`#L12`）；「需要该密钥的请求使用它当前存储的值，因此轮换密钥会作用于紧随其后的下一次请求——无需重启，无需改配置」（`#L91`）。
2. **实现机制**：「消费方按操作解析。解析是一次按调用读取，无跨操作缓存；**这次读取正是热更新机制**」（`#L114`）。
3. **事件**：`credentials/reference-updated (ref)` 在 `set`、`unset`、**「或在存储中观察到的外部编辑」**后触发（`#L121`）——即**直接改 `.credentials.yaml` 也会生效并广播**，配置界面的「已配置」徽标会自动刷新。记录侧对应 `credentials/record-updated (key)`（`#L123`）。

### 5.4 边界与坑（都有明文）

- **存储值优先于启动环境**：存在存储值时 `DEEPSEEK_API_KEY=… dsh` 不生效；要用环境变量必须先 `unset`（`#L95`）。
- **空值无法存储**：`set(ref, '')` 会被拒绝，要移除请用 `unset`（`#L96`）。
- **进程环境变量变化不可观测**：改 shell 里的环境变量不会触发任何事件，界面只能在自己导航时重新 `describe()`（`#L121,L177`）。
- **引用不可枚举**：`ctx.credentials.list()` 不存在（`#L175`）；只有记录可枚举。
- **记录不校验 owner 是否挂载**：`listRecords()` 会列出已卸载插件留下的记录（`#L178`）。

### 5.5 结论：三条可行路径

| 做法 | 是否推荐 | 热更新 | 说明 |
|---|---|---|---|
| `ctx.credentials.set/unset`（服务端插件） | ✅ 首选 | 立即 | 官方语义，写盘 + 广播事件，改完下一次请求就生效 |
| 直接编辑 `.credentials.yaml` | ⚠️ 可行 | 立即（下次 `resolve` 现读） | 会被「观察到的外部编辑」识别并广播；但绕过品牌化校验，写坏 YAML 会让整个 refs 段解析失败 |
| 写用户环境变量 | ❌ 不推荐 | **不生效**（需重启），且被存储值遮蔽 | 环境变量变化不可观测，且优先级低于存储值 |

---

## 6. 版本与构建

### 6.1 客户端代码**必须**预构建成单文件

- 宿主只认 `lib/client.js`（由 `exports["./client"]` 指向），且必须是 `window.__ModuleLoader__.load({id, factory})` 形态；
  「宿主提供的是已构建的客户端 bundle……缺失 bundle 会明确导致激活失败」（`dsh-client-modules/README.zh.md#L55`）。
- 所有官方包与第三方插件无一例外都是这个形态（`dsh-web-search-pro/lib/client.js` 445 KB 单文件；`dsh-client-ui-settings-models/lib/client.js` 211 KB 单文件）。
- bundle 内的 `require(...)` 只允许命中 PLATFORM_MODULES（3.2）或自己在 `dsh.client.external` 声明的 id；`check-client-bundle.mjs` 就是这个校验的现成实现（`dsh-web-search-pro/scripts/check-client-bundle.mjs#L6-L13`，白名单恰好是 rc.3 时代的静态表子集）。

### 6.2 推荐构建链（照 bootstrap 思路，配置需自建）

`dsh-web-search-pro` 的 `build` 脚本是：`node scripts/clean-lib.mjs && tsc -p tsconfig.json && tsdown`，另有 `test:client-bundle`（`package.json#scripts`）。**它的 `tsdown.config.ts` 没有随包发布**（`files` 白名单不含），所以精确配置**未验证**；能确定的是产物约束：

1. 打包成 CJS-in-factory，外层包 `window.__ModuleLoader__.load({id: "<包名>", factory: (require) => {...}})`。
2. 所有静态表模块声明为 external（`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`.../dsh-client-store`、`.../dsh-client-ui-slots`、`.../dsh-client-ui-primitives` 等），运行期由 `require` 提供。
3. `id` 必须等于包名（浏览器模块身份：`dsh-client-modules/README.zh.md#L77`「解析出的 manifest 包名作为浏览器模块身份」）。
4. 产物里不要 `sourcesContent`（`check-client-bundle.mjs#L18` 断言 `'sourcesContent' in sourceMap === false`）。
5. 源码里可以用 tsdown 的 `import()` 分片 → 编译成 `require.async("./client.<name>.js")`，同目录带版本同级脚本才会被按需拉取（`#L38`）。

用 esbuild/tsup 自建等价物时，最小可用形态就是 3.1 里那段 wrapper：`banner` 写 `window.__ModuleLoader__.load({ id:` 与 `factory: (require) => { var module = { exports: {} }; var exports = module.exports;`，`footer` 写 `exports.name = ...; exports.inject = ...; exports.apply = ...; return module.exports; } });`，`format: 'cjs'`、`bundle: true`、`external: [静态表 + dsh.client.external]`。

### 6.3 纯 `.mjs` 手写客户端**不可行**（重要纠偏）

`@openviking/dsh-memory-plugin` 的 `client.mjs` **不是浏览器客户端插件**：它导出的是一个 HTTP 客户端类（`export class OpenVikingClient`），被**服务端** `index.mjs` 第 1 行 `import { OpenVikingClient } from "./client.mjs"` 引入使用；该包 `package.json` 里**没有 `dsh.client` 字段**，也没有 `__ModuleLoader__` bundle，即这个插件**完全没有浏览器 UI**。
证据：`@openviking/dsh-memory-plugin/package.json`（无 `dsh.client`）、`client.mjs#L3`（`export class OpenVikingClient`）、`index.mjs#L1`（服务端 import）。

→ 想有 UI，就必须产出 `__ModuleLoader__` 单文件 bundle；`.mjs` 只能用于**服务端**插件。

### 6.4 热更新 / HMR

- 客户端 bundle 变更**只能**通过 `rebuilt()`（HMR 钩子）进入启动图（`dsh-client-modules/README.zh.md#L77`）。
- revision 由入口的 `mtimeMs`/`ctimeMs`/大小派生（不是内容哈希），未变化的产物跨 Host 重启保持 revision（`#L79`）。
- 观测结论：改 `lib/client.js` 后浏览器是否自动换新，取决于 HMR 通道与 `rebuilt()` 是否被触发；**本机未实测**（未验证）。保守做法是改完重启 DSH 或刷新页面。

---

## 7. UI 注入点（slot）全量清单

以下名字由 `node slots-scan2.js` 从 asar 内**所有** `lib/client.js` 的真实 `ctx.slots.inject("…")` / `slots.register({name:"…"})` 提取，去重后 **103 个**（实测计数）。标注「常用」的是第三方插件最需要的。

### 7.1 最常用（第三方插件首选）

| slot | 形态 | 用途 | 参考实现 |
|---|---|---|---|
| `settings.section` | list（需 `id`） | **设置页新增一个分区**（左侧导航 + 右侧内容） | `settings-general#L1299`、`settings-models#L4485` |
| `settings.general.item` | list（需 `id`） | 「通用」分区里的**一行**（标题 + 描述 + 控件），最轻量 | `settings-general#L1079,L1095` |
| `settings.onboarding` | list（需 `id`） | 首次使用引导步骤 | `settings-models#L4502,L4508` |
| `settings.action` / `settings.trigger` / `settings.header` / `settings.close` | single/list | 设置面板的标题栏动作、打开触发、关闭按钮 | `settings-general#L1280-L1298` |
| `sidebar.settings` | 占位方（唯一） | 替换整个设置入口（开关壳） | `settings-general#L1186` |
| `plugins.bundle.config` | keyed | 插件详情页里的**配置卡片**（web-search-pro 用这个） | `web-search-pro/lib/client/index.js#L16-L21` |
| `plugins.tab` / `plugins.item` / `plugins.detail.section` / `plugins.detail.actions` / `plugins.detail.badge` | list/keyed | 插件管理页的 tab、条目、详情分区与动作 | `dsh-client-ui-settings-plugin-inventory`、`dsh-client-ui-plugin-manager` |
| `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title` | keyed（需 `key`） | 右侧栏**新增一个 tab**（内容 + 标题分开注册） | `sidebar-files#L1003-L1017` |
| `sidebar.panellist` / `sidebar.panellist.actions` | list | 左侧栏底部面板列表与动作 | `dsh-client-ui-plugin-manager`、`ui-sidebar` |
| `conversation.composer` | **`chain`**（需 `select`） | 接管/替换整个输入框区域：入口按 `priority` 顺序跑 `select(owner)`，第一个返回非 null 的当选，其返回值成为组件的 `matched` prop；全 null 落 owner 的 `fallback`。`index.d.ts#L245-L261` 明确写「the sole consumer is the `conversation.composer` chain」 | `dsh-client-ui-commands`、`ui-chat` |
| `conversation.composer.dock` | **`list`**（需 `id`+`order`） | 输入框下方的药丸条，**加按钮就用这个**（rc.5 实测：`dsh-client-ui-chat/lib/client.js` 在此注册 `activity`(order 0)、`usage`(order 1)，条目渲染成 `<button>`，`data-composer-stat` 携带 id，浮层按 Escape/点外面关闭） | `dsh-client-ui-chat` |
| `conversation.composer.bar` | list | 输入框**上方整条 bar**（与 `div[data-composer-bar]` 同级）：`renderSlot("conversation.composer.bar", { variant: hero ? "hero" : … })`，适合放横幅/状态条，不适合塞按钮 | `dsh-client-ui-chat`（`app.asar` 内 16 处引用） |
| `conversation.input.dock` | list | 输入框内的 dock 区，条目纵向堆叠（实测有插件在此 `ctx.slots.register`），窄而高，放短提示 | 第三方插件（`app.asar` 内 13 处引用） |
| `conversation.chat.node` | list/keyed | **自定义聊天消息卡片**（按消息类型接管渲染） | `dsh-client-ui-tool`、`ui-chat` |
| `tool.call.toolview` | keyed | 工具调用的**自定义渲染器**（按 tool 名选） | 多个包，见 `dsh-tools/README.zh.md#L95` |
| `shell.overlay` / `shell.bottom` / `shell.leading` | list | 全局浮层、外壳底部/前部 | `settings-general#L1319` |
| `root` | 唯一所有者 | 接管整个应用根（含产品布局）——**慎用** | `dsh-client-ui-layout`、`ui-renderer/README.zh.md#L32` |

### 7.2 其余可用 slot（按区域）

- **shell / 布局**：`main`、`main.conversation`、`shell.quota-notice`、`workspace.toast`
- **侧栏**：`sidebar`、`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.footer.action`、`sidebar.toggle.badge`、`sidebar.chat.conversation`、`sidebar.session.row.hover`、`sidebar.session.row.leading`、`sidebar.workspaces`、`sidebar.workspaces.directoryFlow`、`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`
- **右侧栏**：`rightbar`、`rightbar.session`、`sidebar.right.tab.document`（+ `.action` / `.actions` / `.office.pdf` / `.unpreviewable`）、`sidebar.right.tab.files.actions`、`sidebar.right.tab.guide`（+ `.actions` / `.entry`）、`sidebar.right.tab.menu.item`
- **会话**：`conversation.session`、`conversation.session.header`（+ `.actions` / `.corner` / `.lineage` / `.utilities` / `.views.actions`）、`conversation.header`（+ `.leading`）、`conversation.view`、`conversation.hero.agentPreset`、`conversation.hero.brand.mark`、`conversation.hero.options`、`conversation.hero.workspace`（+ `.directoryFlow`）
- **输入区**：`conversation.input.activity`、`.attachments`、`.left`、`.right`、`.model`、`.model.label`、`.permission`、`.plan`、`.overlay`
- **聊天内容**：`conversation.chat.assistant-actions`、`.commandview`、`.flow`、`.message.images`、`.reasoning.body`、`.turnTail`、`.user.images`、`conversation.user.text.node`、`conversation.trajectory.images`
- **审批 / 计划**：`conversation.approval.detail`、`conversation.plan-review.actions`
- **工具 / 交付物**：`tool.call.images`、`tool.view.cordis`、`deliverables.file.actions`、`deliverables.review.file.actions`
- **插件管理**：`plugins.add.actions`、`plugins.bundle.activation`、`plugins.row.config`
- **设置**：`settings.launcher`、`settings.models.provider-card`、`settings.models.footer`、`settings.models.sign-in`、`settings.plugins.tab`

> 完整去重清单（103 个）可直接用 `node %TEMP%\slots-scan2.js` 复现；每个 slot 的**精确 options 结构由声明方（owner 包）定义**，第三方只能照 owner 的用法填。反向查 owner：在 asar 里 grep `slots.register` + `declareSlot`。

---

## 8. 未验证 / 需要现场确认的点

1. **`tsdown.config.ts` 的精确配置**：`dsh-web-search-pro` 未随包发布该文件（`files` 白名单），第 6.2 节的 wrapper 形态是从产物逆推 + 官方 README 契约对齐的，不是官方配置原文。**未跑通一次真实构建**。
2. **`ui-primitives` 各组件的 props 签名**：本文 §3.6 里 `Button` 的 `variant`/`size`、`Switch` 的 `checked`/`onChange` **未按类型文件校正**。修法已确认可行：`npm i -D @deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.5` 后读 `lib/types/*.d.ts`。
3. **`dsh.client.external` 的真实用例**：本机 profile 里没有任何包用到该字段，机制说明仅来自 `dsh-client-modules/README.zh.md#L34,L51`，未实测。
4. **HMR 是否让新 bundle 免刷新生效**：`rebuilt()`/revision 机制有文档（`#L77,L79`），但本会话没有实测客户端 bundle 热替换。
5. **slot 声明方（owner）的准确清单**：本文的 slot 名来自真实注册点（103 个），但**每个 slot 的 `SlotMap` 声明（kind/scope/owner props 类型）分散在 owner 包的 `declare module` 里**，我未逐个提取。做新 UI 前请先 `grep -r "declare module '@deepseek-ai/dsh-client-ui-slots'" ` 找到 owner 的 `.d.ts`。
6. **Component Factory / `registerFactory` 全套**：`index.d.ts#L526-L538,L317-L341` 有完整契约（`renderFactorySlot`、`useFactorySlot`、`FactoryLocalSlotDef`、occurrence store），本文未展开，只覆盖普通 entry 注册。
7. **`session` / `session-maybe` scope 的会话数据座位**：由 `ui-session` 包合并进 `SessionStandardProps`（本文表格未列其成员），用到会话数据的插件需另读 `dsh-client-ui-session` 的声明。
