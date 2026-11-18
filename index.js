/**
 * gateway-switch —— 服务端半侧
 *
 * 作用：把「多把 OpenViking Gateway Key」管起来，并支持一键把其中一把写进 DSH 的凭据引用
 * （provider 里 `apiKeyEnv` 指向的那个名字，默认 `OPENVIKING_GATEWAY_KEY`）。
 *
 * 为什么切换不需要重启：
 *   DSH 的凭据 seam 规定消费方「按操作解析」（见 @deepseek-ai/dsh-credentials 文档：
 *   「需要该密钥的请求使用它当前存储的值，因此轮换密钥会作用于紧随其后的下一次请求」）。
 *   所以我们只做 `credentials.set(ref, value)`，不发任何重启信号。
 *
 * 安全约束（刻意的）：
 *   - 客户端永远拿不到明文密钥，`state` 只返回掩码前后缀。
 *   - 候选密钥不写进 settings 文档（那是会被渲染、被同步的配置），而是独立落到
 *     `$DSH_HOME/gateway-switch/keys.json`，文件权限 0600。
 *   - 日志里不打印密钥。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'gateway-switch'
export const inject = ['credentials']

/** 浏览器与宿主之间的私有 RPC 通道前缀（绝对路径，由 connection 传输鉴权）。 */
export const CHANNEL = '/gateway-switch'

const DEFAULT_CREDENTIAL_REF = 'OPENVIKING_GATEWAY_KEY'
const DEFAULT_GATEWAY_BASE = 'http://localhost:1933/gateway'
const PROBE_TIMEOUT_MS = 8000

/** 反查 key 名字用的 OV 根凭证与账号；默认值对应本机 Docker 单机部署。 */
const DEFAULT_OV_CONF = join(homedir(), '.openviking', 'ov.conf')
const DEFAULT_OV_ACCOUNT = 'demo'

/** 随插件分发的取名凭证文件（只用于反查 key 名字，0600，不进仓库）。 */
const ADMIN_KEY_FILE = 'team-admin.json'

/**
 * 取名凭证的唯一出口：只允许 `GET {gatewayBaseURL}/admin/keys`。
 * 方法、路径、无 body、不跟随重定向都在 fetchKeyCatalog 里写死，调用方无法改。
 */
const LOOKUP_METHOD = 'GET'
const LOOKUP_PATH = '/admin/keys'

/** 记忆插件在 profile 里的 bundle 名：出现即代表「插件在管记忆」。 */
const MEMORY_PLUGIN = '@openviking/dsh-memory-plugin'

/** DSH 主目录：优先 DSH_HOME，否则 ~/.dsh。 */
function dshHome(env = process.env) {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
}

/** 密钥环文件位置：跟随 DSH_HOME，缺省落 ~/.dsh。 */
export function storePathFor(env = process.env) {
  return join(dshHome(env), 'gateway-switch', 'keys.json')
}

/** `ZGVtbw.YWxpY2U.<sig>`（user key）→ `{ account, user }`；解不出来返回 null。 */
export function decodeUserKey(key) {
  if (typeof key !== 'string') return null
  const [account, user] = key.split('.')
  if (!account || !user) return null
  const read = (part) => {
    try {
      return Buffer.from(part, 'base64').toString('utf8')
    } catch {
      return ''
    }
  }
  const a = read(account)
  const u = read(user)
  return /^[\w.-]+$/.test(a) && /^[\w.-]+$/.test(u) ? { account: a, user: u } : null
}

/**
 * 记忆归属判定（两条通道互斥，见 TEAM-MEMORY-SCHEME.md §4.5）：
 *   - 插件在场：身份固定在 `ovcli.conf`，切 gateway key 不改变记忆空间；
 *   - 插件不在场：网关按 gateway key 的 user 归属，切 key 即切空间。
 */
export function memoryStatus({ plugin = false, userKey = '' } = {}) {
  const who = decodeUserKey(userKey)
  if (plugin) {
    return {
      mode: 'plugin',
      user: who ? who.user : null,
      account: who ? who.account : null,
      hint: '记忆由插件记录，身份固定在 ovcli.conf，切 key 不改变记忆空间',
    }
  }
  return {
    mode: 'gateway',
    user: null,
    account: null,
    hint: '记忆随 gateway key 归属；只有选用 openviking 供应商的模型才会记录',
  }
}

