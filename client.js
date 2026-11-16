/**
 * gateway-switch —— 浏览器半侧（预构建客户端 bundle）
 *
 * 这个文件由 DSH 的 client-modules 加载器直接执行，格式就是 `window.__ModuleLoader__.load({id, factory})`：
 * 执行它只注册 factory，模块体（含样式与求解）要等第一次 import 才跑。
 *
 * 依赖面刻意收敛到基座表里已有的两个模块：`react`（hooks/createElement）与不需要
 * `react/jsx-runtime`（本文件不用 JSX）。不依赖 UI primitives，避免绑死宿主的组件实现。
 *
 * UI 落点两处：
 *   1. 设置 → 插件 → 「网关密钥」页（slot `plugins.item`）——完整管理；
 *   2. 输入框下方的药丸（slot `conversation.composer.dock`）——随手切换。
 * 与宿主通信：`connection.rpc.call('/gateway-switch', endpoint, payload)`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-gateway-switch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const CHANNEL = '/gateway-switch'

    /** 空操作的安全取值：宿主没有 connection 服务时把状态显示成「不可用」而不是崩掉。 */
    let readConnection = () => undefined

    function h(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return React.createElement(type, props || null, kids)
    }

    /** 一次 RPC 调用，统一成 { ok, value } / { ok:false, error }，绝不抛。 */
    async function call(endpoint, payload) {
      let rpc
      try {
        const connection = readConnection()
        rpc = connection && connection.rpc && typeof connection.rpc.call === 'function' ? connection.rpc : undefined
      } catch {
        rpc = undefined
      }
      if (!rpc) {
        return { ok: false, error: { message: '宿主没有可用的 connection.rpc 通道，无法读写网关密钥。' } }
      }
      try {
        const result = await rpc.call(CHANNEL, endpoint, payload || {})
        if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
          return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error || { message: '调用失败' } }
        }
        return { ok: true, value: result }
      } catch (error) {
        return { ok: false, error: { message: String((error && error.message) || error) } }
      }
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', color: 'inherit', fontSize: 13 },
      head: { display: 'flex', flexDirection: 'column', gap: 4 },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      sub: { opacity: 0.62, fontSize: 12, lineHeight: 1.5 },
      card: {
        display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 10,
        border: '1px solid rgba(127,127,127,0.28)', background: 'rgba(127,127,127,0.06)',
      },
      statusRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      badge: (active) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 11,
        border: '1px solid ' + (active ? 'rgba(64,180,110,0.55)' : 'rgba(127,127,127,0.4)'),
        background: active ? 'rgba(64,180,110,0.16)' : 'transparent',
        color: active ? 'rgb(52,160,96)' : 'inherit', opacity: active ? 1 : 0.75,
      }),
      row: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
        border: '1px solid rgba(127,127,127,0.22)',
      },
      rowMain: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
      rowLabel: { fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tag: { fontSize: 10, lineHeight: '16px', padding: '0 5px', borderRadius: 5, marginRight: 6, background: 'rgba(127,127,127,.16)', fontWeight: 500 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11, opacity: 0.6 },
      button: (tone) => ({
        padding: '5px 10px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.35)',
        background: tone === 'primary' ? 'rgba(76,141,255,0.16)' : tone === 'danger' ? 'rgba(220,80,80,0.14)' : 'transparent',
        color: tone === 'danger' ? 'rgb(200,70,70)' : 'inherit',
      }),
      input: {
        padding: '6px 9px', borderRadius: 7, fontSize: 12, minWidth: 0,
        border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', outline: 'none',
      },
      form: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      line: (tone) => ({
        fontSize: 12, lineHeight: 1.5, padding: '6px 9px', borderRadius: 7,
        border: '1px solid ' + (tone === 'bad' ? 'rgba(220,80,80,0.45)' : tone === 'ok' ? 'rgba(64,180,110,0.45)' : 'rgba(127,127,127,0.3)'),
        background: tone === 'bad' ? 'rgba(220,80,80,0.1)' : tone === 'ok' ? 'rgba(64,180,110,0.1)' : 'rgba(127,127,127,0.08)',
      }),
    }

    /** 开关（role=switch）：切换即写入凭据，无二次确认。 */
    function Toggle(props) {
      const { checked, disabled, onToggle, label } = props
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled: Boolean(disabled),
          onClick: onToggle,
          style: {
            position: 'relative', flex: '0 0 auto', width: 38, height: 21, padding: 0, borderRadius: 999,
            cursor: disabled ? 'default' : 'pointer', transition: 'background 150ms ease, border-color 150ms ease',
            border: '1px solid ' + (checked ? 'rgba(76,141,255,0.7)' : 'rgba(127,127,127,0.45)'),
            background: checked ? 'rgba(76,141,255,0.85)' : 'rgba(127,127,127,0.18)',
            opacity: disabled ? 0.55 : 1,
          },
        },
        h('span', {
          style: {
            position: 'absolute', top: 2, left: checked ? 19 : 2, width: 15, height: 15, borderRadius: '50%',
            background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transition: 'left 150ms ease',
          },
        }),
      )
    }

    /**
     * 「设置 → 插件 → 网关密钥」页面。
     * 所有状态都在组件内部（hooks），不依赖 slot 注入的 controller，避免绑定宿主内部实现。
     */
    function GatewaySwitchPage() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [draftKey, setDraftKey] = React.useState('')
      const [personalDraft, setPersonalDraft] = React.useState('')
      const [pendingRemove, setPendingRemove] = React.useState('')
      const [probes, setProbes] = React.useState({})

      const applyResult = React.useCallback((res, done) => {
        setBusy('')
        if (!res || !res.ok) {
          setError((res && res.error && res.error.message) || '调用失败')
          return
        }
        setError('')
        if (res.value && Array.isArray(res.value.items)) setData(res.value)
        if (typeof done === 'string') setNotice(done)
      }, [])

      const run = React.useCallback(
        async (endpoint, payload, done) => {
          setBusy(endpoint)
          setNotice('')
          applyResult(await call(endpoint, payload), done)
        },
        [applyResult],
      )

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          const res = await call('state', {})
          if (!alive) return
          if (res.ok && res.value && Array.isArray(res.value.items)) setData(res.value)
          else setError((res.error && res.error.message) || '读取密钥列表失败')
        })()
        return () => {
          alive = false
        }
      }, [])

      const items = (((data && data.items) || []).slice()).sort(
        (a, b) => (b.role === 'personal' ? 1 : 0) - (a.role === 'personal' ? 1 : 0),
      )
      const activeItem = items.find((item) => item.active)

      const onAdd = async () => {
        if (!draftKey.trim()) {
          setError('请粘贴 Gateway Key')
          return
        }
        setBusy('add')
        setNotice('')
        const res = await call('add', { key: draftKey })
        setBusy('')
        if (!res.ok) {
          setError((res.error && res.error.message) || '保存失败')
          return
        }
        if (res.value && Array.isArray(res.value.items)) setData(res.value)
        setError('')
        setDraftKey('')
        setNotice('已添加，名字取自网关。用右侧开关切换即可生效。')
      }

      const onBindPersonal = async () => {
        if (!personalDraft.trim()) {
          setError('请粘贴你自己的个人 Gateway Key')
          return
        }
        setBusy('bindPersonal')
        setNotice('')
        const res = await call('bindPersonal', { key: personalDraft })
        setBusy('')
        if (!res.ok) {
          setError((res.error && res.error.message) || '绑定失败')
          return
        }
        if (res.value && Array.isArray(res.value.items)) setData(res.value)
        setError('')
        setPersonalDraft('')
        setNotice('个人密钥已绑定，团队记忆会回流到它对应的用户。')
      }

      const onProbe = async (id) => {
        setBusy('probe')
        setNotice('')
        const res = await call('probe', id ? { id } : {})
        setBusy('')
        if (!res.ok) {
          setError((res.error && res.error.message) || '探活失败')
          return
        }
        setProbes((prev) => ({ ...prev, [id || '__active__']: res.value }))
      }

      const header = h(
        'div',
        { style: S.head },
        h('h3', { style: S.title }, '网关密钥'),
        h(
          'div',
          { style: S.sub },
          '切换后下一次请求就生效，不需要重启 DSH。',
          data ? h('span', null, ' 凭据引用：', h('code', { style: S.mono }, data.credentialRef), ' · 网关：', h('code', { style: S.mono }, data.gatewayBaseURL)) : null,
        ),
      )

      const status = h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.statusRow },
          h('span', { style: S.badge(Boolean(data && data.configured)) }, data && data.configured ? '● 已配置' : '○ 未配置'),
          data && data.configured ? h('code', { style: S.mono }, data.activePrefix) : h('span', { style: S.sub }, data ? '当前没有任何生效密钥' : '正在读取…'),
          data
            ? activeItem
              ? h('span', { style: S.sub }, '（来自列表：' + activeItem.label + '）')
              : data.configured
                ? h('span', { style: S.sub }, '（不在列表中，可能是环境变量或手工写入的）')
                : null
            : null,
          h('button', { type: 'button', style: S.button(), disabled: Boolean(busy), onClick: () => onProbe('') }, '测试当前'),
          h('button', { type: 'button', style: S.button(), disabled: Boolean(busy), onClick: () => run('state', {}) }, '刷新'),
          data && data.writable === false ? h('span', { style: S.sub }, '（当前部署的凭据存储只读）') : null,
        ),
        probes.__active__
          ? h('div', { style: S.line(probes.__active__.ok ? 'ok' : 'bad') }, '探活结果：' + probes.__active__.detail)
          : null,
      )

      const personalCard = h(
        'div',
        { style: S.card },
        h('div', { style: S.rowLabel }, '个人密钥（回流落点）'),
        data && data.personal
          ? h('div', { style: S.sub }, '当前：', h('code', { style: S.mono }, data.personal.label), ' · 团队记忆会回流到它对应的用户')
          : h('div', { style: S.sub }, '还没绑定。没有它就只能切换 key，团队记忆不知道该回流给谁。'),
        h(
          'div',
          { style: S.form },
          h('input', {
            style: { ...S.input, flex: '1 1 260px' },
            placeholder: data && data.personal ? '粘贴新的个人 ovgw_… 即可换绑' : '粘贴你自己的个人 ovgw_…',
            type: 'password',
            value: personalDraft,
            onChange: (event) => setPersonalDraft(event.target.value),
          }),
          h(
            'button',
            { type: 'button', style: S.button('primary'), disabled: Boolean(busy), onClick: onBindPersonal },
            busy === 'bindPersonal' ? '绑定中…' : data && data.personal ? '换绑' : '绑定',
          ),
        ),
      )

      const list = items.length
        ? items.map((item) =>
            h(
              'div',
              { key: item.id, style: S.row },
              h(Toggle, {
                checked: item.active,
                disabled: Boolean(busy) || (data && data.writable === false),
                label: '切换到 ' + item.label,
                onToggle: () => {
                  if (item.active) return
                  run('activate', { id: item.id }, '已切换到「' + item.label + '」，下一次请求即生效。')
                },
              }),
              h(
                'div',
                { style: S.rowMain },
                h(
                  'div',
                  { style: S.rowLabel },
                  item.role === 'personal' ? h('span', { style: S.tag }, '个人') : null,
                  item.label,
                ),
                h('div', { style: S.mono }, item.prefix),
              ),
              h('button', { type: 'button', style: S.button(), disabled: Boolean(busy), onClick: () => onProbe(item.id) }, '测试'),
              pendingRemove === item.id
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.button('danger'),
                      disabled: Boolean(busy),
                      onClick: () => {
                        setPendingRemove('')
                        run('remove', { id: item.id }, '已删除该条目（若它正生效，当前值不会被清掉）。')
                      },
                    },
                    '确认删除',
                  )
                : h('button', { type: 'button', style: S.button(), disabled: Boolean(busy), onClick: () => setPendingRemove(item.id) }, '删除'),
              probes[item.id] ? h('span', { style: S.mono }, probes[item.id].ok ? '✓ ' + probes[item.id].modelCount + ' 模型' : '✗ ' + probes[item.id].detail) : null,
            ),
          )
        : h('div', { style: S.sub }, '还没有保存任何密钥。把常用的 Gateway Key 加进来，以后一键切换。')

      const addForm = h(
        'div',
        { style: S.card },
        h('div', { style: S.rowLabel }, '添加一把密钥'),
        h(
          'div',
          { style: S.form },
          h('input', {
            style: { ...S.input, flex: '1 1 260px' },
            placeholder: '粘贴 ovgw_... 或 sk-...',
            type: 'password',
            value: draftKey,
            onChange: (event) => setDraftKey(event.target.value),
          }),
          h('button', { type: 'button', style: S.button('primary'), disabled: Boolean(busy), onClick: onAdd }, busy === 'add' ? '保存中…' : '保存'),
        ),
        h('div', { style: S.sub }, '密钥只存在本机 ', h('code', { style: S.mono }, '$DSH_HOME/gateway-switch/keys.json'), '，不会进设置文档，也不会回传给界面。'),
      )

      return h(
        'section',
        { style: S.root },
        header,
        error ? h('div', { style: S.line('bad') }, error) : null,
        notice ? h('div', { style: S.line('ok') }, notice) : null,
        status,
        personalCard,
        h('div', { style: { ...S.card, padding: items.length ? 8 : 12 } }, list),
        addForm,
      )
    }

    /** 网关里的名字常写成「陈嘉帅 · 本地默认客户端」，药丸上只取第一段。 */
    function shortLabel(label) {
      const text = String(label || '')
      const cut = text.indexOf(' · ')
      return cut > 0 ? text.slice(0, cut) : text
    }

    /** 药丸上显示这把 key 在网关里的名字（如「研发团队」）；查不到才退回掩码。 */
    function pillText(data) {
      if (!data) return '…'
      if (!data.configured) return '网关未配置'
      if (data.activeLabel) return shortLabel(data.activeLabel)
      return '网关 ' + (data.activePrefix || '已配置')
    }

    /** 第二行：记忆通道与空间，告诉长官「切 key 会不会带走记忆」。 */
    function memoryLabel(memory, keyName) {
      if (!memory || !memory.mode) return '记忆 …'
      if (memory.mode === 'gateway') return '记忆 随' + (keyName ? shortLabel(keyName) : 'key')
      if (memory.user) return '记忆 ' + memory.user
      return '记忆 插件'
    }

    /** 记忆状态的强调色：网关模式跟 key 走（主题绿），插件模式身份固定（琥珀）。 */
    function memoryTone(memory) {
      if (!memory || !memory.mode) return 'rgba(127,127,127,0.7)'
      return memory.mode === 'gateway' ? 'var(--dsw-alias-state-success-primary,#2ea36a)' : 'rgb(214,160,60)'
    }

    /**
     * 输入区药丸的样式表：数值对齐宿主自带的统计药丸（`dsh-client-ui-chat` 的
     * StatsPills 模块：24px 高、999 圆角、12/18 字号、`--dsw-alias-bg-layer-2` 底、
     * hover 用 `--dsw-alias-interactive-bg-hover`），变量缺失时回落到 Canvas 系颜色。
     */
    const CSS = [
      '.dsh-gw-dock{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}',
      '.dsh-gw-pill{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:none;',
      'border-radius:999px;font-size:12px;line-height:18px;min-width:0;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary,CanvasText);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.dsh-gw-pill-button{cursor:pointer;transition:background .15s ease}',
      '.dsh-gw-pill-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22))}',
      '.dsh-gw-pill-button[aria-expanded="true"]{color:var(--dsw-alias-label-primary,CanvasText);',
      'background:var(--dsw-alias-button-ghost-active-fill,rgba(127,127,127,.18))}',
      '.dsh-gw-pill-static{cursor:default}',
      '.dsh-gw-label{overflow:hidden;text-overflow:ellipsis;max-width:180px}',
      '.dsh-gw-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}',
      '.dsh-gw-caret{flex:none;opacity:.5;transition:transform .12s ease}',
      '.dsh-gw-panel{position:fixed;width:300px;padding:8px;display:flex;flex-direction:column;gap:1px;border-radius:14px;font-size:12px;line-height:18px;corner-shape:round;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3));z-index:2147483000}',
      '.dsh-gw-head{padding:4px 8px 6px;display:flex;flex-direction:column;gap:3px}',
      '.dsh-gw-head-title{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-gw-head-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsh-gw-me{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px 0 3px;border:0;border-radius:999px;',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;',
      'max-width:150px;cursor:pointer;transition:background .15s ease,color .15s ease}',
      '.dsh-gw-me:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary)}',
      '.dsh-gw-me-tag{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:5px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary)}',
      '.dsh-gw-row-tag{flex:none;font-size:10px;line-height:15px;padding:0 5px;border-radius:5px;margin-right:2px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary);',
      'align-self:center}',
      '.dsh-gw-me-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-gw-me svg{flex:none;opacity:.45}',
      '.dsh-gw-status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-gw-status-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}',
      '.dsh-gw-sep{height:1px;margin:4px 4px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.25));opacity:.5}',
      '.dsh-gw-meta{font-size:11px;opacity:.7;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dsh-gw-hint{font-size:11px;opacity:.5;line-height:1.45;margin-top:2px}',
      '.dsh-gw-row{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dsh-gw-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.dsh-gw-row[data-active="1"]{cursor:default;background:var(--dsw-alias-button-ghost-active-fill,rgba(127,127,127,.14));box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border,rgba(127,127,127,.2))}',
      '.dsh-gw-row:disabled{opacity:.9}',
      '.dsh-gw-row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-gw-prefix{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;opacity:.5}',
      '.dsh-gw-check{flex:none;width:14px;text-align:center;font-size:11px;color:var(--dsw-alias-state-success-primary,#2ea36a)}',
      '.dsh-gw-empty{padding:6px 8px;font-size:11px;opacity:.6;line-height:1.5}',
      '.dsh-gw-join{display:flex;flex-direction:column;gap:6px;padding:4px 4px 2px}',
      '.dsh-gw-join-btn{display:flex;align-items:center;justify-content:center;gap:6px;height:30px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-gw-join-btn:hover{color:var(--dsw-alias-label-primary);border-color:transparent;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.dsh-gw-plus{font-size:13px;line-height:1;margin-top:-1px}',
      '.dsh-gw-input{flex:1;min-width:0;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
      '.dsh-gw-input:focus{border-color:var(--dsw-alias-label-secondary)}',
      '.dsh-gw-btn{flex:none;height:30px;padding:0 12px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill,#1f2328);color:var(--dsw-alias-label-inverse,#fff);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-gw-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#000)}',
      '.dsh-gw-msg{font-size:11px;padding:0 2px}',
      '.dsh-gw-notice{font-size:11px;padding:0 2px;color:var(--dsw-alias-state-success-primary,#2ea36a)}',
      '.dsh-gw-error{font-size:11px;padding:0 2px;color:#d9534f}',
      '.dsh-gw-onboard{display:flex;flex-direction:column;gap:8px;padding:4px 6px 8px}',
      '.dsh-gw-onboard-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-gw-onboard-text{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dsh-gw-link{border:0;background:none;padding:0;font-size:11px;color:var(--dsw-alias-label-secondary);text-decoration:underline;cursor:pointer}',
      '.dsh-gw-link:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-gw-chip{flex:none;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:18px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-secondary);transition:background .15s ease,color .15s ease,border-color .15s ease}',
      '.dsh-gw-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary);border-color:transparent}',
      '.dsh-gw-rebind{display:flex;flex-direction:column;gap:2px}',
      '.dsh-gw-rebind-row{display:flex;align-items:center;gap:6px;padding:6px 8px 2px}',
      '.dsh-gw-x{flex:none;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer}',
      '.dsh-gw-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary)}',
      '.dsh-gw-foot{padding:6px 8px 2px;font-size:11px;opacity:.45;line-height:1.45}',
    ].join('')

    /** 把样式表挂进宿主文档一次；在无 document 的环境（单测）里静默跳过。 */
    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById('dsh-gateway-switch-css')) return
      const style = document.createElement('style')
      style.id = 'dsh-gateway-switch-css'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** 浮层本体（纯展示）：容器把 state 传进来，方便单测直接渲染。 */
    /** 换绑：一行式编辑条，标题与说明都省掉，位置本身说明它改的是上面那个人。 */
    function RebindCard(props) {
      const { value, onChange, onSubmit, onCancel, busy, error } = props
      return h(
        'div',
        { className: 'dsh-gw-rebind' },
        h(
          'div',
          { className: 'dsh-gw-rebind-row' },
          h('input', {
            className: 'dsh-gw-input',
            type: 'password',
            autoFocus: true,
            placeholder: '换成另一把个人 ovgw_…',
            value: value || '',
            onChange: (event) => onChange(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onSubmit()
              if (event.key === 'Escape') onCancel()
            },
          }),
          h(
            'button',
            { className: 'dsh-gw-btn', type: 'button', disabled: Boolean(busy), onClick: onSubmit },
            busy ? '换绑中…' : '换绑',
          ),
          h('button', { className: 'dsh-gw-x', type: 'button', title: '取消', 'aria-label': '取消换绑', onClick: onCancel }, '×'),
        ),
        error ? h('div', { className: 'dsh-gw-error' }, error) : null,
      )
    }

    /** 右上角的个人身份：头像字 + 名字 + 交换箭头，点了就地展开换绑行。 */
    function PersonalChip(props) {
      const { label, onClick } = props
      const name = shortLabel(label) || '我'
      return h(
        'button',
        {
          className: 'dsh-gw-me',
          type: 'button',
          title: '个人身份：' + (label || '') + '（点击换绑）',
          onClick,
        },
        h('span', { className: 'dsh-gw-me-tag' }, '身份'),
        h('span', { className: 'dsh-gw-me-name' }, name),
        h(
          'svg',
          { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' },
          h('path', {
            d: 'M1.6 3.6h5.1L5.2 2.1M8.4 6.4H3.3l1.5 1.5',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': 1.1,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
        ),
      )
    }

    function GatewayKeyPanel(props) {
      const { data, busy, error, pos, onPick, onJoin, onBindPersonal } = props
      const allItems = (data && data.items) || []
      const teamItems = allItems.filter((item) => item.role !== 'personal')
      const personalRow = allItems.find((item) => item.role === 'personal') || null
      const items = personalRow ? [personalRow, ...teamItems] : teamItems
      const personal = (data && data.personal) || null
      const needPersonal = Boolean(data && data.needPersonal)
      const [bindDraft, setBindDraft] = React.useState('')
      const [binding, setBinding] = React.useState(false)
      const [bindError, setBindError] = React.useState('')
      const [rebind, setRebind] = React.useState(false)
      const [openJoin, setOpenJoin] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [joining, setJoining] = React.useState(false)
      const [joinError, setJoinError] = React.useState('')
      const [joined, setJoined] = React.useState('')
      ensureStyle()

      const submitBind = async () => {
        const key = bindDraft.trim()
        if (!key) {
          setBindError('先粘贴你自己的个人 gateway key')
          return
        }
        setBinding(true)
        setBindError('')
        const out = (await (onBindPersonal ? onBindPersonal(key) : { ok: false, error: '当前环境不支持绑定' })) || {}
        setBinding(false)
        if (!out.ok) {
          setBindError(out.error || '绑定失败')
          return
        }
        setBindDraft('')
        setRebind(false)
      }

      const submitJoin = async () => {
        const key = draft.trim()
        if (!key) {
          setJoinError('先粘贴团队给的 gateway key')
          return
        }
        setJoining(true)
        setJoinError('')
        setJoined('')
        const out = (await (onJoin ? onJoin(key) : { ok: false, error: '当前环境不支持加入' })) || {}
        setJoining(false)
        if (!out.ok) {
          setJoinError(out.error || '加入失败')
          return
        }
        setDraft('')
        setOpenJoin(false)
        const registered = out.join && out.join.ok
        setJoined(
          '已加入「' + (out.label || '新团队') + '」，已切换' +
            (registered ? '，回流登记完成' : '；回流登记待确认，下次打开面板会自动重试'),
        )
      }
      return h(
        'div',
        {
          role: 'dialog',
          'aria-label': '切换网关密钥',
          className: 'dsh-gw-panel',
          style: { right: (pos && pos.right) || 16, bottom: (pos && pos.bottom) || 92 },
        },
        h(
          'div',
          { className: 'dsh-gw-head' },
          h(
            'div',
            { className: 'dsh-gw-head-row' },
            h('div', { className: 'dsh-gw-head-title' }, '网关密钥'),
            personal && !rebind && !needPersonal
              ? h(PersonalChip, {
                  label: personal.label,
                  onClick: () => {
                    setBindError('')
                    setRebind(true)
                  },
                })
              : null,
          ),
          data && data.configured && !data.activeLabel
            ? h(
                'div',
                { className: 'dsh-gw-status', title: (data.memory && data.memory.hint) || '' },
                h('span', { className: 'dsh-gw-dot', style: { background: 'rgba(127,127,127,.55)' } }),
                h('span', { className: 'dsh-gw-status-name' }, data.activePrefix || '未命名'),
                h('span', null, '· 不在列表里'),
              )
            : null,
        ),
        h('div', { className: 'dsh-gw-sep' }),
        error ? h('div', { style: S.line('bad') }, error) : null,
        needPersonal
          ? h(
              'div',
              { className: 'dsh-gw-onboard' },
              h('div', { className: 'dsh-gw-onboard-title' }, '先绑定你的个人密钥'),
              h(
                'div',
                { className: 'dsh-gw-onboard-text' },
                '粘贴你平时用的那把个人 gateway key，团队记忆会回流到这里。',
              ),
              h(
                'div',
                { className: 'dsh-gw-join-row' },
                h('input', {
                  className: 'dsh-gw-input',
                  type: 'password',
                  autoFocus: true,
                  placeholder: '粘贴你的个人 ovgw_…',
                  value: bindDraft,
                  onChange: (event) => setBindDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitBind()
                  },
                }),
                h(
                  'button',
                  { className: 'dsh-gw-btn', type: 'button', disabled: binding, onClick: submitBind },
                  binding ? '绑定中…' : '绑定',
                ),
              ),
              bindError ? h('div', { className: 'dsh-gw-error' }, bindError) : null,
            )
          : null,
        rebind
          ? h(RebindCard, {
              value: bindDraft,
              onChange: setBindDraft,
              onSubmit: submitBind,
              onCancel: () => {
                setBindError('')
                setRebind(false)
              },
              busy: binding,
              error: bindError,
            })
          : null,
        items.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'dsh-gw-row',
                  'data-active': item.active ? '1' : '0',
                  disabled: Boolean(busy) || Boolean(item.active),
                  title: item.active
                    ? '当前使用中'
                    : item.role === 'personal'
                      ? '切回个人网关（个人记忆）'
                      : '切换到 ' + item.label,
                  onClick: () => onPick && onPick(item),
                },
                item.role === 'personal' ? h('span', { className: 'dsh-gw-row-tag' }, '个人') : null,
                h('span', { className: 'dsh-gw-row-label' }, item.label),
                h('span', { className: 'dsh-gw-prefix' }, item.prefix),
                h('span', { className: 'dsh-gw-check' }, item.active ? '✓' : busy === item.id ? '·' : ''),
              ),
            ),
        items.length === 0 || (!needPersonal && teamItems.length === 0)
          ? h('div', { className: 'dsh-gw-empty' }, needPersonal ? '绑定个人密钥后才出现团队入口。' : '还没有团队。下面粘贴团队给的 key 就能加入。')
          : null,
        h('div', { className: 'dsh-gw-sep' }),
        needPersonal
          ? null
          : h(
          'div',
          { className: 'dsh-gw-join' },
          joined ? h('div', { className: 'dsh-gw-notice' }, joined) : null,
          joinError ? h('div', { className: 'dsh-gw-error' }, joinError) : null,
          openJoin
            ? h(
                'div',
                { className: 'dsh-gw-join-row' },
                h('input', {
                  className: 'dsh-gw-input',
                  type: 'password',
                  autoFocus: true,
                  placeholder: '粘贴团队给的 ovgw_…',
                  value: draft,
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitJoin()
                  },
                }),
                h(
                  'button',
                  { className: 'dsh-gw-btn', type: 'button', disabled: joining, onClick: submitJoin },
                  joining ? '加入中…' : '加入',
                ),
              )
            : h(
                'button',
                { className: 'dsh-gw-join-btn', type: 'button', onClick: () => setOpenJoin(true) },
                h('span', { className: 'dsh-gw-plus' }, '+'),
                h('span', null, '加入团队'),
              ),
        ),
        h('div', { className: 'dsh-gw-foot' }, '切换后下一次请求即生效，不用重启'),
      )
    }

    /**
     * 输入框下方的网关密钥药丸（slot `conversation.composer.dock`）。
     * 交互对齐宿主自带统计药丸：点开自己的浮层，Escape / 点外面 / 选中即关闭。
     */
    function GatewayKeyPill() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState({ right: 16, bottom: 92 })

      const load = React.useCallback(async () => {
        const res = await call('state', {})
        if (res.ok && res.value && Array.isArray(res.value.items)) {
          setData(res.value)
          setError('')
        } else {
          setError((res.error && res.error.message) || '读取密钥列表失败')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onDown = (event) => {
          const target = event.target
          if (target && typeof target.closest === 'function' && target.closest('[data-gw-pill]')) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onDown, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onDown, true)
        }
      }, [open])

      const onToggle = (event) => {
        if (open) {
          setOpen(false)
          return
        }
        const rect =
          event && event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
            ? event.currentTarget.getBoundingClientRect()
            : null
        if (rect && typeof window !== 'undefined') {
          setPos({
            right: Math.max(8, window.innerWidth - rect.right),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
          })
        }
        setOpen(true)
        load()
      }

      const onPick = async (item) => {
        if (!item || item.active) return
        setBusy(item.id)
        const res = await call('activate', { id: item.id })
        setBusy('')
        if (!res.ok) {
          setError((res.error && res.error.message) || '切换失败')
          return
        }
        if (res.value && Array.isArray(res.value.items)) {
          setData(res.value)
          publishState(res.value)
        }
        setError('')
        setOpen(false)
      }

      const onJoin = async (key) => {
        setBusy('join')
        const res = await call('add', { key, activate: true })
        setBusy('')
        if (!res.ok) return { ok: false, error: (res.error && res.error.message) || '加入失败' }
        if (res.value && Array.isArray(res.value.items)) {
          setData(res.value)
          publishState(res.value)
        }
        return { ok: true, label: res.value && res.value.activeLabel, join: res.value && res.value.join }
      }

      const onBindPersonal = async (key) => {
        setBusy('bind')
        const res = await call('bindPersonal', { key, activate: true })
        setBusy('')
        if (!res.ok) return { ok: false, error: (res.error && res.error.message) || '绑定失败' }
        if (res.value && Array.isArray(res.value.items)) {
          setData(res.value)
          publishState(res.value)
        }
        return { ok: true }
      }

      const active = data ? data.items.find((item) => item.active) : null
      const configured = Boolean(data && data.configured)
      ensureStyle()

      return h(
        'span',
        { 'data-gw-pill': '1', className: 'dsh-gw-dock' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-gw-pill dsh-gw-pill-button',
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            title: active ? '当前网关密钥：' + active.label : configured ? '当前网关密钥不在列表里' : '网关密钥未配置',
            onClick: onToggle,
          },
          h('span', {
            className: 'dsh-gw-dot',
            style: {
              background: configured
                ? 'var(--dsw-alias-state-success-primary,#2ea36a)'
                : 'rgba(127,127,127,.7)',
            },
          }),
          h('span', { className: 'dsh-gw-label' }, pillText(data)),
          h(
            'svg',
            {
              className: 'dsh-gw-caret',
              width: 10,
              height: 10,
              viewBox: '0 0 10 10',
              'aria-hidden': 'true',
              style: { transform: open ? 'rotate(180deg)' : 'none' },
            },
            h('path', {
              d: 'M2 6.2 5 3.4 8 6.2',
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': 1.2,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
            }),
          ),
        ),
        open ? h(GatewayKeyPanel, { data, busy, error, pos, onPick, onJoin, onBindPersonal }) : null,
      )
    }

    /**
     * 记忆状态（只读）：挂在宿主统计药丸那一排，颜色表达记忆归属。
     * 与网关药丸分开注册，两个 slot 各放一枚，避免同一处出现两颗药丸。
     */
    function MemoryPillView(props) {
      const memory = props && props.memory
      const keyName = props && props.keyName
      ensureStyle()
      return h(
        'span',
        { className: 'dsh-gw-pill dsh-gw-pill-static', title: (memory && memory.hint) || '' },
        h('span', { className: 'dsh-gw-dot', style: { background: memoryTone(memory) } }),
        h('span', { className: 'dsh-gw-label' }, memoryLabel(memory, keyName)),
      )
    }

    /** 切换成功后广播最新 state，让另一枚药丸立刻跟着变。 */
    const STATE_EVENT = 'dsh-gateway-switch:state'

    function publishState(value) {
      if (typeof window === 'undefined' || !value) return
      try {
        window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: value }))
      } catch {
        // 老环境没有 CustomEvent 就算了，药丸下次挂载仍会自读
      }
    }

    /** 记忆药丸的容器：自己读一次 state，并订阅网关药丸切换后的广播。 */
    function MemoryPill() {
      const [data, setData] = React.useState(null)
      const load = React.useCallback(async () => {
        const res = await call('state', {})
        if (res.ok && res.value) setData(res.value)
      }, [])
      React.useEffect(() => {
        load()
      }, [load])
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onState = (event) => {
          if (event && event.detail) setData(event.detail)
        }
        window.addEventListener(STATE_EVENT, onState)
        return () => window.removeEventListener(STATE_EVENT, onState)
      }, [])
      return h(MemoryPillView, { memory: data && data.memory, keyName: data && data.activeLabel })
    }

    /** 诊断上报：不等待、不抛错，只给服务端的 trace.log 留一行。 */
    function trace(tag, extra) {
      void call('trace', { tag, extra })
    }

    const tracedSlots = {}

    /** 包一层：首次真正渲染时上报一次是哪个 slot 挂上了，便于排查「UI 不出现」。 */
    function traced(slotName, Component) {
      return function TracedPill(props) {
        if (!tracedSlots[slotName]) {
          tracedSlots[slotName] = true
          trace('client:render', slotName)
        }
        return Component(props)
      }
    }

    exports.name = 'gateway-switch-client'
    exports.inject = ['slots']
    exports.GatewaySwitchPage = GatewaySwitchPage
    exports.GatewayKeyPill = GatewayKeyPill
    exports.MemoryPill = MemoryPill
    exports.MemoryPillView = MemoryPillView
    exports.GatewayKeyPanel = GatewayKeyPanel
    exports.RebindCard = RebindCard
    exports.pillText = pillText
    exports.shortLabel = shortLabel
    exports.memoryLabel = memoryLabel
    exports.Toggle = Toggle
    exports.traced = traced
    exports.apply = function apply(ctx) {
      readConnection = () => {
        try {
          return typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
        } catch {
          return undefined
        }
      }
      trace('client:apply', 'slots=' + typeof ctx.slots)
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.item', () => {
            trace('client:inject', 'plugins.item')
            return ctx.slots.register(
              {
                name: 'plugins.item',
                id: 'gateway-switch',
                order: 40,
                label: () => '网关密钥',
                inject: () => ({}),
              },
              GatewaySwitchPage,
            )
          }),
        'gateway-switch: settings page',
      )
      // 记忆状态：挂在宿主统计药丸那一排（缓存命中、tokens 旁边），只读。
      ensureStyle()
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.composer.dock', () => {
            trace('client:inject', 'conversation.composer.dock')
            return ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'gateway-memory',
                order: 20,
                inject: () => ({}),
              },
              traced('conversation.composer.dock', MemoryPill),
            )
          }),
        'gateway-switch: memory pill',
      )
      // 网关密钥切换：输入框右侧、模型切换的紧左边。
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.right', () => {
            trace('client:inject', 'conversation.input.right')
            return ctx.slots.register(
              {
                name: 'conversation.input.right',
                id: 'gateway-key',
                order: 30,
                inject: () => ({}),
              },
              traced('conversation.input.right', GatewayKeyPill),
            )
          }),
        'gateway-switch: gateway pill',
      )
    }
    return module.exports
  },
})
