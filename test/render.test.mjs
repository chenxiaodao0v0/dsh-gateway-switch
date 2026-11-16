import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * 渲染冒烟：用假 React 真的执行一次页面组件，确认它能渲染出预期结构，
 * 而不是「语法通了就算过」。命中三类真实风险：
 *   - 组件里用了基座没提供的 API（这里会直接抛）；
 *   - 空状态结构退化；
 *   - 文案与「无需重启」的关键提示丢失。
 */
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function makeFakeReact() {
  const effects = []
  return {
    effects,
    createElement: (type, props, children) => ({ type, props: props || {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (fn) => effects.push(fn),
    useCallback: (fn) => fn,
  }
}

function loadBundle() {
  let entry
  new Function('window', source)({ __ModuleLoader__: { load: (loaded) => (entry = loaded) } })
  const react = makeFakeReact()
  return { shipped: entry.factory(() => react), react }
}

function resolve(node) {
  if (node && typeof node === 'object' && typeof node.type === 'function') return node.type(node.props)
  return node
}

function walk(node, out = []) {
  node = resolve(node)
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  walk(node.children, out)
  return out
}

function textOf(node) {
  node = resolve(node)
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

describe('页面渲染冒烟', () => {
  it('首次渲染（state 未加载）结构完整，并写明无需重启', () => {
    const { shipped, react } = loadBundle()
    const tree = shipped.GatewaySwitchPage()
    const text = textOf(tree)

    assert.match(text, /网关密钥/)
    assert.match(text, /下一次请求就生效/)
    assert.match(text, /不需要重启/)
    assert.match(text, /添加一把密钥/)
    assert.match(text, /还没有保存任何密钥/, '设置页空列表要给引导文案')
    assert.ok(react.effects.length >= 1, '挂载时至少注册一个 effect 去拉 state')
    assert.ok(walk(tree).length > 5, '渲染出真实结构而不是单个空壳')
  })

  it('Toggle 是 role=switch 且点击回调可用、勾选态反映到 aria-checked', () => {
    const { shipped } = loadBundle()
    let toggled = 0

    const off = shipped.Toggle({ checked: false, label: 'x', onToggle: () => (toggled += 1) })
    assert.equal(off.type, 'button')
    assert.equal(off.props.role, 'switch')
    assert.equal(off.props['aria-checked'], 'false')
    const knobOff = off.children
    assert.equal(knobOff.props.style.left, 2)

    off.props.onClick()
    assert.equal(toggled, 1, 'onToggle 必须被调用')

    const on = shipped.Toggle({ checked: true, label: 'y', onToggle: () => {} })
    assert.equal(on.props['aria-checked'], 'true')
    assert.equal(on.children.props.style.left, 19, '勾选后滑块右移')
  })

  it('只读部署下开关被禁用', () => {
    const { shipped } = loadBundle()
    const disabled = shipped.Toggle({ checked: false, disabled: true, label: 'z', onToggle: () => {} })
    assert.equal(disabled.props.disabled, true)
    assert.equal(disabled.props.style.opacity, 0.55)
  })
})

describe('输入框药丸', () => {
  const state = {
    credentialRef: 'OPENVIKING_GATEWAY_KEY',
    gatewayBaseURL: 'http://localhost:1933/gateway',
    configured: true,
    activePrefix: 'ovgw_ZgoEFGI…',
    activeLabel: '本地 · 我',
    writable: true,
    items: [
      { id: 'k1', label: '本地 · 我', prefix: 'ovgw_ZgoE…', active: true },
      { id: 'k2', label: '本地 · 别人', prefix: 'ovgw_Q146…', active: false },
    ],
    memory: { mode: 'gateway', user: null, hint: '记忆随 gateway key 归属；只有选用 openviking 供应商的模型才会记录' },
  }

  it('药丸显示 key 在网关里的名字，长名字只取第一段，缺失才退回掩码', () => {
    const { shipped } = loadBundle()
    assert.equal(shipped.pillText(state), '本地', '「本地 · 我」只取第一段')
    assert.equal(shipped.pillText({ ...state, activeLabel: '研发团队' }), '研发团队')
    assert.equal(shipped.pillText({ ...state, activeLabel: '陈嘉帅 · 本地默认客户端' }), '陈嘉帅')
    assert.equal(shipped.shortLabel('没有分隔符的名字'), '没有分隔符的名字')
    assert.equal(shipped.pillText({ configured: true, activePrefix: 'ovgw_ZgoEFGI…' }), '网关 ovgw_ZgoEFGI…')
    assert.equal(shipped.pillText({ configured: false }), '网关未配置')
    assert.equal(shipped.pillText(null), '…')
  })

  it('第二行显示记忆归属：随 key / 插件用户', () => {
    const { shipped } = loadBundle()
    assert.equal(shipped.memoryLabel({ mode: 'gateway' }), '记忆 随key', '还没读到名字时退回随key')
    assert.equal(shipped.memoryLabel({ mode: 'gateway' }, '研发团队'), '记忆 随研发团队')
    assert.equal(shipped.memoryLabel({ mode: 'gateway' }, '陈嘉帅 · 本地默认客户端'), '记忆 随陈嘉帅')
    assert.equal(shipped.memoryLabel({ mode: 'plugin', user: 'alice' }), '记忆 alice')
    assert.equal(shipped.memoryLabel({ mode: 'plugin', user: null }), '记忆 插件')
    assert.equal(shipped.memoryLabel(undefined), '记忆 …')
  })

  it('浮层列出全部密钥，当前那条不可点、其余点击回传条目', () => {
    const { shipped } = loadBundle()
    const picked = []
    const panel = shipped.GatewayKeyPanel({ data: state, busy: '', error: '', onPick: (item) => picked.push(item.id) })
    const text = textOf(panel)
    assert.match(text, /网关密钥/)
    assert.match(text, /本地 · 我/)
    assert.doesNotMatch(text, /记忆 随/, '当前 key 已经用 ✓ 标出，不再复述记忆归属')
    const status = walk(panel).find((node) => node.props && node.props.className === 'dsh-gw-status')
    assert.equal(status, undefined, '正常情况不显示状态行，把位置留给密钥列表')
    assert.match(text, /切换后下一次请求即生效/)
    assert.match(text, /加入团队/, '面板里要有加入团队的入口')

    const rows = walk(panel).filter((node) => node.type === 'button' && node.props['data-active'] !== undefined)
    assert.equal(rows.length, 2, '两条密钥各一行')
    const [activeRow, otherRow] = rows
    assert.equal(activeRow.props.disabled, true, '当前生效那条不可重复点')
    assert.match(textOf(activeRow), /✓/, '当前那条用勾表示，不再挤一行文字')
    assert.equal(otherRow.props.disabled, false)
    otherRow.props.onClick()
    assert.deepEqual(picked, ['k2'], '只回传被点的非当前条目')
  })

  it('当前 key 不在列表里时才出现状态行（环境变量/手工写入的兜底）', () => {
    const { shipped } = loadBundle()
    const panel = shipped.GatewayKeyPanel({
      data: { ...state, items: [], activeLabel: null, activePrefix: 'ovgw_ZgoEFGI…', configured: true },
      busy: '',
      error: '',
      onPick: () => {},
    })
    const status = walk(panel).find((node) => node.props && node.props.className === 'dsh-gw-status')
    assert.ok(status, '只有这时才需要一行说明')
    assert.match(textOf(status), /ovgw_ZgoEFGI…/)
    assert.match(textOf(status), /不在列表里/)
  })

  it('空列表给出引导文案而不是空白浮层', () => {
    const { shipped } = loadBundle()
    const panel = shipped.GatewayKeyPanel({
      data: { items: [], configured: false, personal: { id: 'k1', label: '陈嘉帅 · 本地默认客户端', prefix: 'ovgw_ZgoE…' } },
      busy: '',
      error: '',
      onPick: () => {},
    })
    const empty = textOf(panel)
    assert.match(empty, /还没有团队/)
    assert.match(empty, /加入团队/, '空列表也要给出加入团队的入口')
    assert.match(empty, /陈嘉帅/, '已绑个人 key 时把身份亮出来')
  })

  it('个人身份缩进标题行右侧：身份标签 + 名字 + 交换箭头，不用名字首字', () => {
    const { shipped } = loadBundle()
    const panel = shipped.GatewayKeyPanel({
      data: {
        items: [{ id: 'k5', label: '研发团队', prefix: 'ovgw_-dCr…', role: 'team', active: true }],
        configured: true,
        activeLabel: '研发团队',
        personal: { id: 'k1', label: '陈嘉帅 · 本地默认客户端', prefix: 'ovgw_ZgoE…' },
      },
      busy: '',
      error: '',
      onPick: () => {},
    })
    const row = walk(panel).find((node) => node.props && node.props.className === 'dsh-gw-head-row')
    assert.ok(row, '标题行容器存在')
    const kids = Array.isArray(row.children) ? row.children : [row.children]
    assert.equal(textOf(kids[0]), '网关密钥', '标题在左')
    assert.match(textOf(kids[1]), /身份/, '用「身份」两个字标识，而不是名字首字')
    assert.match(textOf(kids[1]), /陈嘉帅/, '后面跟名字，只取第一段')
    assert.equal(walk(kids[1]).filter((node) => node.props && node.props.className === 'dsh-gw-me-tag').length, 1)
    assert.equal(walk(kids[1]).filter((node) => node.props && node.props.className === 'dsh-gw-me-avatar').length, 0)
  })

  it('个人 key 也在列表里且排第一，点它就能切回个人网关', () => {
    const { shipped } = loadBundle()
    const picked = []
    const panel = shipped.GatewayKeyPanel({
      data: {
        items: [
          { id: 'k5', label: '研发团队', prefix: 'ovgw_-dCr…', role: 'team', active: true },
          { id: 'k1', label: '陈嘉帅 · 本地默认客户端', prefix: 'ovgw_ZgoE…', role: 'personal', active: false },
        ],
        configured: true,
        activeLabel: '研发团队',
        personal: { id: 'k1', label: '陈嘉帅 · 本地默认客户端', prefix: 'ovgw_ZgoE…' },
      },
      busy: '',
      error: '',
      onPick: (item) => picked.push(item),
    })
    const rows = walk(panel).filter((node) => node.type === 'button' && node.props['data-active'] !== undefined)
    assert.equal(rows.length, 2, '个人 key 和团队 key 都列出来')
    assert.match(textOf(rows[0]), /个人/, '个人 key 排第一并带「个人」标记')
    assert.match(textOf(rows[0]), /陈嘉帅/)
    assert.equal(rows[0].props.title, '切回个人网关（个人记忆）')
    assert.equal(rows[0].props.disabled, false, '当前是团队 key，个人那条必须可点')
    rows[0].props.onClick()
    assert.equal(picked[0].id, 'k1', '点个人那条 = 切回个人 gateway')
    assert.equal(picked[0].role, 'personal')

    const emptyHint = walk(panel).find((node) => node.props && node.props.className === 'dsh-gw-empty')
    assert.equal(emptyHint, undefined, '已经有个人和团队两条，不该再提示「还没有团队」')
  })

  it('只有个人 key 时仍然提示可以加入团队', () => {
    const { shipped } = loadBundle()
    const panel = shipped.GatewayKeyPanel({
      data: {
        items: [{ id: 'k1', label: '陈嘉帅 · 本地默认客户端', prefix: 'ovgw_ZgoE…', role: 'personal', active: true }],
        configured: true,
        activeLabel: '陈嘉帅 · 本地默认客户端',
        personal: { id: 'k1', label: '陈嘉帅 · 本地默认客户端', prefix: 'ovgw_ZgoE…' },
      },
      busy: '',
      error: '',
      onPick: () => {},
    })
    const text = textOf(panel)
    assert.match(text, /陈嘉帅/, '个人 key 在列表里')
    assert.match(text, /还没有团队/, '团队为空仍要给出加入提示')
  })

  it('换绑：一行式编辑条，回车提交、Esc 或 × 取消', () => {
    const { shipped } = loadBundle()
    const typed = []
    let cancelled = 0
    let submitted = 0
    const card = shipped.RebindCard({
      value: '',
      onChange: (text) => typed.push(text),
      onSubmit: () => (submitted += 1),
      onCancel: () => (cancelled += 1),
      busy: false,
      error: '',
    })
    const flat = textOf(card)
    assert.match(flat, /换绑/)
    assert.doesNotMatch(flat, /团队记忆会回流到新 key/, '说明文字不再堆在卡片里')

    const input = walk(card).find((node) => node.type === 'input')
    assert.equal(input.props.type, 'password', '密钥输入不回显')
    assert.match(input.props.placeholder, /换成另一把个人/)
    input.props.onChange({ target: { value: 'ovgw_new' } })
    assert.deepEqual(typed, ['ovgw_new'])
    input.props.onKeyDown({ key: 'Enter' })
    assert.equal(submitted, 1, '回车直接提交')
    input.props.onKeyDown({ key: 'Escape' })
    assert.equal(cancelled, 1, 'Esc 收起')

    walk(card)
      .find((node) => node.props && node.props.className === 'dsh-gw-x')
      .props.onClick()
    assert.equal(cancelled, 2, '× 也能取消')

    const busy = shipped.RebindCard({ value: 'ovgw_new', onChange: () => {}, onSubmit: () => {}, onCancel: () => {}, busy: true, error: '这把 key 不在账号里' })
    const button = walk(busy).find((node) => node.props && node.props.className === 'dsh-gw-btn')
    assert.equal(button.props.disabled, true)
    assert.match(textOf(button), /换绑中…/)
    assert.match(textOf(busy), /不在账号里/, '错误就地显示')
  })

  it('没绑个人 key：先引导绑定，团队入口暂时不出现', () => {
    const { shipped } = loadBundle()
    const bound = []
    const panel = shipped.GatewayKeyPanel({
      data: { items: [], configured: false, needPersonal: true, personal: null },
      busy: '',
      error: '',
      onPick: () => {},
      onBindPersonal: (key) => {
        bound.push(key)
        return { ok: true }
      },
    })
    const flat = textOf(panel)
    assert.match(flat, /先绑定你的个人密钥/)
    assert.match(flat, /团队记忆会回流到这里/, '一句话说清为什么必须先绑')
    const joinButton = walk(panel).find((node) => node.props && node.props.className === 'dsh-gw-join-btn')
    assert.equal(joinButton, undefined, '没个人身份时不渲染团队入口，避免登记不出人')
    const input = walk(panel).find((node) => node.type === 'input')
    assert.equal(input.props.type, 'password', '密钥输入不回显')
    const button = walk(panel).find((node) => node.props && node.props.className === 'dsh-gw-btn')
    button.props.onClick()
    assert.deepEqual(bound, [], '空值直接拒绝，不发请求')
  })

  it('首次渲染只有药丸按钮，浮层是关闭的', () => {
    const { shipped } = loadBundle()
    const tree = shipped.GatewayKeyPill()
    assert.ok(tree.props['data-gw-pill'], '外层要能被「点外面关闭」识别')
    const button = walk(tree).find((node) => node.type === 'button')
    assert.equal(button.props['aria-haspopup'], 'dialog')
    assert.equal(button.props['aria-expanded'], 'false')
    assert.match(textOf(button), /…/, '数据还没到时只显示占位')
    assert.equal(walk(tree).filter((node) => node.props && node.props.role === 'dialog').length, 0, '初始不渲染浮层')
  })

  it('网关药丸里不再塞记忆状态（记忆是另一枚药丸）', () => {
    const { shipped } = loadBundle()
    const tree = shipped.GatewayKeyPill()
    assert.doesNotMatch(textOf(tree), /记忆/)
  })

  it('记忆药丸独立渲染：随 key 绿点、插件模式琥珀点、未知灰点', () => {
    const { shipped } = loadBundle()
    const gateway = shipped.MemoryPillView({ memory: state.memory, keyName: '研发团队' })
    assert.equal(textOf(gateway), '记忆 随研发团队')
    assert.match(gateway.props.title, /openviking 供应商/)

    const plugin = shipped.MemoryPillView({ memory: { mode: 'plugin', user: 'alice', hint: '插件在管' } })
    assert.equal(textOf(plugin), '记忆 alice')
    assert.match(plugin.children[0].props.style.background, /214,\s*160,\s*60/, '插件模式用琥珀色')

    assert.equal(textOf(shipped.MemoryPillView({})), '记忆 …')
  })
})
