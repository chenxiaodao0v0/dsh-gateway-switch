# DSH 网关密钥切换器

给 DeepSeek Harness（DSH Desktop）加一个原生设置页：**在「设置 → 插件 → 网关密钥」里一键切换 OpenViking Gateway Key，切换后下一次请求立即生效，不需要重启。**

原方案是改用户环境变量 `OPENVIKING_GATEWAY_KEY` + 重启客户端才生效（见团队经验「dsh 接入 OpenViking 网关配置」）。这个插件把它变成点一下开关。

---

> **DSH 0.2.2+ 兼容说明**：从 0.2.3 起，插件改用共享 `/api` RPC 通道
> （`connection.rpc.intercept('/api', ...)`，URL 形如 `/api/gateway-switch/state`）。
> 旧版插件用私有通道 `/gateway-switch` 注册，在 DSH 0.2.2+ 上会报
> `transport failure for /gateway-switch/state: HTTP 405`（私有 prefix 路由对 POST
> 会落到静态资源兜底）。升级到 0.2.3 即可修复；`engines.dsh` 已声明 `>=0.2.2`。

## 它长什么样

```
设置 → 插件 → 网关密钥

┌────────────────────────────────────────────────────────────┐
│ 网关密钥                                                    │
│ 切换后下一次请求就生效，不需要重启 DSH。                        │
│ 凭据引用：OPENVIKING_GATEWAY_KEY · 网关：http://localhost:1933/gateway │
├────────────────────────────────────────────────────────────┤
│ ● 已配置  ovgw_Ee-V…    （来自列表：个人 alice）  [测试当前] [刷新]  │
├────────────────────────────────────────────────────────────┤
│ ( ●)  个人 alice        ovgw_Ee-V…            [测试] [删除]  │
│ (  )  公司 company      ovgw_dQquSw…          [测试] [删除]  │
├────────────────────────────────────────────────────────────┤
│ 添加一把密钥                                                 │
│ [名称，例如「个人 alice」] [粘贴 ovgw_... 或 sk-...]  [保存]    │
└────────────────────────────────────────────────────────────┘
```

- 开关 = 热切换。左边亮着的那把就是当前生效值。
- 「测试」用那把 key 打一次网关 `/v1/models`，只回报状态码与模型数。
- 界面上的 key 永远是掩码（`ovgw_Ee-V…`），明文只落在本机文件里，不回传浏览器。

### 输入框里的两枚药丸

同一个插件注册两枚药丸，各占一个 slot，**不放在同一处**：

| 药丸 | 位置 | slot | 交互 |
| --- | --- | --- | --- |
| 网关 | 输入框右侧、模型切换的紧左边 | `conversation.input.right` | 显示当前 key 在网关里的名字，可点开浮层切换 |
| 记忆 | 统计药丸那一排（缓存命中、tokens 旁边） | `conversation.composer.dock` | 只读，`记忆 随<当前 key 名>`，颜色表达归属 |

尺寸与配色对齐宿主自带的统计药丸（24px 高、999 圆角、12/18 字号、`--dsw-alias-bg-layer-2` 底）：

```
  [发送]        ● 研发团队 ▴   [模型切换]      12.3k tokens ● 记忆 随研发团队
────────────────────────────────────────────────────────────────────────────────────
点开后（向上弹出，Escape / 点外面即关闭）：

        ╭────────────────────────────────────────╮
        │ 网关密钥                     身份 陈嘉帅 ⇄ │
        ├────────────────────────────────────────┤
        │ 个人  陈嘉帅 · 本地默认…    ovgw_ZgoE…  │
        │ 研发团队                    ovgw_-dCr… ✓│
        ├────────────────────────────────────────┤
        │            ＋ 加入团队                  │
        │ 切换后下一次请求即生效，不用重启         │
        ╰────────────────────────────────────────╯
```

列表里**个人那条永远排第一**：当前用着团队 key 时，点个人那条就切回个人 gateway（记忆跟着回到自己的账号），
团队与个人可以随时来回切。右上角的「身份 陈嘉帅 ⇄」是同一件事的换绑入口。

点「+ 加入团队」会展开一个输入框：粘贴团队发给你的 `ovgw_…`，回车或点「加入」即可。
插件会用随包的服务凭证反查这把 key 在网关里的名字，自动命名并**直接切换**过去——不用去设置页，
也不用自己起名字。反查不到（离线/不同实例）就以 `未命名 ovgw_xxx…` 落库，功能不受影响。

### 个人 key 是前提，团队 key 才谈得上回流

密钥环里每一条都有角色：**恰好一条 `personal`（你的个人身份），其余全是 `team`**。

