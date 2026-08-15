import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(root, 'plugins', 'dsh-taskboard')
const dryRun = process.argv.includes('--dry-run')

async function captureResult (command, args, cwd = root) {
  try {
    const result = await execFileAsync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout.trim() : '',
      stderr: typeof error.stderr === 'string' ? error.stderr.trim() : error instanceof Error ? error.message : String(error)
    }
  }
}

async function run (command, args, cwd = root) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}\n`)
  if (dryRun) return
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(signal === null
        ? `${command} 执行失败，退出码 ${String(code)}`
        : `${command} 被 ${signal} 终止`))
    })
  })
}

async function publishedIntegrity (packageSpec) {
  const result = await captureResult('npm', ['view', packageSpec, 'dist.integrity', '--json'])
  if (result.code !== 0) {
    if (/E404|404 Not Found|is not in this registry/i.test(result.stderr)) return undefined
    throw new Error(`无法查询 npm registry：${result.stderr}`)
  }
  if (result.stdout === '') return undefined
  const value = JSON.parse(result.stdout)
  return typeof value === 'string' ? value : undefined
}

async function waitForPublishedIntegrity (packageSpec, expected) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const actual = await publishedIntegrity(packageSpec)
    if (actual === expected) return
    if (actual !== undefined) throw new Error(`npm 上的 ${packageSpec} 完整性与本次 tarball 不一致`)
    await new Promise(resolveWait => setTimeout(resolveWait, 2_000))
  }
  throw new Error(`npm 发布后 20 秒内仍无法查询 ${packageSpec}`)
}

async function ensureReleaseTag (tag) {
  const head = (await captureResult('git', ['rev-parse', 'HEAD'])).stdout
  const existing = await captureResult('git', ['rev-list', '-n', '1', tag])
  if (existing.code === 0) {
    if (existing.stdout !== head) throw new Error(`Git 标签 ${tag} 已指向其他提交`)
    process.stdout.write(`Git 标签已存在：${tag}\n`)
    return
  }
  await run('git', ['tag', '-a', tag, '-m', `Release @suhan-dsh/taskboard ${tag.replace('taskboard-v', '')}`])
}

async function verifyProfileInstall (name, version) {
  const dshHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const profilePackage = JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
  const specifier = profilePackage.dependencies?.[name]
  if (typeof specifier !== 'string' || /^(?:link|file):/.test(specifier)) {
    throw new Error(`web profile 仍是本地依赖：${String(specifier)}`)
  }
  const installedPackage = JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
  if (installedPackage.version !== version) throw new Error(`web profile 实际安装版本为 ${String(installedPackage.version)}，预期 ${version}`)
}

async function waitForHealth () {
  const url = process.env.DSH_TASKBOARD_HEALTH_URL?.trim() || 'http://127.0.0.1:3080/taskboard/boards'
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return url
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
  }
  throw new Error(`DSH 重启后健康检查失败：${url}`)
}

async function main () {
  const packageJson = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
  const name = packageJson.name
  const version = packageJson.version
  if (name !== '@suhan-dsh/taskboard' || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('taskboard package name 或 version 无效')
  }
  const packageSpec = `${name}@${version}`
  const archiveName = `${name.slice(1).replaceAll('/', '-')}-${version}.tgz`
  const archivePath = join(root, 'artifacts', archiveName)
  const tag = `taskboard-v${version}`

  process.stdout.write(`准备发布 ${packageSpec}${dryRun ? '（dry-run）' : ''}\n`)
  if (dryRun) {
    for (const command of [
      '检查 Git 工作区', 'pnpm check', 'pnpm audit --audit-level high', '生成正式 tgz',
      'npm publish --access public', `创建标签 ${tag}`, `安装 ${packageSpec} 到 DSH web profile`, '重启并健康检查 DSH'
    ]) process.stdout.write(`- ${command}\n`)
    return
  }

  const status = await captureResult('git', ['status', '--porcelain'])
  if (status.code !== 0) throw new Error(`无法读取 Git 状态：${status.stderr}`)
  if (status.stdout !== '') throw new Error('Git 工作区不干净；请先提交或 stash 变更后再发版')

  await run('pnpm', ['check'])
  await run('pnpm', ['audit', '--audit-level', 'high'])
  await run('pnpm', ['--filter', name, 'run', 'pack'])

  const archive = await readFile(archivePath)
  const localIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
  const currentIntegrity = await publishedIntegrity(packageSpec)
  if (currentIntegrity === undefined) {
    await run('npm', ['whoami'])
    await run('npm', ['publish', archivePath, '--access', 'public'])
    await waitForPublishedIntegrity(packageSpec, localIntegrity)
  } else if (currentIntegrity !== localIntegrity) {
    throw new Error(`${packageSpec} 已发布，但 registry tarball 与本地 tarball 不一致`)
  } else {
    process.stdout.write(`${packageSpec} 已以相同 tarball 发布，跳过 npm publish。\n`)
  }

  await ensureReleaseTag(tag)
  await run('dsh', ['plugin', '--profile', 'web', 'add', packageSpec])
  await verifyProfileInstall(name, version)
  await run('pnpm', ['dsh:restart'])
  const healthUrl = await waitForHealth()

  process.stdout.write(`\n发布完成：${packageSpec}\n`)
  process.stdout.write(`产物：${archivePath}\nGit 标签：${tag}\nDSH：${healthUrl}\n`)
}

main().catch(error => {
  process.stderr.write(`\n发版失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
