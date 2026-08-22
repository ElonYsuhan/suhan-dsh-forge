/**
 * 页面预览基地址：确保项目 dev server 已启动并返回其基地址（如 http://localhost:5173）。
 *
 * 验收「页面预览」链接指向改动涉及的可见页面（相对路径如 /taskboard/boards），
 * 需要项目自身的 dev server 运行起来才能看到真实渲染效果。本模块按 projectPath：
 *   1. 复用已在运行且工作目录匹配的 dev server（扫描常用 dev 端口）；
 *   2. 否则启动 `pnpm dev`（detached，日志落临时文件），轮询探测新出现的端口；
 *   3. 无 dev script 的 DSH 插件 monorepo（含 plugins/ 目录）回退到宿主 3080；
 *   4. 其余项目返回不可用原因。
 * 仅支持 macOS（依赖 lsof）。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { platform } from 'node:process'

/** 常见前端 dev server 端口（vite/vitepress/next/nuxt/tauri 等）。 */
const DEV_PORTS = [
  ...Array.from({ length: 11 }, (_, index) => 5170 + index),
  ...Array.from({ length: 10 }, (_, index) => 3000 + index),
  ...Array.from({ length: 6 }, (_, index) => 9000 + index),
  4173, 8080, 1420, 4321
]

/** 启动后等待 dev server 上线的上限（vite 秒级，next 可能需要更久）。 */
const START_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 800

/** 工作目录是否属于该项目（自身或子目录）。 */
function matchesProject (cwd: string, projectPath: string): boolean {
  const root = resolve(projectPath)
  return cwd === root || cwd.startsWith(root + '/')
}

interface Listener {
  pid: string
  port: number
  command: string
}

/** 解析 lsof -F 输出为行数组。 */
function parseFields (text: string): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = {}
  for (const line of text.split('\n')) {
    if (line.length >= 2) fields[line.charAt(0)] = line.slice(1)
  }
  return fields
}

function exec (command: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && error !== undefined && (error as { code?: number }).code !== 1) {
        reject(error)
        return
      }
      resolveResult(stdout)
    })
  })
}

/** 当前监听中的 node 进程列表（pid / 端口 / 命令）。 */
async function listNodeListeners (): Promise<Listener[]> {
  if (platform !== 'darwin') return []
  try {
    const output = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    const listeners: Listener[] = []
    const entries = output.split('\n').filter(line => line !== '')
    // lsof -F 输出按进程分块：p<pid> c<command> n<address>
    let current: Partial<Listener> = {}
    for (const line of entries) {
      if (line.startsWith('p')) {
        current = { pid: line.slice(1) }
      } else if (line.startsWith('c')) {
        current.command = line.slice(1)
      } else if (line.startsWith('n')) {
        const address = line.slice(1)
        const portMatch = /:(\d+)$/.exec(address)
        if (portMatch !== null) {
          const port = Number(portMatch[1])
          if (current.pid !== undefined && DEV_PORTS.includes(port)) {
            listeners.push({ pid: current.pid, port, command: current.command ?? '' })
          }
        }
      }
    }
    return listeners
  } catch {
    return []
  }
}

/** 取进程工作目录（lsof cwd）。 */
async function processCwd (pid: string): Promise<string | null> {
  if (platform !== 'darwin') return null
  try {
    const output = await exec('lsof', ['-a', '-p', pid, '-d', 'cwd', '-F', 'n'])
    const path = parseFields(output).n
    return path === undefined ? null : path
  } catch {
    return null
  }
}

/** 复用已运行且工作目录匹配项目的 dev server。 */
async function findRunningBase (projectPath: string): Promise<string | null> {
  const listeners = await listNodeListeners()
  for (const listener of listeners) {
    const cwd = await processCwd(listener.pid)
    if (cwd !== null && matchesProject(cwd, projectPath)) {
      return `http://localhost:${listener.port}`
    }
  }
  return null
}

/** 当前所有 node 监听端口（探测新启动的端口用）。 */
async function currentPorts (): Promise<Set<number>> {
  const listeners = await listNodeListeners()
  return new Set(listeners.map(listener => listener.port))
}

/** 项目 package.json 的 dev script。 */
async function devScriptOf (projectPath: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const dev = pkg.scripts?.dev
    return typeof dev === 'string' && dev.trim() !== '' ? dev : null
  } catch {
    return null
  }
}

/** 启动 `pnpm dev`（detached），轮询等待项目 dev server 出现。 */
async function startDevServer (projectPath: string): Promise<string | null> {
  const before = await currentPorts()
  const logPath = join(tmpdir(), `dsh-taskboard-dev-${basename(projectPath)}.log`)
  const logFd = openSync(logPath, 'a')
  const child = spawn('pnpm', ['dev'], {
    cwd: projectPath,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  })
  child.unref()
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolveTimer => setTimeout(resolveTimer, POLL_INTERVAL_MS))
    const now = await currentPorts()
    for (const port of now) {
      if (!before.has(port)) {
        const listeners = await listNodeListeners()
        const candidate = listeners.find(listener => listener.port === port)
        if (candidate !== undefined) {
          const cwd = await processCwd(candidate.pid)
          if (cwd !== null && matchesProject(cwd, projectPath)) {
            return `http://localhost:${port}`
          }
        }
      }
    }
  }
  return null
}

/** DSH 插件 monorepo（无 dev script）：插件页面跑在宿主 dsh web（3080）。 */
function isPluginMonorepo (projectPath: string): boolean {
  return existsSync(join(projectPath, 'plugins'))
}

/** 探测基地址结果。 */
export interface PreviewBaseResult {
  baseUrl: string | null
  error?: string | undefined
}

const cache = new Map<string, PreviewBaseResult>()
/** 探测中请求（并发合并）；失败不缓存，下次请求重试。 */
const inflight = new Map<string, Promise<PreviewBaseResult>>()

/**
 * 解析项目页面预览基地址（内存缓存；dev server 持续运行期间复用）。
 * 并发请求合并为同一个探测过程。
 */
export function resolvePreviewBase (projectPath: string): Promise<PreviewBaseResult> {
  const cached = cache.get(projectPath)
  if (cached !== undefined && cached.baseUrl !== null) {
    return Promise.resolve(cached)
  }
  const existing = inflight.get(projectPath)
  if (existing !== undefined) return existing
  const pending = (async (): Promise<PreviewBaseResult> => {
    const running = await findRunningBase(projectPath)
    if (running !== null) {
      return { baseUrl: running }
    }
    const dev = await devScriptOf(projectPath)
    if (dev !== null) {
      const started = await startDevServer(projectPath)
      if (started !== null) {
        return { baseUrl: started }
      }
      return { baseUrl: null, error: `已在 ${projectPath} 启动 pnpm dev，但 ${START_TIMEOUT_MS / 1000}s 内未探测到 dev server 端口` }
    }
    if (isPluginMonorepo(projectPath)) {
      return { baseUrl: 'http://localhost:3080', error: undefined }
    }
    return { baseUrl: null, error: '该项目没有 dev script（package.json scripts.dev），无法提供页面预览' }
  })()
  inflight.set(projectPath, pending)
  void pending.then(result => {
    if (result.baseUrl !== null) cache.set(projectPath, result)
    inflight.delete(projectPath)
  })
  return pending
}

/** 仅测试用：清空缓存。 */
export function clearPreviewBaseCache (): void {
  cache.clear()
}