- 没绑个人 key 时，面板只显示引导，不给「加入团队」入口——团队记忆要回流到谁家，插件必须先知道；
- 绑定/换绑后，团队入口才出现；换绑时旧的那把自动降级成普通团队 key，不会留下两个个人身份；
- 首次安装如果 DSH 的 `OPENVIKING_GATEWAY_KEY` 里已经有一把 `ovgw_…`，插件**自动认作个人 key**
  （成员在装插件前通常已经用它联网了），认错了就在面板里点「换绑」。

### 加入团队 = 自动登记回流关系

加入成功后，插件把「个人 key + 团队 key」POST 给共享记忆控制台
（`POST /api/team/join`，地址由 `syncBaseURL` 配置）：

```
控制台用只读的 /gateway/admin/keys 反查两把 key
  → 个人 key 得到 alice，团队 key 得到 TeamRD
  → 写 team_members(团队, alice)，并把团队绑到 memory_user=TeamRD
```

控制台只存 `user_id` 和 key 的指纹（sha256 前 16 位），**不存 key 本身**。
登记不上（控制台没开、团队还没建）不阻塞使用，插件把这次登记排队，下次打开面板自动重试；
面板上会写「回流登记待确认」。

`网关` 那枚显示的是**这把 key 的名字**：优先用网关侧起的名字；成员机器上没有网关管理凭证，
就改由控制台 `/api/identity/resolve` 反查（名字+user_id，不回 key）。加入团队成功后，
标签还会被换成控制台里这个团队的正式名字。原始说明：（例如 `研发团队`、`陈嘉帅 · 本地默认客户端`），
不是自己填的别名：插件拿 `sha256(key)` 去 `/gateway/admin/keys` 精确匹配后取 `name`，查不到才退回掩码。
所以成员加入团队只需要把 key 粘进设置页，不用起名——名字在签发时就定好了。

圆点绿色=已配置、灰色=未配置。`记忆` 那枚：绿色 `随key` = 网关按 key 归属记忆，
黄色 `记忆 <用户名>` = 记忆插件在场、身份固定在 `ovcli.conf`（此时切 key 不改变记忆空间）。
添加/删除/测试仍在设置页。


---

## 为什么切换不用重启

DSH 的凭据 seam 规定消费方**按操作解析**密钥，没有跨请求缓存——官方原文：

> 需要该密钥的请求使用它当前存储的值，因此轮换密钥会作用于紧随其后的下一次请求——无需重启，无需改配置。
> —— `@deepseek-ai/dsh-credentials` README.zh.md 第 91 行

所以插件只做 `ctx.credentials.set('OPENVIKING_GATEWAY_KEY', key)`，不发任何重启信号，也不改 `cordis.patch.yml`。

---

## 安装

### 方式零（推荐）：从 GitHub 安装（公开仓库，零配置）

桌面端 **设置 → 插件 → 添加插件**，输入框填：

```text
https://github.com/chenxiaodao0v0/dsh-gateway-switch
```

或命令行：

```powershell
dsh plugin --profile desktop add https://github.com/chenxiaodao0v0/dsh-gateway-switch
```

装完**重启一次 DSH**。不需要 GitHub 账号、不需要配 SSH key、不需要控制台 token。
`.git` 后缀可加可不加，两种写法 pnpm 都能解析（实测 pnpm 11.28.5）。

注意：插件同步的目标控制台默认是 `http://192.168.10.4:8765`，所以**同事需要能访问这台内网机器**；
装上了但加团队失败，通常是这个原因，可用环境变量 `DSH_SYNC_URL` 换成自己的控制台地址。

### 方式一：从内网 GitLab 安装（内网镜像）

插件自己声明了 `dsh.bundle.patch`，所以用 DSH 自带的插件安装通道就能装，不需要拷文件、不需要改 package.json：

```powershell
# CLI
dsh plugin --profile desktop add git+https://<gitlab-host>/<group>/dsh-gateway-switch.git
```

或桌面端 **设置 → 插件 → 安装第三方插件**，把上面的 git 地址粘进输入框。
DSH 会把它装进 `profiles/desktop/node_modules`，并自动加进 `dsh.profile.bundles`（即自动启用）。

**装完不需要填任何配置**：控制台地址已内置在包内 `cordis.patch.yml`（团队默认
`http://192.168.10.4:8765`，需要换地址时用环境变量 `DSH_SYNC_URL` 覆盖），
登记回流也不需要控制台 token —— `/api/team/join` 只认「你贴的 key 能反查到本账号的用户」，
控制台其余接口仍然要 token，但不对外发放。装完**重启一次 DSH** 即可。

