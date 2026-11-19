import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { createHandlers, decodeUserKey, maskKey, memoryStatus, storePathFor } from '../index.js'

/** 一个够用的假凭据服务：行为对齐 dsh-credentials 的 resolve/describe/set。 */
function fakeCredentials(initial = {}) {
  const refs = new Map(Object.entries(initial))
  const writes = []
  return {
    writes,
    async resolve(ref) {
      return refs.has(ref) ? { value: refs.get(ref), source: 'store' } : undefined
    },
    async describe(ref) {
      return { configured: refs.has(ref), source: refs.has(ref) ? 'store' : undefined, writable: true }
    },
    async set(ref, value) {
      writes.push([ref, value])
      refs.set(ref, value)
    },
    async unset(ref) {
      refs.delete(ref)
    },
  }
}

const dir = mkdtempSync(join(tmpdir(), 'gateway-switch-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('maskKey', () => {
  it('只保留前 9 个字符', () => {
    assert.equal(maskKey('ovgw_Ee-VE_fNHvLYxeaUYkWhcQoqgXFVfWr3i'), 'ovgw_Ee-V…')
  })
  it('空值给空串', () => {
    assert.equal(maskKey(''), '')
    assert.equal(maskKey(undefined), '')
  })
})

describe('storePathFor', () => {
  it('跟随 DSH_HOME', () => {
    assert.equal(storePathFor({ DSH_HOME: 'C:\\x\\.dsh' }), join('C:\\x\\.dsh', 'gateway-switch', 'keys.json'))
  })
})

describe('decodeUserKey', () => {
  it('从 user key 解出 account 与 user', () => {
    assert.deepEqual(decodeUserKey('ZGVtbw.YWxpY2U.c2ln'), { account: 'demo', user: 'alice' })
  })

  it('解不出来时返回 null', () => {
    assert.equal(decodeUserKey(''), null)
    assert.equal(decodeUserKey('only-one-part'), null)
    assert.equal(decodeUserKey(null), null)
  })
})

describe('memoryStatus', () => {
  it('插件在场：身份固定，切 key 不改变记忆空间', () => {
    const status = memoryStatus({ plugin: true, userKey: 'ZGVtbw.YWxpY2U.c2ln' })
    assert.equal(status.mode, 'plugin')
    assert.equal(status.user, 'alice')
    assert.equal(status.account, 'demo')
    assert.match(status.hint, /切 key 不改变记忆空间/)
  })

  it('插件不在场：记忆随 gateway key 归属', () => {
    const status = memoryStatus({ plugin: false, userKey: 'ZGVtbw.YWxpY2U.c2ln' })
    assert.equal(status.mode, 'gateway')
    assert.equal(status.user, null, '网关模式下不从 ovcli.conf 推断身份')
    assert.match(status.hint, /openviking 供应商/)
  })
})

