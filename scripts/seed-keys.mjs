#!/usr/bin/env node
/**
 * 把本机 OpenViking 的 Gateway Key 灌进切换器。
 *
 * 默认只灌「你自己」和「当前生效的那把」，同事的 key 需要显式 --all-local 才会进来：
 * 把它们一股脑塞进切换 UI，等于把误点一下就能以别人身份请求网关的风险做进界面里。
 *
 * 用法：
 *   node scripts/seed-keys.mjs                    # 我 + 当前生效
 *   node scripts/seed-keys.mjs --all-local        # 本地清单里全部 19 个
 *   node scripts/seed-keys.mjs --user Lisen_Zhang # 再指定几个（可重复）
 *   node scripts/seed-keys.mjs --dry-run
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const STORE = join(DSH_HOME, 'gateway-switch', 'keys.json')
const INVENTORY = join(homedir(), '.openviking', 'local-key-inventory.md')
const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')
const SELF = 'alice'

const args = { allLocal: false, dryRun: false, users: [] }
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (arg === '--all-local') args.allLocal = true
  else if (arg === '--dry-run') args.dryRun = true
  else if (arg === '--user') args.users.push(process.argv[++i])
  else throw new Error(`未知参数：${arg}`)
}

/** 解析 local-key-inventory.md 的表格行：姓名 | user_id | 前缀 | 完整 key */
function readInventory() {
  if (!existsSync(INVENTORY)) throw new Error(`找不到本地清单：${INVENTORY}`)
  const rows = []
  const pattern = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`(ovgw_[^`]+)`\s*\|\s*`(ovgw_[^`]+)`\s*\|/
  for (const line of readFileSync(INVENTORY, 'utf8').split(/\r?\n/)) {
    const match = pattern.exec(line)
    if (!match) continue
    rows.push({ name: match[1].trim(), userId: match[2].trim(), key: match[4].trim() })
  }
  return rows
}

/** 当前凭据库里生效的那把（只在本地读，不外传） */
function readActiveKey() {
  if (!existsSync(CREDENTIALS)) return ''
  const match = /^\s+OPENVIKING_GATEWAY_KEY:\s*(\S+)\s*$/m.exec(readFileSync(CREDENTIALS, 'utf8'))
  return match ? match[1] : ''
}

function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE, 'utf8'))
    return {
      nextId: Number.isInteger(parsed.nextId) ? parsed.nextId : 1,
      items: Array.isArray(parsed.items) ? parsed.items.filter((i) => i && i.id && i.key) : [],
    }
  } catch {
    return { nextId: 1, items: [] }
  }
}

const inventory = readInventory()
const byUser = new Map(inventory.map((row) => [row.userId, row]))
const store = readStore()
const known = new Set(store.items.map((item) => item.key))

function pick() {
  const wanted = []
  if (args.allLocal) wanted.push(...inventory)
  else {
    const self = byUser.get(SELF)
    if (self) wanted.push(self)
    for (const userId of args.users) {
      const row = byUser.get(userId)
      if (!row) throw new Error(`本地清单里没有 user_id=${userId}`)
      wanted.push(row)
    }
  }
  return wanted
}

const additions = []
for (const row of pick()) {
  if (known.has(row.key)) continue
  const label = row.userId === SELF ? `本地 · 我（${row.name}）` : `本地 · ${row.name}（${row.userId}）`
  additions.push({ label, key: row.key })
}
const active = readActiveKey()
if (active && !known.has(active) && !additions.some((item) => item.key === active)) {
  additions.push({ label: '当前生效（原有，来源不在清单里）', key: active })
}

if (additions.length === 0) {
  console.log('没有需要新增的条目；切换器里已有这些 key。')
  process.exit(0)
}

if (args.dryRun) {
  console.log(`[dry-run] 将新增 ${additions.length} 条到 ${STORE}：`)
  for (const item of additions) console.log(`  - ${item.label}  ${item.key.slice(0, 9)}…`)
  process.exit(0)
}

for (const item of additions) {
  store.items.push({ id: `k${store.nextId}`, label: item.label, key: item.key })
  store.nextId += 1
}
mkdirSync(dirname(STORE), { recursive: true })
const tmp = `${STORE}.${process.pid}.tmp`
writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
renameSync(tmp, STORE)

console.log(`已写入 ${additions.length} 条到 ${STORE}（共 ${store.items.length} 条）：`)
for (const item of additions) console.log(`  - ${item.label}  ${item.key.slice(0, 9)}…`)
if (!args.allLocal && inventory.length > args.users.length + 1) {
  console.log(`\n本地清单里还有 ${inventory.length - 1 - args.users.length} 个同事的 key 没加。要一起加：--all-local；只加某几个：--user <user_id>`)
}