私服/私有仓库要凭据时，git 地址可以带 token 或改用 ssh：
`git+https://oauth2:<PAT>@<gitlab-host>/...`、`git+ssh://git@<gitlab-host>:22/...`。

### 方式二：脚本（本地开发自测用）

```powershell
# 装进当前 DSH profile（读 DSH_PROFILE_DIR 环境变量）
node scripts/install.mjs

# 或指定 profile
node scripts/install.mjs --profile "C:\Users\<you>\.dsh\profiles\desktop"

# 只看看要改什么
node scripts/install.mjs --profile "..." --dry-run

# 卸载
node scripts/install.mjs --profile "..." --uninstall
```

脚本做三件事，改之前先把 `package.json` 备份成 `package.json.bak-dsh-plugin-gateway-switch-<时间戳>`：

1. 复制插件到 `<profile>/node_modules/dsh-plugin-gateway-switch`
2. `dependencies` 里登记 `file:` 依赖
3. 把包名追加进 `dsh.profile.bundles`（这一步才是「启用」）

装完**重启一次** DSH Desktop，之后切换 key 就都不用再重启了。

### 灌入已有的本地 key

从本机 `~/.openviking/local-key-inventory.md` 解析（**只读本机文件，不联网**）：

```powershell
node scripts/seed-keys.mjs                      # 只灌「我自己」+「当前生效的那把」
node scripts/seed-keys.mjs --user Lisen_Zhang    # 再指定几个（可重复）
node scripts/seed-keys.mjs --all-local           # 本地清单全部 19 个
node scripts/seed-keys.mjs --dry-run             # 只看会加什么
```

默认**不灌同事的 key**：把它们塞进切换 UI，等于让「误点一下就以别人身份请求网关」变成一次点击的成本。要灌就显式 `--all-local` 或 `--user`。


### 方式二：手工

1. 把本目录整个复制到 `<profile>/node_modules/dsh-plugin-gateway-switch`
2. 编辑 `<profile>/package.json`，在 `dsh.profile.bundles` 数组里加一项 `"dsh-plugin-gateway-switch"`
3. 重启 DSH Desktop

---

## 配置

`cordis.patch.yml` 里的可选项，省略就用默认值：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `credentialRef` | `OPENVIKING_GATEWAY_KEY` | 被切换的凭据引用名，**必须和 provider 里 `apiKeyEnv` 写的名字一致** |
| `gatewayBaseURL` | `http://localhost:1933/gateway` | 网关根地址（不含 `/v1`）：探活与反查 key 名字都走它 |
| `adminKey` | 空 | 反查 key 名字用的只读凭证（内联写法，优先级最高） |
| `adminKeyRef` | 空 | 同上，但写 DSH 凭据引用名，不把明文放进配置 |
| `adminKeysFile` | `<插件目录>/team-admin.json` | 随插件分发的管理凭证文件，0600，已被 `.gitignore` 排除 |
| `ovConfPath` | `~/.openviking/ov.conf` | 兜底：前三级都拿不到时读本机 OV 根凭证 |
| `ovAccount` | `demo` | 反查名字时指定的 OV 账号 |

透传 provider 的对应写法（`profiles/<name>/cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openviking:
        apiKeyEnv: OPENVIKING_GATEWAY_KEY   # ← 插件切的就是它
        api: openai-completions
        baseURL: http://localhost:1933/gateway/v1
```

---

### 名字从哪来

药丸显示的名字不是本地别名，而是 key 在网关侧的 `name`。反查走 `GET /gateway/admin/keys`，
按 `sha256(key)` 与返回列表的 `id` 精确比对；比对不上就退回 `未命名 ovgw_xxxx…`。

凭证按优先级取，成员机器上通常走第三条：

1. `config.adminKey`（写在 `cordis.patch.yml` 里）
2. `config.adminKeyRef`（指向 DSH 凭据，配置里不留明文）
3. **`<插件目录>/team-admin.json`** —— 安装时用 `--admin-key` 注入，随包落到成员机器
4. `~/.openviking/ov.conf` 的 `root_api_key`（仅限装了 OV 的机器，给管理员自己兜底）

前一把查不到就顺延下一把，所以成员机器只用第 3 条，管理员机器还能靠第 4 条看到全部名字。

**封装（按你能接受的最小面来做）**：

- 凭证是 TeamRD 的 user key，`can_issue_for_others: false`，只能列自己那把「研发团队」；
- 文件必须显式写 `scope: "read-only"`，写成别的值（例如误塞 root key 标成 admin）插件直接拒绝加载；
- 未导出、不进 `state`、不进 RPC、不进 trace、不进报错文案——测试里有一条专门抛异常验证凭证不会随错误漏出；
- Windows 上安装器自动 `icacls /inheritance:r` 并把权限收到仅当前用户可读。

