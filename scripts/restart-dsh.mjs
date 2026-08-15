import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { access, readlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const STOP_TIMEOUT_MS = 10_000
const START_CHECK_MS = 800

async function exists (path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function launchdService () {
  if (process.platform !== 'darwin' || process.getuid === undefined) return undefined
  const label = process.env.DSH_LAUNCHD_LABEL ?? 'com.ysuhan.dsh-web'
  const domain = `gui/${process.getuid()}`
  const service = `${domain}/${label}`
  const plist = process.env.DSH_LAUNCHD_PLIST ?? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  let loaded = false
  try {
    await execFileAsync('launchctl', ['print', service], { encoding: 'utf8' })
    loaded = true
  } catch {}
  return loaded || await exists(plist) ? { label, domain, service, plist, loaded } : undefined
}

async function manageLaunchd (action, descriptor, dryRun) {
  if (dryRun) {
    const description = action === 'start'
      ? descriptor.loaded ? 'launchd 服务已运行，不会重复启动' : '将加载并启动 launchd 服务'
      : action === 'stop'
        ? descriptor.loaded ? '将卸载并停止 launchd 服务' : 'launchd 服务未运行，无需停止'
        : descriptor.loaded ? '将通过 launchd 重启服务' : '将加载并启动 launchd 服务'
    process.stdout.write(`${description}：${descriptor.label}\nplist: ${descriptor.plist}\n`)
    return
  }
  if (action === 'stop') {
    if (!descriptor.loaded) {
      process.stdout.write(`DSH Web launchd 服务 ${descriptor.label} 当前未运行。\n`)
      return
    }
    await execFileAsync('launchctl', ['bootout', descriptor.service], { encoding: 'utf8' })
    process.stdout.write(`DSH Web launchd 服务 ${descriptor.label} 已停止并卸载。\n`)
    return
  }
  if (action === 'start' && descriptor.loaded) {
    process.stdout.write(`DSH Web launchd 服务 ${descriptor.label} 已在运行。\n`)
    return
  }
  if (descriptor.loaded) {
    await execFileAsync('launchctl', ['kickstart', '-k', descriptor.service], { encoding: 'utf8' })
    process.stdout.write(`DSH Web launchd 服务 ${descriptor.label} 已重启。\n`)
    return
  }
  await execFileAsync('launchctl', ['bootstrap', descriptor.domain, descriptor.plist], { encoding: 'utf8' })
  process.stdout.write(`DSH Web launchd 服务 ${descriptor.label} 已加载并启动。\n`)
}

function dshWebCommand (line) {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
  if (match === null) return undefined
  const pid = Number.parseInt(match[1], 10)
  const ppid = Number.parseInt(match[2], 10)
  const command = match[3]
  const tokens = command.trim().split(/\s+/)
  const dshIndex = tokens.findIndex((token, index) => basename(token) === 'dsh' && tokens[index + 1] === 'web')
  if (dshIndex < 0 || pid === process.pid) return undefined
  return { pid, ppid, command, bin: tokens[dshIndex] }
}

async function sampleServers () {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return stdout.split('\n').map(dshWebCommand).filter(server => server !== undefined)
}

async function runningServers () {
  const first = await sampleServers()
  if (first.length <= 1) return first
  await new Promise(resolve => setTimeout(resolve, 250))
  const stable = await sampleServers()
  const topLevel = stable.filter(server => !stable.some(candidate => candidate.pid === server.ppid))
  const adopted = topLevel.filter(server => server.ppid === 1)
  return adopted.length === 1 ? adopted : topLevel
}

async function processCwd (pid) {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`)
    } catch {}
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      return stdout.split('\n').find(line => line.startsWith('n'))?.slice(1)
    } catch {}
  }
  return undefined
}

function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit (pid) {
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (alive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!alive(pid)) return
  process.stderr.write(`DSH Web PID ${pid} 在 ${STOP_TIMEOUT_MS / 1000} 秒内未退出，发送 SIGKILL。\n`)
  process.kill(pid, 'SIGKILL')
}

function chooseServer (servers) {
  const requested = process.env.DSH_WEB_PID
  if (requested !== undefined) {
    const pid = Number.parseInt(requested, 10)
    const selected = servers.find(server => server.pid === pid)
    if (selected === undefined) throw new Error(`DSH_WEB_PID=${requested} 不是当前 dsh web 进程`)
    return selected
  }
  if (servers.length > 1) {
    const choices = servers.map(server => `${server.pid}: ${server.command}`).join('\n')
    throw new Error(`检测到多个 dsh web 进程；请设置 DSH_WEB_PID 后重试：\n${choices}`)
  }
  return servers[0]
}

async function stopServer (current) {
  if (current === undefined) {
    process.stdout.write('DSH Web 当前未运行。\n')
    return
  }
  process.stdout.write(`正在停止 DSH Web PID ${current.pid}…\n`)
  process.kill(current.pid, 'SIGTERM')
  await waitForExit(current.pid)
  process.stdout.write(`DSH Web PID ${current.pid} 已停止。\n`)
}

async function startServer (dshBin, cwd, logPath) {
  const logFd = openSync(logPath, 'a')
  let child
  try {
    child = spawn(dshBin, ['web'], {
      cwd,
      detached: true,
      env: process.env,
      stdio: ['ignore', logFd, logFd]
    })
    child.unref()
  } finally {
    closeSync(logFd)
  }

  await new Promise(resolve => setTimeout(resolve, START_CHECK_MS))
  if (child.pid === undefined || !alive(child.pid)) {
    throw new Error(`DSH Web 启动失败，请查看日志：${logPath}`)
  }
  process.stdout.write(`DSH Web 已启动，PID ${child.pid}。日志：${logPath}\n`)
}

async function main () {
  const requestedAction = process.argv[2] ?? 'restart'
  if (!['start', 'stop', 'restart'].includes(requestedAction)) {
    throw new Error(`未知操作 ${requestedAction}；可用操作：start、stop、restart`)
  }
  const launchd = await launchdService()
  if (launchd !== undefined) {
    await manageLaunchd(requestedAction, launchd, process.argv.includes('--dry-run'))
    return
  }
  const servers = await runningServers()
  const current = chooseServer(servers)
  const dshBin = process.env.DSH_BIN ?? current?.bin ?? 'dsh'
  const cwd = process.env.DSH_WEB_CWD ?? (current === undefined ? undefined : await processCwd(current.pid)) ?? process.cwd()
  const logPath = process.env.DSH_WEB_LOG ?? join(tmpdir(), 'dsh-web.log')

  if (process.argv.includes('--dry-run')) {
    const description = requestedAction === 'start'
      ? current === undefined ? '将启动 DSH Web' : `DSH Web 已运行（PID ${current.pid}），不会重复启动`
      : requestedAction === 'stop'
        ? current === undefined ? 'DSH Web 未运行，无需停止' : `将停止 PID ${current.pid}`
        : current === undefined ? '未发现运行中的 DSH Web，将直接启动' : `将重启 PID ${current.pid}`
    process.stdout.write(`${description}\n`)
    process.stdout.write(`命令: ${dshBin} web\n工作目录: ${cwd}\n日志: ${logPath}\n`)
    return
  }

  if (requestedAction === 'stop') {
    await stopServer(current)
    return
  }
  if (requestedAction === 'start' && current !== undefined) {
    process.stdout.write(`DSH Web 已在运行，PID ${current.pid}。\n`)
    return
  }
  if (requestedAction === 'restart') await stopServer(current)
  await startServer(dshBin, cwd, logPath)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