describe('apply: RPC route registration', () => {
  it('在 /api 共享通道上注册精确 Fetch 路由，并把请求映射回动作名', async () => {
    const { apply } = await import('../index.js')
    const routes = []
    const ctx = {
      credentials: fakeCredentials(),
      logger: { warn: () => {} },
      inject: (_names, run) => run({
        root: {
          connection: {
            fetch: {
              register: (route) => {
                routes.push(route)
                return () => Promise.resolve()
              },
            },
          },
        },
        effect: (factory) => factory(),
      }),
    }
    apply(ctx, {})

    // 每个动作一条精确路由，全部挂在 /api 下
    assert.equal(routes.length, 8, '应为 8 个动作各注册一条路由')
    for (const route of routes) {
      assert.match(route.path, /^\/api\/gateway-switch\/[A-Za-z]+$/, '路径必须在 /api/gateway-switch 下')
      assert.deepEqual(route.methods, ['POST'], '只认 POST')
      assert.equal(route.requestBody, 'buffered')
      assert.equal(typeof route.fetch, 'function')
    }
    const state = routes.find(r => r.path === '/api/gateway-switch/state')
    assert.ok(state, 'state 路由必须存在')

    // 请求 envelope → handler 结果 → server-response envelope
    const response = await state.fetch(new Request('http://dsh.internal/api/gateway-switch/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: 'state', payload: {} }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, 'r-1', 'rpcId 必须回显')
    assert.equal(body.result.ok, true)
    assert.ok(body.result.value && typeof body.result.value === 'object')

    // 非法 JSON → 400
    const bad = await state.fetch(new Request('http://dsh.internal/api/gateway-switch/state', {
      method: 'POST', body: 'not json',
    }))
    assert.equal(bad.status, 400)
  })

  it('宿主没有 connection.fetch.register 时不崩，只告警', async () => {
    const { apply } = await import('../index.js')
    const warnings = []
    const ctx = {
      credentials: fakeCredentials(),
      logger: { warn: (m) => warnings.push(m) },
      inject: (_names, run) => run({ root: { connection: {} }, effect: (f) => f() }),
    }
    assert.doesNotThrow(() => apply(ctx, {}))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /connection\.fetch\.register/)
  })
})

describe('createHandlers', () => {
  const personal = 'ovgw_personal_bbbbbbbbbbbbbbbb'
  const personalName = '研发团队'
  let storePath
  let ovConfPath
  let credentials
  let handlers

  const modelsReply = (authorized) => ({
    ok: authorized,
    status: authorized ? 200 : 401,
    text: async () => JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'gpt-5.5' }] }),
  })

  const selfKey = 'ovgw_self_ssssssssssssssssssssss'

  /** 直接落一份「已绑个人 key」的密钥环：大部分用例只关心团队 key 的行为。 */
  const seedPersonal = () => {
    writeFileSync(
      storePath,
      JSON.stringify({ nextId: 2, personalId: 'k1', pendingJoins: [], items: [{ id: 'k1', label: '本人', key: selfKey, role: 'personal' }] }),
    )
  }
  const teamItem = (state) => state.items.find((item) => item.role === 'team')

  beforeEach(() => {
    storePath = join(dir, `keys-${Math.random().toString(36).slice(2)}.json`)
    ovConfPath = join(dir, `ov-${Math.random().toString(36).slice(2)}.conf`)
    writeFileSync(ovConfPath, JSON.stringify({ server: { root_api_key: 'root-test' } }))
    credentials = fakeCredentials({ OPENVIKING_GATEWAY_KEY: 'ovgw_current_aaaaaaaaaaaaaaaaaaaa' })
    handlers = createHandlers({
      config: {
        credentialRef: 'OPENVIKING_GATEWAY_KEY',
        gatewayBaseURL: 'http://gw.local/gateway/',
        adminKey: 'admin-test',
      },
      credentials,
      storePath,
      fetchImpl: async (url, init) => {
        if (url.startsWith('http://gw.local/gateway/admin/keys')) {
          assert.match(url, /account_id=demo/)
          assert.equal(init.headers.Authorization, 'Bearer admin-test')
          assert.equal(init.method, 'GET', '取名凭证只允许 GET')
          assert.equal(init.body, undefined, '取名凭证的请求不能带 body')
          assert.equal(init.redirect, 'error', '不跟随重定向，避免把凭证带去别处')
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify([
              { id: createHash('sha256').update(personal).digest('hex'), name: personalName, prefix: personal.slice(0, 12) },
            ]),
          }
        }
        assert.equal(url, 'http://gw.local/gateway/v1/models')
        return modelsReply(init.headers.Authorization.startsWith('Bearer '))
      },
    })
  })

  it('初始状态：标记已配置，且不回传明文', async () => {
    const state = await handlers.endpoints.state()
    assert.equal(state.credentialRef, 'OPENVIKING_GATEWAY_KEY')
    assert.equal(state.gatewayBaseURL, 'http://gw.local/gateway', '末尾斜杠被归一化')
    assert.equal(state.configured, true)
    assert.equal(state.activePrefix, 'ovgw_curr…')
    assert.equal(state.items.length, 0)
    assert.equal(state.needPersonal, true, '还没绑个人 key')
    assert.equal(JSON.stringify(state).includes('ovgw_current_aaaa'), false, 'state 里不能出现明文密钥')
  })

  it('add 用网关侧的名字自动命名，落盘 + 只返回掩码，activate 走 credentials.set 实现热切换', async () => {
    seedPersonal()
    const added = await handlers.endpoints.add({ key: personal })
    const team = teamItem(added)
    assert.equal(added.items.length, 2, '个人 key 之外新增一把团队 key')
    assert.equal(team.label, personalName, '名字来自网关，不由用户填')
    assert.equal(team.prefix, 'ovgw_pers…')
    assert.equal(team.active, false)

    const activated = await handlers.endpoints.activate({ id: team.id })
    assert.deepEqual(credentials.writes.at(-1), ['OPENVIKING_GATEWAY_KEY', 'ovgw_personal_bbbbbbbbbbbbbbbb'])
    assert.equal(teamItem(activated).active, true, '切换后该条目成为 active')
    assert.equal(activated.activePrefix, 'ovgw_pers…')
    assert.equal(activated.activeLabel, personalName, '药丸直接拿这个名字显示')

    const onDisk = JSON.parse(readFileSync(storePath, 'utf8'))
    assert.equal(onDisk.items.find((item) => item.role === 'team').key, personal, '密钥落盘供下次切换')
  })

  it('remove 之后只剩个人 key，占位符仍可用', async () => {
    seedPersonal()
    const added = await handlers.endpoints.add({ key: 'ovgw_temp_cccccccccccccccccccc' })
    const team = teamItem(added)
    const removed = await handlers.endpoints.remove({ id: team.id })
    assert.equal(removed.items.length, 1)
    assert.equal(removed.items[0].role, 'personal', '个人 key 不会被顺手删掉')
    await assert.rejects(() => handlers.endpoints.remove({ id: team.id }), /没有这个密钥/)
  })

  /** 退出团队需要一个配了 syncBaseURL 的 handlers（该值在 createHandlers 时读取）。 */
  const consoleHandlers = (consoleFetch) =>
    createHandlers({
      config: {
        credentialRef: 'OPENVIKING_GATEWAY_KEY',
        gatewayBaseURL: 'http://gw.local/gateway/',
        adminKey: 'admin-test',
        syncBaseURL: 'http://console.local',
      },
      credentials,
      storePath,
      fetchImpl: async (url, init) => {
        if (String(url).startsWith('http://gw.local/gateway/admin/keys')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ keys: [{ id: 'x', name: '团队', user_id: 'TeamRD', prefix: 'ovgw_team' }] }),
            text: async () => '{}',
          }
        }
        return consoleFetch(url, init)
      },
    })

  it('删除团队 key = 退出团队：会先通知控制台清理', async () => {
    seedPersonal()
    const calls = []
    const leaving = consoleHandlers(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        json: async () => ({ personal_user: 'alice', teams: [{ team_id: 'rd-team', name: 'x', removed_copies: 7 }], missing: [] }),
        text: async () => '{}',
      }
    })
    const added = await leaving.endpoints.add({ key: 'ovgw_temp_dddddddddddddddddddd' })
    const team = teamItem(added)

    const removed = await leaving.endpoints.remove({ id: team.id })
    assert.equal(removed.items.length, 1, '本地团队 key 已删除')
    assert.equal(removed.leave?.ok, true, '退出结果带回 UI')
    assert.equal(removed.leave.removedCopies, 7, '带回清理了多少份副本')
    const leaveCall = calls.find((call) => call.url.endsWith('/api/team/leave'))
    assert.ok(leaveCall, '必须调用 /api/team/leave')
    assert.equal(leaveCall.body.team_keys.length, 1)
    assert.match(leaveCall.body.personal_key, /^ovgw_/, '用个人 key 表明身份')
  })

  it('控制台不可达时仍能删掉本地团队 key，并把失败原因带回', async () => {
    seedPersonal()
    const leaving = consoleHandlers(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    const added = await leaving.endpoints.add({ key: 'ovgw_temp_eeeeeeeeeeeeeeeeeeee' })
    const team = teamItem(added)
    const removed = await leaving.endpoints.remove({ id: team.id })
    assert.equal(removed.items.length, 1, '本地记录照样清掉，避免卡住用户')
    assert.equal(removed.leave?.ok, false, '拿不到控制台时要明确回报失败')
    assert.ok(String(removed.leave?.reason || '').length > 0, '失败原因不能是空字符串')
  })

  it('没绑个人 key 就加团队 key：明确拒绝，而不是默默收下', async () => {
    const error = await handlers.endpoints.add({ key: personal }).then(
      () => null,
      (caught) => caught,
    )
    assert.equal(error?.code, 'NEED_PERSONAL')
    assert.equal(existsSync(storePath), false, '拒绝时不应该落盘')

    const fallback = await handlers.endpoints.add({ key: personal, role: 'personal' })
    assert.equal(fallback.items.length, 1)
    assert.equal(fallback.items[0].role, 'personal')
  })

  it('反查不到名字（没有根凭证）时降级成掩码标签，不阻塞入库', async () => {
    const offline = createHandlers({
      config: {
        credentialRef: 'OPENVIKING_GATEWAY_KEY',
        gatewayBaseURL: 'http://gw.local/gateway',
        adminKeysFile: join(dir, 'no-such-admin.json'),
        ovConfPath: join(dir, 'no-such-ov.conf'),
      },
      credentials,
      storePath,
      fetchImpl: async () => modelsReply(true),
    })
    seedPersonal()
    const added = await offline.endpoints.add({ key: personal })
    assert.equal(teamItem(added).label, '未命名 ovgw_pers…')
  })

  it('没配 adminKey 时读插件目录里随包分发的 team-admin.json', async () => {
    const adminFile = join(dir, `team-admin-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(adminFile, JSON.stringify({ adminKey: 'admin-from-file' }))
    const shipped = createHandlers({
      config: { credentialRef: 'OPENVIKING_GATEWAY_KEY', gatewayBaseURL: 'http://gw.local/gateway', adminKeysFile: adminFile },
      credentials,
      storePath,
      fetchImpl: async (url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer admin-from-file')
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: createHash('sha256').update(personal).digest('hex'), name: personalName }]) }
      },
    })
    seedPersonal()
    const added = await shipped.endpoints.add({ key: personal })
    assert.equal(teamItem(added).label, personalName)
  })

  it('第一把凭证没权限就顺延下一把，不因为 403 丢掉名字', async () => {
    const ovConf = join(dir, `ov-${Math.random().toString(36).slice(2)}.conf`)
    writeFileSync(ovConf, JSON.stringify({ server: { root_api_key: 'root-fallback' } }))
    const adminFile = join(dir, `team-admin-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(adminFile, JSON.stringify({ adminKey: 'team-user-only' }))
    const seen = []
    const chained = createHandlers({
      config: {
        credentialRef: 'OPENVIKING_GATEWAY_KEY',
        gatewayBaseURL: 'http://gw.local/gateway',
        adminKeysFile: adminFile,
        ovConfPath: ovConf,
      },
      credentials,
      storePath,
      fetchImpl: async (url, init) => {
        seen.push(init.headers.Authorization)
        if (init.headers.Authorization === 'Bearer team-user-only') {
          return { ok: false, status: 403, text: async () => '{"reason":"forbidden"}' }
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{ id: createHash('sha256').update(personal).digest('hex'), name: personalName }]),
        }
      },
    })
    seedPersonal()
    const added = await chained.endpoints.add({ key: personal })
    assert.equal(teamItem(added).label, personalName)
    assert.deepEqual(seen, ['Bearer team-user-only', 'Bearer root-fallback'])
  })

  it('取名凭证不出现在 state 与 trace 里', async () => {
    const adminFile = join(dir, `team-admin-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(adminFile, JSON.stringify({ adminKey: 'super-secret-lookup-key' }))
    const quiet = createHandlers({
      config: { credentialRef: 'OPENVIKING_GATEWAY_KEY', gatewayBaseURL: 'http://gw.local/gateway', adminKeysFile: adminFile },
      credentials,
      storePath,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }),
    })
    const state = await quiet.endpoints.state()
    assert.equal(JSON.stringify(state).includes('super-secret-lookup-key'), false)
  })

  it('凭证文件声明成非只读就整份拒绝加载', async () => {
    const adminFile = join(dir, `team-admin-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(adminFile, JSON.stringify({ scope: 'admin', adminKey: 'root-like-key' }))
    let called = false
    const guarded = createHandlers({
      config: {
        credentialRef: 'OPENVIKING_GATEWAY_KEY',
        gatewayBaseURL: 'http://gw.local/gateway',
        adminKeysFile: adminFile,
        ovConfPath: join(dir, 'no-such-ov.conf'),
      },
      credentials,
      storePath,
      fetchImpl: async () => {
        called = true
        return { ok: true, status: 200, text: async () => '[]' }
      },
    })
    seedPersonal()
    const added = await guarded.endpoints.add({ key: personal })
    assert.equal(called, false, '不该拿这把凭证发任何请求')
    assert.equal(teamItem(added).label, '未命名 ovgw_pers…')
  })

  it('取名凭证不会随着报错文案漏出去', async () => {
    const adminFile = join(dir, `team-admin-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(adminFile, JSON.stringify({ adminKey: 'leaky-lookup-key' }))
    const leaky = createHandlers({
      config: { credentialRef: 'OPENVIKING_GATEWAY_KEY', gatewayBaseURL: 'http://gw.local/gateway', adminKeysFile: adminFile },
      credentials,
      storePath,
      fetchImpl: async (url, init) => {
        throw new Error('connect failed with ' + init.headers.Authorization)
      },
    })
    seedPersonal()
    const added = await leaky.endpoints.add({ key: personal })
    assert.equal(teamItem(added).label, '未命名 ovgw_pers…', '反查失败只降级，不抛错')
    assert.equal(JSON.stringify(added).includes('leaky-lookup-key'), false)
  })

  it('加入团队可以直接生效：add({activate:true}) 落盘并切成当前 key', async () => {
    seedPersonal()
    const joined = await handlers.endpoints.add({ key: personal, activate: true })
    assert.equal(joined.activeLabel, personalName, '一进来就是当前 key')
    assert.equal(teamItem(joined).active, true)
    assert.deepEqual(credentials.writes.at(-1), ['OPENVIKING_GATEWAY_KEY', personal])

    const again = await handlers.endpoints.add({ key: personal, activate: true })
    assert.equal(again.items.length, 2, '重复加入不新增条目')
  })

  it('同一把 key 重复添加不产生重复条目', async () => {
    seedPersonal()
    await handlers.endpoints.add({ key: personal })
    const again = await handlers.endpoints.add({ key: personal })
    assert.equal(again.items.filter((item) => item.role === 'team').length, 1)
  })

  it('绑定个人 key：落成 personal 角色、默认切成当前 key、且不允许删掉', async () => {
    const bound = await handlers.endpoints.bindPersonal({ key: personal })
    assert.equal(bound.personal.label, personalName)
    assert.equal(bound.personal.prefix, 'ovgw_pers…')
    assert.equal(bound.needPersonal, false)
    assert.equal(bound.items[0].role, 'personal')
    assert.deepEqual(credentials.writes.at(-1), ['OPENVIKING_GATEWAY_KEY', personal])

    const error = await handlers.endpoints.remove({ id: bound.personal.id }).then(
      () => null,
      (caught) => caught,
    )
    assert.equal(error?.code, 'PERSONAL_LOCKED', '个人 key 是回流的落点，删掉就不知道同步给谁')
  })

  it('换绑个人 key：旧的那把降级成普通 team key，不留两个 personal', async () => {
    const first = await handlers.endpoints.bindPersonal({ key: personal })
    const second = await handlers.endpoints.bindPersonal({ key: selfKey, activate: false })
    assert.equal(second.items.filter((item) => item.role === 'personal').length, 1)
    assert.equal(second.personal.prefix, 'ovgw_self…')
    assert.equal(second.items.find((item) => item.id === first.personal.id).role, 'team')
  })

  it('首次安装：provider 里已有的网关 key 自动认作个人 key', async () => {
    const auto = createHandlers({
      config: { credentialRef: 'OPENVIKING_GATEWAY_KEY', gatewayBaseURL: 'http://gw.local/gateway', adminKey: 'admin-test' },
      credentials: fakeCredentials({ OPENVIKING_GATEWAY_KEY: personal }),
      storePath,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: createHash('sha256').update(personal).digest('hex'), name: personalName, user_id: 'alice' }]),
      }),
    })
    const state = await auto.endpoints.state()
    assert.equal(state.needPersonal, false, '已经自动绑上')
    assert.equal(state.personal.label, personalName)
    assert.equal(state.items[0].role, 'personal')
  })

  it('成员机器没有网关 admin 凭证时，改由控制台反查名字并自动认领', async () => {
    const auto = createHandlers({
      config: { credentialRef: 'OPENVIKING_GATEWAY_KEY', gatewayBaseURL: 'http://gw.local/gateway', syncBaseURL: 'http://console.local/' },
      credentials: fakeCredentials({ OPENVIKING_GATEWAY_KEY: personal }),
      storePath,
      fetchImpl: async (url) => {
        if (url === 'http://console.local/api/identity/resolve') {
          return { ok: true, status: 200, json: async () => ({ items: [{ fingerprint: 'x', name: personalName, user_id: 'alice' }] }) }
        }
        // 网关管理接口拿不到（成员机器没有 admin 凭证 / 没有 root key）
        return { ok: false, status: 403, text: async () => '{"error":"forbidden"}' }
      },
    })
    const state = await auto.endpoints.state()
    assert.equal(state.needPersonal, false, '控制台反查成功就能自动认领')
    assert.equal(state.personal.label, personalName, '名字来自控制台，不是掩码')
  })

  it('加入团队后把 (个人 key, 团队 key) 登记给控制台；登记不上就排队等下次', async () => {
    const calls = []
    let reachable = true
    const joined = createHandlers({
      config: { credentialRef: 'OPENVIKING_GATEWAY_KEY', gatewayBaseURL: 'http://gw.local/gateway', adminKey: 'admin-test', syncBaseURL: 'http://console.local/' },
      credentials: fakeCredentials({ OPENVIKING_GATEWAY_KEY: personal }),
      storePath,
      fetchImpl: async (url, init) => {
        if (url === 'http://console.local/api/team/join') {
          if (!reachable) throw new Error('ECONNREFUSED')
          calls.push(JSON.parse(init.body))
          return { ok: true, status: 200, text: async () => '{"ok":true}' }
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{ id: createHash('sha256').update(personal).digest('hex'), name: personalName, user_id: 'alice' }]),
        }
      },
    })
    await joined.endpoints.state()
    const withTeam = await joined.endpoints.add({ key: 'ovgw_team_ttttttttttttttttttt' })
    assert.equal(withTeam.join.ok, true)
    assert.deepEqual(calls[0], { personal_key: personal, team_keys: ['ovgw_team_ttttttttttttttttttt'] }, '只送 key，不送别的身份信息')
    assert.equal(JSON.stringify(withTeam.join).includes(personal), false, '回给 UI 的结果里不能带明文')

    reachable = false
    const offline = await joined.endpoints.sync()
    assert.equal(offline.ok, false)
    assert.equal(offline.pending, true)
    const queued = await joined.endpoints.state()
    assert.equal(queued.sync.pending, 1, '排队次数透给 UI，方便提示“回流还没开始”')
  })

  it('加入团队后用控制台认下的团队名当标签（成员机器上没有 admin 凭证）', async () => {
    writeFileSync(storePath, JSON.stringify({
      nextId: 2, personalId: 'k1', pendingJoins: [],
      items: [{ id: 'k1', label: '未命名 ovgw_self…', key: selfKey, role: 'personal' }],
    }))
    const teamKey = 'ovgw_team_kkkkkkkkkkkkkkkkkkk'
    const joined = createHandlers({
      config: { credentialRef: 'OPENVIKING_GATEWAY_KEY', gatewayBaseURL: 'http://gw.local/gateway', adminKey: 'admin-test', syncBaseURL: 'http://console.local/' },
      credentials: fakeCredentials({ OPENVIKING_GATEWAY_KEY: selfKey }),
      storePath,
      fetchImpl: async (url) => {
        if (url === 'http://console.local/api/team/join') {
          const keyId = createHash('sha256').update(teamKey).digest('hex').slice(0, 16)
          const body = { ok: true, teams: [{ team_id: 'rd-team', name: '研发团队', key_id: keyId, added: true }], missing: [], personal_label: '本人 · 本地默认客户端' }
          return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
        }
        return { ok: false, status: 403, text: async () => '{"error":"forbidden"}' }
      },
    })
    await joined.endpoints.state()
    const after = await joined.endpoints.add({ key: teamKey })
    const team = after.items.find((item) => item.role === 'team')
    assert.equal(team.label, '研发团队', '标签来自控制台认下的团队名，而不是掩码')
    assert.equal(after.personal.label, '本人 · 本地默认客户端', '个人 key 的掩码标签也用控制台给的名字补上')
  })

  it('个人 key 与团队 key 可以来回切：点个人那条就回到个人 gateway', async () => {
    seedPersonal()
    const joined = await handlers.endpoints.add({ key: personal })
    const team = teamItem(joined)
    assert.equal(joined.personal.id, 'k1')
    assert.equal(joined.items.find((item) => item.role === 'personal').id, 'k1', '个人 key 也在列表里')

    await handlers.endpoints.activate({ id: team.id })
    assert.deepEqual(credentials.writes.at(-1), ['OPENVIKING_GATEWAY_KEY', personal])

    const back = await handlers.endpoints.activate({ id: 'k1' })
    assert.deepEqual(credentials.writes.at(-1), ['OPENVIKING_GATEWAY_KEY', selfKey], '再点个人那条就切回个人 gateway')
    assert.equal(back.items.find((item) => item.role === 'personal').active, true)
    assert.equal(back.items.find((item) => item.role === 'team').active, false)
    assert.equal(back.personal.id, 'k1', '个人身份不因为切走而丢失')
  })

  it('add 拒绝空值与空白', async () => {
    await assert.rejects(() => handlers.endpoints.add({ key: '' }), /太短/)
    await assert.rejects(() => handlers.endpoints.add({ key: 'ovgw_a b c d e f g h' }), /空白/)
  })

  it('state 带上记忆状态：插件在 profile 里就读 ovcli.conf 的身份', async () => {
    const profile = join(dir, `profile-${Math.random().toString(36).slice(2)}`)
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@openviking/dsh-memory-plugin'] } } }),
      'utf8',
    )
    const ovcli = join(dir, `ovcli-${Math.random().toString(36).slice(2)}.conf`)
    writeFileSync(ovcli, JSON.stringify({ api_key: 'ZGVtbw.YWxpY2U.c2ln' }), 'utf8')

    const local = createHandlers({ config: { profileDir: profile, ovcliPath: ovcli }, credentials, storePath })
    const state = await local.endpoints.state()
    assert.equal(state.memory.mode, 'plugin')
    assert.equal(state.memory.user, 'alice')

    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
      'utf8',
    )
    const afterRemoval = await local.endpoints.state()
    assert.equal(afterRemoval.memory.mode, 'gateway', '插件被摘掉后改为网关归属')
  })

  it('probe 探网关 /v1/models 并数出模型数', async () => {
    const result = await handlers.endpoints.probe({})
    assert.deepEqual(result, { ok: true, status: 200, modelCount: 2, detail: '网关可用，返回 2 个模型' })
  })

  it('probe 在没有密钥时给明确提示而不是抛错', async () => {
    const empty = createHandlers({ credentials: fakeCredentials(), storePath })
    const result = await empty.endpoints.probe({})
    assert.equal(result.ok, false)
    assert.match(result.detail, /还没有配置/)
  })

  it('handle 用返回值表达失败，绝不把异常抛给传输层', async () => {
    const unknown = await handlers.handle('nope', {})
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'not-found')

    const bad = await handlers.handle('activate', { id: 'k404' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'bad-request')
    assert.match(bad.error.message, /没有这个密钥/)

    const ok = await handlers.handle('state', {})
    assert.equal(ok.ok, true)
    assert.equal(ok.value.configured, true)
  })

  it('原型链上的名字不会被当成 endpoint', async () => {
    const result = await handlers.handle('constructor', {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'not-found')
  })

  it('trace 把客户端上报追加到同目录 trace.log，且不泄漏密钥', async () => {
    const ok = await handlers.handle('trace', { tag: 'client:render', extra: 'conversation.composer.dock' })
    assert.equal(ok.ok, true)
    assert.equal(ok.value.logged, true)

    const logPath = join(dir, 'trace.log')
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.tag, 'client:render')
    assert.equal(entry.extra, 'conversation.composer.dock')
    assert.ok(entry.at, '要带时间戳')

    await handlers.handle('trace', { tag: 'second' })
    const after = readFileSync(logPath, 'utf8').trim().split('\n')
    assert.equal(after.length, 2, '追加而不是覆盖')
    assert.doesNotMatch(readFileSync(logPath, 'utf8'), /ovgw_current/, 'trace 里不能出现密钥')
  })
})
