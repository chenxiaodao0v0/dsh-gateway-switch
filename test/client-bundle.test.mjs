import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * 客户端 bundle 的契约测试。
 *
 * DSH 的 client-modules 只认一种入口：先执行 bundle 文件（此时只注册 factory），
 * 再在需要时用宿主提供的 require 物化模块。这里用假的 __ModuleLoader__ / react
 * 复现这两步，验证：
 *   1. id 是包名（浏览器模块身份）；
 *   2. factory 只通过基座模块取依赖；
 *   3. 导出 name/inject/apply，apply 把页面注册进 `plugins.item` slot；
 *   4. RPC 调用走 connection.rpc.call(channel, endpoint, payload)。
 */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function makeFakeReact() {
  return {
    createElement: (type, props, children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

function loadBundle() {
  let entry
  const scope = { __ModuleLoader__: { load: (loaded) => (entry = loaded) } }
  // bundle 的最外层就是 window.__ModuleLoader__.load({...})，用注入的 window 执行它。
  new Function('window', source)(scope)
  assert.ok(entry, 'bundle 必须调用 window.__ModuleLoader__.load')
  const react = makeFakeReact()
  const requested = []
  const shipped = entry.factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return react
    throw new Error('bundle 请求了基座之外的模块：' + specifier)
  })
  return { entry, shipped, requested }
}

describe('client bundle', () => {
  it('id 是包名，factory 只依赖 react', () => {
    const { entry, requested } = loadBundle()
    assert.equal(entry.id, 'dsh-plugin-gateway-switch')
    assert.deepEqual(requested, ['react'])
  })

  it('导出 name / inject / apply', () => {
    const { shipped } = loadBundle()
    assert.equal(shipped.name, 'gateway-switch-client')
    assert.deepEqual(shipped.inject, ['slots'])
    assert.equal(typeof shipped.apply, 'function')
    assert.equal(typeof shipped.GatewaySwitchPage, 'function')
  })

  it('apply 注册设置页与输入框药丸，并各返回可注销的 effect', () => {
    const { shipped } = loadBundle()
    const injections = []
    const specs = []
    let disposer = null
    const effects = []
    const ctx = {
      get: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
      slots: {
        inject: (slotName, register) => {
          injections.push({ slotName, register })
          return () => {}
        },
        register: (spec, component) => {
          specs.push({ spec, component })
          return () => {
            disposer = 'disposed'
          }
        },
      },
      effect: (factory, label) => {
        effects.push(label)
        return factory()
      },
    }

    shipped.apply(ctx)

    assert.deepEqual(
      injections.map((i) => i.slotName),
      ['plugins.item', 'conversation.composer.dock', 'conversation.input.right'],
    )
    for (const injection of injections) injection.register()

    const page = specs.find((s) => s.spec.name === 'plugins.item')
    assert.equal(page.spec.id, 'gateway-switch')
    assert.equal(page.component, shipped.GatewaySwitchPage)
    assert.equal(page.spec.label(), '网关密钥')
    assert.deepEqual(page.spec.inject(), {})

    // 契约取自 dsh-client-ui-chat：list 型 slot，必须提供 id 与 order。
    // 两个 slot 各放一枚：dock 放记忆状态，input.right 放网关切换，避免同一处出现两颗药丸。
    const memoryPill = specs.find((s) => s.spec.name === 'conversation.composer.dock')
    assert.ok(memoryPill, '记忆状态必须注册到 conversation.composer.dock')
    assert.equal(memoryPill.spec.id, 'gateway-memory')
    assert.equal(typeof memoryPill.component, 'function')

    const gatewayPill = specs.find((s) => s.spec.name === 'conversation.input.right')
    assert.ok(gatewayPill, '网关切换必须注册到 conversation.input.right')
    assert.equal(gatewayPill.spec.id, 'gateway-key')
    assert.equal(typeof gatewayPill.component, 'function')

    for (const pill of [memoryPill, gatewayPill]) {
      assert.equal(typeof pill.spec.order, 'number')
      assert.deepEqual(pill.spec.inject(), {})
    }

    assert.deepEqual(effects, [
      'gateway-switch: settings page',
      'gateway-switch: memory pill',
      'gateway-switch: gateway pill',
    ])
    assert.equal(disposer, null, 'effect 只在卸载时清理')
  })

  it('RPC 走绝对通道前缀，apply 时上报一条诊断', async () => {
    const { shipped } = loadBundle()
    const calls = []
    const ctx = {
      get: () => ({
        rpc: {
          call: async (channel, endpoint, payload) => {
            calls.push({ channel, endpoint, payload })
            return { ok: true, value: { items: [], credentialRef: 'OPENVIKING_GATEWAY_KEY' } }
          },
        },
      }),
      slots: { inject: () => () => {}, register: () => () => {} },
      effect: (factory) => factory(),
    }
    shipped.apply(ctx)
    await Promise.resolve()

    assert.equal(calls.length, 1, 'apply 只应上报一条 trace')
    // DSH 0.2.2+：插件共用 /api 通道，endpoint 用命名空间区分
    assert.equal(calls[0].channel, '/api')
    assert.equal(calls[0].endpoint, 'gateway-switch/trace')
    assert.equal(calls[0].payload.tag, 'client:apply')
  })
})
