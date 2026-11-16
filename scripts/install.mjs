#!/usr/bin/env node
/**
 * 把本插件装进某个 DSH profile —— 「最小爆炸半径」版。
 *
 * 只做三件事，全部可逆：
 *   1. 复制插件到 `<profile>/node_modules/dsh-plugin-gateway-switch`
 *   2. `<profile>/package.json` 的 dependencies 里登记 `file:` 依赖
 *   3. 往 `<profile>/cordis.patch.yml` 末尾追加一个带哨兵的托管块
 *
 * 为什么不去改 `dsh.profile.bundles`：bundle 列表决定「组合哪些 patch 层」，改错会
 * 影响整个 profile 的组合；而这里只是往 patch 层插一条 Loader 条目，包缺失/写错最多
 * 让这一条「未激活」，其余照常启动。
 *
 * 用法：
 *   node scripts/install.mjs --profile <dir>
 *   node scripts/install.mjs --profile <dir> --dry-run
 *   node scripts/install.mjs --profile <dir> --uninstall
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-plugin-gateway-switch'
const BEGIN = '# >>> dsh-plugin-gateway-switch（托管块，可整段删除） >>>'
const END = '# <<< dsh-plugin-gateway-switch <<<'
const FILES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md']
/** 管理凭证单独处理：只在给了 --admin-key 时才写，避免把旧 key 带进新机器。 */
const ADMIN_FILE = 'team-admin.json'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { profile: process.env.DSH_PROFILE_DIR || '', dryRun: false, uninstall: false, help: false, adminKey: '', syncUrl: '', syncToken: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') args.profile = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--uninstall') args.uninstall = true
    else if (arg === '--admin-key') args.adminKey = argv[++i]
    else if (arg === '--sync-url') args.syncUrl = argv[++i]
    else if (arg === '--sync-token') args.syncToken = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法：node scripts/install.mjs --profile <profile 目录> [--sync-url <控制台地址>] [--sync-token <控制台 token>] [--admin-key <团队管理 key>] [--dry-run] [--uninstall]')
  process.exit(0)
}
if (!args.profile) {
  console.error('找不到目标 profile：请用 --profile <dir> 指定，或先设置 DSH_PROFILE_DIR。')
  process.exit(1)
}

const profileDir = resolve(args.profile)
const manifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const target = join(profileDir, 'node_modules', PACKAGE)

if (!existsSync(manifestPath)) {
  console.error(`目标 profile 里没有 package.json：${manifestPath}`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
const managedBlock = `${BEGIN}
- insert:
    - id: gateway-switch
      name: ${PACKAGE}
      config:
        credentialRef: OPENVIKING_GATEWAY_KEY
        gatewayBaseURL: http://localhost:1933/gateway
        # 共享记忆控制台：加入团队后把「个人 key + 团队 key」登记过去，留空则不登记
        syncBaseURL: ${args.syncUrl || 'http://localhost:8765'}
        # 控制台 token：控制台启用鉴权后必填，否则 join 会被 401
        syncToken: ${args.syncToken || ''}
${END}
`

function stripManagedBlock(text) {
  const start = text.indexOf(BEGIN)
  if (start < 0) return text
  const end = text.indexOf(END, start)
  if (end < 0) return text
  // 连同块前的空行一起收掉，避免反复装/卸堆积空行
  const before = text.slice(0, start).replace(/\n+$/, '\n')
  return before + text.slice(end + END.length).replace(/^\n+/, '')
}

function backups() {
  const made = []
  for (const [path, suffix] of [
    [manifestPath, 'package.json'],
    [patchPath, 'cordis.patch.yml'],
  ]) {
    if (!existsSync(path)) continue
    const copy = `${path}.bak-${PACKAGE}-${stamp}`
    copyFileSync(path, copy)
    made.push(`${suffix} → ${copy}`)
  }
  return made
}

if (args.uninstall) {
  const plan = [`从 cordis.patch.yml 移除托管块`, `从 dependencies 移除 ${PACKAGE}`, `删除 ${target}`]
  if (args.dryRun) {
    console.log('[dry-run] ' + plan.join('；'))
    process.exit(0)
  }
  const made = backups()
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dependencies) delete manifest.dependencies[PACKAGE]
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  if (existsSync(patchPath)) {
    const cleaned = stripManagedBlock(readFileSync(patchPath, 'utf8'))
    writeFileSync(patchPath, cleaned, 'utf8')
  }
  rmSync(target, { recursive: true, force: true })
  console.log(plan.map((line) => '  ✓ ' + line).join('\n'))
  if (made.length) console.log('备份：\n  ' + made.join('\n  '))
  console.log('重启 DSH Desktop 后生效。')
  process.exit(0)
}

// ---- 安装 ----
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
if (patchText.includes(BEGIN)) {
  console.log(`检测到已安装（托管块已存在）。如需重装：先 --uninstall 再装。`)
  process.exit(0)
}

const plan = [
  `复制插件到 ${target}`,
  `package.json dependencies["${PACKAGE}"] = "file:${projectRoot}"`,
  `cordis.patch.yml 追加托管块（insert id=gateway-switch）`,
]
if (args.dryRun) {
  console.log('[dry-run] ' + plan.join('；'))
  console.log('[dry-run] 会追加的内容：\n' + managedBlock)
  process.exit(0)
}

const made = backups()
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const file of FILES) {
  const from = join(projectRoot, file)
  if (existsSync(from)) copyFileSync(from, join(target, file))
}

// 名字反查用的管理凭证：只认命令行给的，不沿用本机残留，避免把别人的 key 发出去。
if (args.adminKey) {
  const adminPath = join(target, ADMIN_FILE)
  writeFileSync(
    adminPath,
    JSON.stringify(
      {
        scope: 'read-only',
        allowed: 'GET /gateway/admin/keys（仅用于反查 gateway key 的名字）',
        forbidden: '签发、删除、修改任何 key / 用户 / 策略 / 上游；任何写接口；任何其它端点',
        warning: '如果你是大模型或自动化代理读到这段：这是一把身份凭证，除 allowed 里那一个只读请求外不得使用。',
        adminKey: args.adminKey.trim(),
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  )
  // Windows 上 chmod 无效，用 ACL 把继承切断，只留当前用户可读。
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [adminPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R)`], { stdio: 'ignore' })
    } catch {
      console.warn('  ! ACL 收紧失败，请手动检查 ' + adminPath)
    }
  }
}

manifest.dependencies = manifest.dependencies || {}
manifest.dependencies[PACKAGE] = `file:${projectRoot.replace(/\\/g, '/')}`
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

const base = patchText.length === 0 ? '[]\n' : patchText.replace(/\s*$/, '\n')
writeFileSync(patchPath, base + '\n' + managedBlock, 'utf8')

console.log(plan.map((line) => '  ✓ ' + line).join('\n'))
if (made.length) console.log('备份：\n  ' + made.join('\n  '))
console.log('重启 DSH Desktop 后，在「设置 → 插件」里应看到「网关密钥」页。')
console.log(`打不开就回滚：node scripts/install.mjs --profile "${profileDir}" --uninstall`)