/** 只给 UI 看的掩码：保留前 9 个字符（`ovgw_Ee-V`），其余一律不外露。 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return ''
  return key.slice(0, 9) + '…'
}

function readStore(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter(item => item && typeof item.id === 'string' && typeof item.key === 'string')
      : []
    const nextId = Number.isInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : items.length + 1
    const personalId = typeof parsed.personalId === 'string' ? parsed.personalId : ''
    return { nextId, items, personalId, pendingJoins: Array.isArray(parsed.pendingJoins) ? parsed.pendingJoins : [] }
  } catch {
    return { nextId: 1, items: [], personalId: '', pendingJoins: [] }
  }
}

function writeStore(file, store) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * 纯逻辑层：不碰 Cordis，方便单测。
 * @param {object} options
 * @param {object} options.config 插件 config（cordis.patch.yml 里的那一块）
 * @param {object} options.credentials DSH 凭据服务（resolve/describe/set/unset）
 * @param {string} [options.storePath] 密钥环文件路径
 * @param {Function} [options.fetchImpl] 测试可注入的 fetch
 */
export function createHandlers({ config = {}, credentials, storePath, fetchImpl } = {}) {
  const credentialRef = String(config.credentialRef || DEFAULT_CREDENTIAL_REF)
  const gatewayBaseURL = String(config.gatewayBaseURL || DEFAULT_GATEWAY_BASE).replace(/\/+$/, '')
  const file = storePath || storePathFor()
  const doFetch = fetchImpl || globalThis.fetch
  const ovcliPath = String(config.ovcliPath || join(homedir(), '.openviking', 'ovcli.conf'))
  const profileDir = String(config.profileDir || join(dshHome(), 'profiles', 'desktop'))
  const ovConfPath = String(config.ovConfPath || DEFAULT_OV_CONF)
  const adminKeysFile = String(
    config.adminKeysFile || join(dirname(fileURLToPath(import.meta.url)), ADMIN_KEY_FILE),
  )
  const ovAccount = String(config.ovAccount || DEFAULT_OV_ACCOUNT)
  // 地址与 token 的优先级：显式配置 > 环境变量（团队可用环境变量统一注入，机器上不留口令文件）
  const syncBaseURL = String(config.syncBaseURL || process.env.DSH_SYNC_URL || '').replace(/\/+$/, '')
  const syncToken = String(config.syncToken || process.env.DSH_SYNC_TOKEN || '')
  /** key 名字缓存：sha256(key) → name。名字是网关侧的事实，本进程生命周期内复用即可。 */
  const keyNames = new Map()
  /** 目录缓存：sha256(凭证) → key 列表。避免每次添加都重新拉一遍。 */
  const keyCatalog = new Map()

  function memoryPluginInstalled() {
    try {
      const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      const bundles = (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
      return Array.isArray(bundles) && bundles.includes(MEMORY_PLUGIN)
    } catch {
      return false
    }
  }

  function ovcliUserKey() {
    try {
      const conf = JSON.parse(readFileSync(ovcliPath, 'utf8'))
      return conf && typeof conf.api_key === 'string' ? conf.api_key : ''
    } catch {
      return ''
    }
  }

  async function currentValue() {
    try {
      const hit = await credentials.resolve(credentialRef)
      return hit && typeof hit.value === 'string' ? hit.value : ''
    } catch {
      return ''
    }
  }

  /** OV 根凭证：网关管理接口 `/admin/keys` 需要它才能看全账号下的 key。 */
  function ovRootKey() {
    try {
      const conf = JSON.parse(readFileSync(ovConfPath, 'utf8'))
      return conf && conf.server && typeof conf.server.root_api_key === 'string' ? conf.server.root_api_key : ''
    } catch {
      return ''
    }
  }

  /**
   * 读随插件分发的取名凭证文件。
   * 只接受显式声明 `scope: "read-only"` 的文件（没有 scope 视为旧格式、也接受），
   * 声明成别的用途（例如误塞一把 root key 并标成 scope: "admin"）一律拒绝加载。
   */
  function readLookupFile() {
    try {
      const parsed = JSON.parse(readFileSync(adminKeysFile, 'utf8'))
      const scope = parsed && typeof parsed.scope === 'string' ? parsed.scope.trim() : ''
      if (scope && scope !== 'read-only') return []
      const value = parsed && typeof parsed.adminKey === 'string' ? parsed.adminKey.trim() : ''
      return value ? [value] : []
    } catch {
      return []
    }
  }

  /**
   * 反查名字可用的凭证，按「权限从小到大」排：
   *   config.adminKey → adminKeyRef 凭据 → 插件目录 team-admin.json → 本机 ov.conf 根凭证。
   * 前一把查不到就顺延下一把：成员机器通常只带 team-admin.json，管理员机器还能用根凭证兜底。
   */
  async function lookupCredentials() {
    const found = []
    if (typeof config.adminKey === 'string' && config.adminKey.trim()) found.push(config.adminKey.trim())
    const ref = String(config.adminKeyRef || '')
    if (ref) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit && typeof hit.value === 'string' && hit.value.trim()) found.push(hit.value.trim())
      } catch {
        // 凭据不存在就继续往下找
      }
    }
    for (const credential of readLookupFile()) found.push(credential)
    const root = ovRootKey()
    if (root) found.push(root)
    return [...new Set(found)]
  }

  /**
   * 取名凭证唯一的请求出口。这里刻意不给调用方任何自由度：
   * 方法固定 GET、路径固定 `/admin/keys`、无请求体、不跟重定向、超时固定。
   * 想加任何写操作都必须改这段代码，改不了就只能换凭证。
   */
  async function fetchKeyCatalog(credential) {
    const cacheId = createHash('sha256').update(credential).digest('hex')
    if (keyCatalog.has(cacheId)) return keyCatalog.get(cacheId)
    if (LOOKUP_METHOD !== 'GET' || LOOKUP_PATH !== '/admin/keys') {
      // 护栏：取名凭证只许读 key 目录，方法或路径被改动就一个请求都不发。
      return []
    }
    const response = await doFetch(
      `${gatewayBaseURL}${LOOKUP_PATH}?account_id=${encodeURIComponent(ovAccount)}`,
      {
        method: LOOKUP_METHOD,
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    )
    if (!response.ok) return []
    const parsed = JSON.parse(await response.text())
    const list = Array.isArray(parsed) ? parsed : []
    keyCatalog.set(cacheId, list)
    return list
  }

  /**
   * 按 key 反查它在网关里的名字（`name` 字段，如「研发团队」）。
   * 管理接口按 `sha256(key)` 存 id，命中即精确；解析不出来返回 null，由调用方降级成掩码。
   */
  /**
   * 控制台的身份反查：成员机器上没有网关 admin 凭证，但控制台有。
   * `POST {syncBaseURL}/api/identity/resolve` 只回名字与 user_id，不回 key 本身。
   */
  async function consoleIdentity(key) {
    if (!syncBaseURL) return null
    try {
      const response = await doFetch(`${syncBaseURL}/api/identity/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(syncToken ? { 'X-Console-Token': syncToken } : {}),
        },
        body: JSON.stringify({ keys: [key] }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
      })
      if (!response.ok) return null
      const body = await response.json()
      const item = Array.isArray(body && body.items) ? body.items[0] : null
      if (!item) return null
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      const userId = typeof item.user_id === 'string' ? item.user_id.trim() : ''
      if (!name && !userId) return null
      return { name, userId }
    } catch {
      return null
    }
  }

  async function resolveKeyName(key) {
    const digest = createHash('sha256').update(key).digest('hex')
    if (keyNames.has(digest)) return keyNames.get(digest)
    for (const credential of await lookupCredentials()) {
      let list = []
      try {
        list = await fetchKeyCatalog(credential)
      } catch {
        continue
      }
      const hit = list.find(entry => entry && entry.id === digest)
      if (!hit) continue
      const name = typeof hit.name === 'string' ? hit.name.trim() : ''
      if (!name) continue
      keyNames.set(digest, name)
      return name
    }
    const consoleHit = await consoleIdentity(key)
    if (consoleHit && consoleHit.name) {
      keyNames.set(digest, consoleHit.name)
      return consoleHit.name
    }
    return null
  }

  /**
   * 反查一把 key 在网关里的身份：名字 + 所属 user_id。
   * 和取名共用同一套只读出口，不额外增加任何写能力。
   */
  async function resolveKeyIdentity(key) {
    const digest = createHash('sha256').update(key).digest('hex')
    for (const credential of await lookupCredentials()) {
      let list = []
      try {
        list = await fetchKeyCatalog(credential)
      } catch {
        continue
      }
      const hit = list.find(entry => entry && entry.id === digest)
      if (hit) {
        return {
          name: typeof hit.name === 'string' ? hit.name.trim() : '',
          userId: typeof hit.user_id === 'string' ? hit.user_id.trim() : '',
        }
      }
    }
    return consoleIdentity(key)
  }

  function personalItem(store) {
    return store.items.find(item => item.role === 'personal') || null
  }

  /** DSH 里 provider 已配的那把 key：成员装插件前往往已经用它联网了。 */
  async function detectedKey() {
    const value = await currentValue()
    if (!/^ovgw_/.test(value)) return ''
    const store = readStore(file)
    if (store.items.some(item => item.key === value)) return ''
    return value
  }

  /** 没绑个人 key 时，尝试用 provider 里已有的那把自动绑定（可被用户换掉）。 */
  async function autoBindFromProvider() {
    const store = readStore(file)
    if (personalItem(store)) return false
    const value = await detectedKey()
    if (!value) return false
    const identity = await resolveKeyIdentity(value)
    if (!identity) return false
    const personal = { id: `k${store.nextId}`, label: identity.name || `未命名 ${maskKey(value)}`, key: value, role: 'personal' }
    store.nextId += 1
    store.items.push(personal)
    store.personalId = personal.id
    writeStore(file, store)
    return true
  }

  async function state() {
    let store = readStore(file)
    if (!personalItem(store) && (await autoBindFromProvider())) store = readStore(file)
    const current = await currentValue()
    let info = {}
    try {
      info = (await credentials.describe(credentialRef)) || {}
    } catch {
      info = {}
    }
    const activeItem = current.length > 0 ? store.items.find(item => item.key === current) : null
    const personal = personalItem(store)
    return {
      credentialRef,
      gatewayBaseURL,
      probeURL: gatewayBaseURL + '/v1/models',
      configured: current.length > 0,
      source: info.source ?? null,
      writable: info.writable !== false,
      activePrefix: maskKey(current),
      activeLabel: activeItem ? activeItem.label || null : null,
      memory: memoryStatus({ plugin: memoryPluginInstalled(), userKey: ovcliUserKey() }),
      needPersonal: !personal,
      detected: personal ? null : Boolean(await detectedKey()),
      personal: personal
        ? { id: personal.id, label: personal.label || personal.id, prefix: maskKey(personal.key) }
        : null,
      pendingJoins: store.pendingJoins.length,
      sync: { configured: Boolean(syncBaseURL), pending: store.pendingJoins.length },
      items: store.items.map(item => ({
        id: item.id,
        label: item.label || item.id,
        prefix: maskKey(item.key),
        role: item.role === 'personal' ? 'personal' : 'team',
        active: current.length > 0 && item.key === current,
      })),
    }
  }

  /**
   * 把「个人 key + 团队 key」登记到控制台，让定时回流知道把 TeamRD 的记忆搬到谁家。
   * 只是登记，不做任何记忆读写；失败不阻塞使用，进待登记队列下次再试。
   */
  async function registerJoin() {
    if (!syncBaseURL) return null
    const store = readStore(file)
    const personal = personalItem(store)
    if (!personal) return null
    const teamKeys = store.items.filter(item => item.role !== 'personal').map(item => item.key)
    if (teamKeys.length === 0) return null
    try {
      const response = await doFetch(`${syncBaseURL}/api/team/join`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(syncToken ? { 'X-Console-Token': syncToken } : {}),
        },
        body: JSON.stringify({ personal_key: personal.key, team_keys: teamKeys }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      let body = {}
      try {
        body = await response.json()
      } catch {
        body = {}
      }
      const fresh = readStore(file)
      fresh.pendingJoins = []
      writeStore(file, fresh)
      // teams/missing 只带团队名与指纹，不带 key；插件据此把标签改成团队名
      return { ok: true, teams: body.teams || [], missing: body.missing || [], personalLabel: body.personal_label || '' }
    } catch (error) {
      const fresh = readStore(file)
      fresh.pendingJoins = [...fresh.pendingJoins, { at: Date.now(), reason: String(error?.message ?? error).slice(0, 200) }].slice(-20)
      writeStore(file, fresh)
      return { ok: false, pending: true, reason: String(error?.message ?? error) }
    }
  }

  async function sync(payload = {}) {
    return registerJoin()
  }

  async function activate(payload = {}) {
    const store = readStore(file)
    const item = store.items.find(entry => entry.id === payload.id)
    if (!item) throw new Error(`没有这个密钥：${payload.id}`)
    await credentials.set(credentialRef, item.key)
    return state()
  }

  /**
   * 存一把 key：名字不让人填，一律按网关侧的名字自动命名（成员加入团队只要贴 key）。
   * 反查失败（离线 / 没有根凭证）就降级成掩码标签，仍然可用。
   */
  /**
   * 绑定个人 key：团队记忆回流的落点。换绑时旧的那把降级成普通团队 key。
   */
  async function bindPersonal(payload = {}) {
    const key = String(payload.key || '').trim()
    if (key.length < 8) throw new Error('密钥看起来太短，请粘贴完整的 Gateway Key')
    if (/\s/.test(key)) throw new Error('密钥里不能有空白字符')
    const store = readStore(file)
    const identity = await resolveKeyIdentity(key)
    const existing = store.items.find(entry => entry.key === key)
    const personal = personalItem(store)
    if (personal && personal.key === key) {
      await credentials.set(credentialRef, key)
      return state()
    }
    let item = existing
    if (!item) {
      item = { id: `k${store.nextId}`, label: identity?.name || `未命名 ${maskKey(key)}`, key }
      store.nextId += 1
      store.items.push(item)
    }
    if (personal && personal.id !== item.id) personal.role = 'team'
    item.role = 'personal'
    store.personalId = item.id
    writeStore(file, store)
    if (payload.activate !== false) await credentials.set(credentialRef, key)
    return state()
  }

  /**
   * 用控制台认下的团队名改写标签：成员机器上没有网关 admin 凭证，
   * `/admin/keys` 反查必然失败，团队名只能从 join 结果里拿。
   */
  function applyJoinNames(join) {
    const teams = join && Array.isArray(join.teams) ? join.teams : []
    if (!teams.length) return
    const store = readStore(file)
    let changed = false
    for (const team of teams) {
      const keyId = String((team && team.key_id) || '')
      const name = String((team && team.name) || '')
      if (!keyId || !name) continue
      const entry = store.items.find((item) => item.role !== 'personal'
        && createHash('sha256').update(item.key).digest('hex').slice(0, 16) === keyId)
      if (entry && entry.label !== name) {
        entry.label = name
        changed = true
      }
    }
    // 个人 key 同理：成员机器上反查不到名字时是掩码，用控制台给的名字补上
    const personalLabel = String(join.personalLabel || '')
    const personal = personalItem(store)
    if (personal && personalLabel && personal.label.startsWith('未命名')) {
      personal.label = personalLabel
      changed = true
    }
    if (changed) writeStore(file, store)
  }

  async function add(payload = {}) {
    const key = String(payload.key || '').trim()
    if (key.length < 8) throw new Error('密钥看起来太短，请粘贴完整的 Gateway Key')
    if (/\s/.test(key)) throw new Error('密钥里不能有空白字符')
    const store = readStore(file)
    const role = payload.role === 'personal' ? 'personal' : 'team'
    if (role === 'personal') return bindPersonal(payload)
    if (!personalItem(store)) {
      const error = new Error('先绑定你的个人密钥，团队记忆才知道回流到哪里')
      error.code = 'NEED_PERSONAL'
      throw error
    }
    const existing = store.items.find(entry => entry.key === key)
    if (existing) {
      if (payload.activate) await credentials.set(credentialRef, existing.key)
      return state()
    }
    const id = `k${store.nextId}`
    store.nextId += 1
    const named = await resolveKeyName(key)
    store.items.push({ id, label: named || `未命名 ${maskKey(key)}`, key, role: 'team' })
    writeStore(file, store)
    if (payload.activate) await credentials.set(credentialRef, key)
    const join = await registerJoin()
    if (join) {
      applyJoinNames(join)
      return { ...(await state()), join }
    }
    return state()
  }

  /**
   * 退出一个团队：先让控制台把「成员关系 + 你已经拿到的团队副本」清掉，再删本地这把团队 key。
   * 控制台不可达时只删本地 key，并把失败原因带回 UI（不阻塞切换，也不会偷偷留着团队关系）。
   */
  async function leaveTeam(teamKey) {
    if (!syncBaseURL) return { ok: false, reason: '没有配置控制台地址，只清理了本地记录' }
    const personal = personalItem(readStore(file))
    if (!personal) return { ok: false, reason: '缺少个人 key，控制台无法确认你的身份' }
    try {
      const response = await doFetch(`${syncBaseURL}/api/team/leave`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(syncToken ? { 'X-Console-Token': syncToken } : {}),
        },
        body: JSON.stringify({ personal_key: personal.key, team_keys: [teamKey] }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      let body = {}
      try {
        body = await response.json()
      } catch {
        body = {}
      }
      const teams = Array.isArray(body.teams) ? body.teams : []
      const removed = teams.reduce((sum, item) => sum + (Number(item.removed_copies) || 0), 0)
      return { ok: true, teams, removedCopies: removed, missing: body.missing || [] }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error).slice(0, 200) }
    }
  }

  async function remove(payload = {}) {
    const store = readStore(file)
    const index = store.items.findIndex(entry => entry.id === payload.id)
    if (index < 0) throw new Error(`没有这个密钥：${payload.id}`)
    const item = store.items[index]
    if (item.role === 'personal' && !payload.force) {
      const error = new Error('这是你的个人密钥，删掉就不知道回流到哪了；要换绑请直接绑定新的')
      error.code = 'PERSONAL_LOCKED'
      throw error
    }
    // 团队 key = 退出团队：先通知控制台清理成员关系与副本，再删本地记录
    const leave = item.role === 'personal' ? null : await leaveTeam(item.key)
    store.items.splice(index, 1)
    writeStore(file, store)
    return { ...(await state()), leave }
  }

  /** 用某把密钥探一次网关 /v1/models：只回报状态码与模型数，不回传响应体。 */
  async function probe(payload = {}) {
    const store = readStore(file)
    let key = ''
    if (payload.id) {
      const item = store.items.find(entry => entry.id === payload.id)
      if (!item) throw new Error(`没有这个密钥：${payload.id}`)
      key = item.key
    } else {
      key = await currentValue()
    }
    if (!key) return { ok: false, status: 0, modelCount: 0, detail: '还没有配置任何密钥' }
    const url = gatewayBaseURL + '/v1/models'
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : undefined
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller?.signal,
      })
      const text = await response.text()
      let modelCount = 0
      try {
        const parsed = JSON.parse(text)
        const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
        modelCount = list.length
      } catch {
        modelCount = 0
      }
      return {
        ok: response.ok,
        status: response.status,
        modelCount,
        detail: response.ok ? `网关可用，返回 ${modelCount} 个模型` : `网关返回 HTTP ${response.status}`,
      }
    } catch (error) {
      const message = error && error.name === 'AbortError' ? `探活超时（${PROBE_TIMEOUT_MS}ms）` : String(error?.message ?? error)
      return { ok: false, status: 0, modelCount: 0, detail: message }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 诊断用：客户端把「apply 跑了 / slot 回调触发 / 组件渲染了」回报成一行，
   * 落在密钥环同目录的 trace.log。排查「UI 没出现」时读它，正常使用不会写。
   */
  async function trace(payload = {}) {
    const logPath = join(dirname(file), 'trace.log')
    const line = JSON.stringify({
      at: new Date().toISOString(),
      tag: String(payload.tag ?? '').slice(0, 80),
      extra: payload.extra === undefined ? '' : String(payload.extra).slice(0, 400),
    })
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      const previous = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []
      previous.push(line)
      writeFileSync(logPath, previous.slice(-200).join('\n') + '\n', 'utf8')
      return { logged: true }
    } catch (error) {
      return { logged: false, detail: String(error?.message ?? error) }
    }
  }

  const endpoints = { state, activate, add, bindPersonal, remove, probe, sync, trace }

  /** 通道 handler：失败一律是返回值，绝不把异常抛进传输层。 */
  async function handle(endpoint, payload) {
    const run = Object.prototype.hasOwnProperty.call(endpoints, endpoint) ? endpoints[endpoint] : undefined
    if (!run) {
      return { ok: false, error: { code: 'not-found', message: `未知的 endpoint：${endpoint}`, details: {} } }
    }
    try {
      return { ok: true, value: await run(payload && typeof payload === 'object' ? payload : {}) }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'bad-request', message: String(error?.message ?? error).slice(0, 500), details: {} },
      }
    }
  }

  return { credentialRef, gatewayBaseURL, handle, endpoints }
}

export function apply(ctx, config = {}) {
  const handlers = createHandlers({ config, credentials: ctx.credentials })

  ctx.inject(['connection', 'webServer'], connectionCtx => {
    const connection = connectionCtx.root.connection
    if (!connection?.rpc?.handle) {
      ctx.logger?.warn?.('gateway-switch: 宿主没有 connection.rpc，设置页的切换通道不可用')
      return
    }
    connectionCtx.effect(
      () => connection.rpc.handle(CHANNEL, (endpoint, payload) => handlers.handle(endpoint, payload)),
      'gateway-switch: settings rpc channel',
    )
  })
}

export default { name, inject, apply }