**唯一出口**是 `fetchKeyCatalog()`，里面写死
`GET {gatewayBaseURL}/admin/keys`，无请求体、不跟随重定向、超时固定；
调用方拿不到改方法或换路径的手段。测试里对这三项都有断言，谁想加写操作就得改这段代码本身。

文件内的 `scope` / `allowed` / `forbidden` / `warning` 字段是给人和大模型看的显式约束。

```bash
# 成员加入团队：装插件时把团队管理 key 一起注入，之后粘贴 gateway key 即可自动显示团队名
node scripts/install.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --admin-key "ZGVtbw.xxxx..."
```

`team-admin.json` 默认 0600（Windows 上安装脚本会把 ACL 收紧到仅当前用户可读）、不进仓库。
里面放的是**专用服务身份 `svc-keydir`**（demo 账号的 admin），不借用任何人的身份，可单独轮换或吊销。

为什么不放普通用户 key：OV 的普通用户只能看到自己名下那把 key，成员加入“另一个团队”时名字就查不到了——
要覆盖任意新团队，凭证必须有账号级读权限。实测 `svc-keydir` 能读到 demo 下 27 把 key、覆盖 21 个用户。

代价写在明处：OV 没有只读角色，账号级读权限必然附带 `can_issue_for_others: true`，也就是理论上有签发/删除 key
和改策略、上游的能力。它不是 root（不能跨账号），但也不是“只能读”。约束靠三层挡：代码单出口、
文件 `scope` 声明校验、磁盘 ACL；要彻底消除，只有给网关加 `/v1/whoami`。

## 安全边界

| 事项 | 做法 |
| --- | --- |
| 候选密钥存哪 | `$DSH_HOME/gateway-switch/keys.json`，权限 `0600`，**不进 settings 文档**（那是会被渲染、被同步的配置） |
| 明文回传界面？ | 不回传。`state` 只给前 9 字符掩码；添加接口是单向写入 |
| 日志 | 不打密钥 |
| 凭据写入 | 走官方 `ctx.credentials.set()`，不手工改 `.credentials.yaml` |
| 控制台 token | **不下发给成员**。插件只用两个免 token 的接口：`/api/team/join`（登记回流）和 `/api/identity/resolve`（把 key 换成名字）；两者都只认「你贴的 key 在账号里」，且都不回 key 本身。控制台其余接口仍要 token，只有管理员持有 |

注意：`keys.json` 与 DSH 自己的 `.credentials.yaml` 一样是**本机明文**文件，请按敏感文件对待（不要提交到 git）。

---

## 验证

```powershell
node --test test/*.test.mjs    # 18 个用例
```

覆盖到：

- `test/server.test.mjs`：密钥环增删、只返回掩码、`activate` 确实调 `credentials.set`、探活解析、失败一律作为返回值而不抛异常、原型链名字不被当 endpoint。
- `test/client-bundle.test.mjs`：bundle 的 `id` 是包名、factory 只请求基座模块 `react`、导出 `name/inject/apply`、`apply` 正确注册到 `plugins.item` slot。
- `test/render.test.mjs`：用假 React 真跑一遍渲染，验证结构、空状态文案、开关的 `role=switch`/`aria-checked`/回调与禁用态。

未覆盖（需要真机）：宿主加载后的视觉效果、真实 `connection.rpc` 往返。这两项只能在重启后的 DSH 里看到。

---

## 目录

```
index.js                 服务端：密钥环 + 探活 + RPC 通道
client.js                浏览器侧：预构建 bundle（window.__ModuleLoader__.load 格式）
cordis.patch.yml         插件自带的 patch 层
scripts/install.mjs      安装/卸载器（带备份、支持 --dry-run）
scripts/seed-keys.mjs    从本机 local-key-inventory.md 灌入 gateway key（默认只灌自己）
docs/dsh-client-plugin-api.md  DSH 客户端插件 API 速查（研究产出，含 103 个 slot 清单）
test/                    18 个用例
```

---

## 已知限制

- `plugins.item` 页面注册沿用了官方 web-search 设置页的写法；若某天 slot 契约变化，页面会以「激活失败」出现在「设置 → 插件」里，而不是静默消失。
- 探活只验网关鉴权；**透传模式的上游密钥**（`X-OpenViking-Upstream-Key`）不在本插件管辖范围，仍写在 provider 的 headers 里。
- 切换只影响被 `credentialRef` 点名的那一个引用；记忆插件（`@openviking/dsh-memory-plugin`）走的是它自己的凭证链，不受影响。
