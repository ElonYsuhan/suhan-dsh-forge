/**
 * 任务实时预览端口租约：端口池 4300-4999，每个并行任务租用一组连续 10 个端口
 * （xx0 前端 / xx1 API / xx2 Storybook / 其余备用）。
 *
 * 端口由任务看板统一分配并持久化（port-leases.json），不硬编码在任务或分支里：
 *   - 启动时检测组内端口占用，整组空闲才申请，开发服务器一律 strictPort（vite 不会自动换端口）；
 *   - 任务结束（交付/强制关闭/删除/失败）显式释放：终止进程 + 归还端口组；
 *   - 异常任务靠心跳超时回收：live-preview 请求 touch 心跳，超过 STALE_LEASE_MS 未心跳的租约
 *     在下一次惰性 sweep（或插件启动恢复）中释放。
 * 仅支持 macOS（依赖 lsof）。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { platform } from 'node:process'

export const PORT_POOL_START = 4300
export const PORT_POOL_END = 4999
export const PORTS_PER_TASK = 10
/** 心跳超时：超过该时长没有 live-preview 请求 touch，租约被 sweep 回收。 */
export const STALE_LEASE_MS = 5 * 60_000
/** 启动后等待 dev server 上线的上限（vite 秒级，next 可能需要更久）。 */
export const START_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 800
/** 惰性 sweep 节流窗口。 */
const SWEEP_INTERVAL_MS = 60_000
/** error 租约的重试窗口：错误后至少等待这么久才重新申请启动。 */
const ERROR_RETRY_MS = 60_000

export type LeaseStatus = 'starting' | 'active' | 'error'

export interface PortLease {
  taskId: string
  worktreePath: string
  /** 组内 10 个连续端口（ports[0] 为前端 dev server 端口）。 */
  ports: number[]
  /** 启动的 dev server 进程（pnpm 入口 pid）。 */
  pids: number[]
  status: LeaseStatus
  url?: string
  error?: string
  startedAt: number
  lastHeartbeat: number
}

/** live-preview 探测结果：url 就绪 / pending（依赖安装中、启动中）/ 失败原因。 */
export interface LivePreviewState {
  url: string | null
  pending: boolean
  reason?: string
}

/** 端口池内所有组起点（4300, 4310, … 4990）。 */
export function groupStarts (): number[] {
  const starts: number[] = []
  for (let base = PORT_POOL_START; base + PORTS_PER_TASK - 1 <= PORT_POOL_END; base += PORTS_PER_TASK) {
    starts.push(base)
  }
  return starts
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

/** 当前所有监听端口（任意进程，判断租约组是否可申请）。 */
export async function listListeningPorts (): Promise<Set<number>> {
  if (platform !== 'darwin') return new Set()
  try {
    const output = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'n'])
    const ports = new Set<number>()
    for (const line of output.split('\n')) {
      if (!line.startsWith('n')) continue
      const match = /:(\d+)$/.exec(line.slice(1))
      if (match !== null) ports.add(Number(match[1]))
    }
    return ports
  } catch {
    return new Set()
  }
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolveTimer => setTimeout(resolveTimer, ms))
}

function isAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 终止 dev server 进程：detached 进程组先 SIGTERM，宽限后 SIGKILL 兜底。 */
async function terminate (pid: number): Promise<void> {
  let killed = false
  try {
    process.kill(-pid, 'SIGTERM')
    killed = true
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
      killed = true
    } catch {
      return
    }
  }
  if (killed) await sleep(1500)
  try {
    process.kill(-pid, 0)
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 判断 dev script 是否支持固定端口并给出追加参数（spawn 时前置 `dev`）：
 * vite/vitepress → --port <p> --strictPort；next → -p <p>。
 */
export function devArgsFor (script: string, port: number): string[] | null {
  if (/(?:^|[\s|&;])vitepress\b/.test(script) || /\bvite\b/.test(script)) {
    return ['--port', String(port), '--strictPort']
  }
  if (/\bnext\b/.test(script)) {
    return ['-p', String(port)]
  }
  return null
}

interface StoredLease {
  taskId?: unknown
  worktreePath?: unknown
  ports?: unknown
  pids?: unknown
  status?: unknown
  url?: unknown
  error?: unknown
  startedAt?: unknown
  lastHeartbeat?: unknown
}

function isValidStoredLease (value: unknown): value is StoredLease {
  if (typeof value !== 'object' || value === null) return false
  const lease = value as StoredLease
  return typeof lease.taskId === 'string' && typeof lease.worktreePath === 'string' &&
    Array.isArray(lease.ports) && lease.ports.length === PORTS_PER_TASK && lease.ports.every(p => typeof p === 'number') &&
    Array.isArray(lease.pids) && lease.pids.every(p => typeof p === 'number') &&
    (lease.status === 'starting' || lease.status === 'active' || lease.status === 'error') &&
    (lease.url === undefined || typeof lease.url === 'string') &&
    (lease.error === undefined || typeof lease.error === 'string') &&
    typeof lease.startedAt === 'number' && typeof lease.lastHeartbeat === 'number'
}

export interface PortLeaseStore {
  /** 当前租约快照（调试/测试）。 */
  leases(): Map<string, PortLease>
  /** 确保任务 dev server 运行，返回可访问的预览地址或等待/失败原因。 */
  ensureTaskPreview(taskId: string, worktreePath: string): Promise<LivePreviewState>
  /** live-preview 心跳：延长租约寿命。 */
  touch(taskId: string): void
  /** 释放租约：终止 dev server 进程并归还端口组。 */
  release(taskId: string): Promise<void>
  /** 惰性回收心跳超时租约，返回释放数量。 */
  sweepStale(): Promise<number>
  /** 插件启动时恢复持久化租约：进程仍在则续租，否则清理残留。 */
  recover(): Promise<void>
}

export interface PortLeaseStoreOptions {
  leasesFile: string
  /** 测试注入时钟。 */
  now?: () => number
  /** 测试缩短探测节奏。 */
  pollIntervalMs?: number
  /** 测试缩短启动超时。 */
  startTimeoutMs?: number
}

export function createPortLeaseStore (options: PortLeaseStoreOptions): PortLeaseStore {
  const { leasesFile } = options
  const now = options.now ?? Date.now
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const startTimeout = options.startTimeoutMs ?? START_TIMEOUT_MS
  let leases = new Map<string, PortLease>()
  let lastSweepAt = 0
  /** 申请 + 启动串行化：并发请求/并发任务不会同时扫描到同一空闲组。 */
  let acquireQueue = Promise.resolve()

  function persist (): void {
    void (async () => {
      try {
        await mkdir(dirname(leasesFile), { recursive: true })
        await writeFile(leasesFile, JSON.stringify({ version: 1, leases: [...leases.values()] }, null, 2))
      } catch {
        /* 持久化失败不阻塞：下次变更重试 */
      }
    })()
  }

  async function killLeasePids (lease: PortLease): Promise<void> {
    for (const pid of lease.pids) {
      if (isAlive(pid)) await terminate(pid)
    }
  }

  async function acquire (taskId: string, worktreePath: string): Promise<PortLease | LivePreviewState> {
    const taken = new Set([...leases.values()].flatMap(lease => lease.ports))
    const occupied = await listListeningPorts()
    for (const start of groupStarts()) {
      const ports = Array.from({ length: PORTS_PER_TASK }, (_, index) => start + index)
      if (ports.some(port => taken.has(port) || occupied.has(port))) continue
      const lease: PortLease = {
        taskId,
        worktreePath,
        ports,
        pids: [],
        status: 'starting',
        startedAt: now(),
        lastHeartbeat: now()
      }
      leases.set(taskId, lease)
      persist()
      return lease
    }
    return { url: null, pending: true, reason: `预览端口池已用尽（${PORT_POOL_START}–${PORT_POOL_END}），请先释放进行中的任务` }
  }

  /** 无租约时的启动流程：依赖检查 → 申请端口组 → spawn dev server → 探测端口。 */
  async function startFor (taskId: string, worktreePath: string): Promise<LivePreviewState> {
    if (!existsSync(join(worktreePath, 'package.json'))) {
      return { url: null, pending: true, reason: '任务工作区尚未创建（依赖安装中…）' }
    }
    let pkg: { scripts?: Record<string, string> } | null = null
    try {
      pkg = JSON.parse(await readFile(join(worktreePath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    } catch {
      return { url: null, pending: false, reason: '任务工作区 package.json 不可读，无法启动预览' }
    }
    const script = typeof pkg?.scripts?.dev === 'string' && pkg.scripts.dev.trim() !== '' ? pkg.scripts.dev : null
    if (script === null) {
      return { url: null, pending: false, reason: '任务项目没有 dev script（package.json scripts.dev），无法启动预览' }
    }
    // 支持性检查在申请端口前完成：不支持的 dev script 不占端口组、不产生租约
    if (devArgsFor(script, PORT_POOL_START) === null) {
      return { url: null, pending: false, reason: `dev script「${script}」不支持固定端口（仅 vite / vitepress / next）` }
    }
    if (!existsSync(join(worktreePath, 'node_modules'))) {
      // 执行 Agent 在任务开始时才 pnpm install：依赖就绪前不占端口
      return { url: null, pending: true, reason: '任务依赖安装中，安装完成后自动启动预览' }
    }
    const acquired = await acquire(taskId, worktreePath)
    if (!('status' in acquired)) return acquired
    const lease = acquired
    const port = lease.ports[0] as number
    const args = devArgsFor(script, port)
    if (args === null) { // 理论不可达：上方支持性检查已通过
      lease.status = 'error'
      lease.error = `dev script「${script}」不支持固定端口（仅 vite / vitepress / next）`
      lease.lastHeartbeat = now()
      persist()
      return { url: null, pending: false, reason: lease.error }
    }
    const logPath = join(tmpdir(), `dsh-taskboard-live-${taskId}.log`)
    const logFd = openSync(logPath, 'a')
    const child = spawn('pnpm', ['dev', ...args], {
      cwd: worktreePath,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        // pnpm 11：依赖变化需重装时默认交互确认删除 modules 目录，无 TTY 下直接中止；
        // 该确认只认 CI 环境变量（npm_config_ 形式无效），CI=true 下 pnpm 自动跳过并继续
        CI: 'true'
      }
    })
    child.unref()
    lease.pids.push(child.pid as number)
    // 探测用真实墙钟（注入时钟只用于心跳/租约寿命，避免测试时钟不推进导致死循环）
    const deadline = Date.now() + startTimeout
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        lease.status = 'error'
        lease.error = `dev server 已退出（exit ${child.exitCode}），日志：${logPath}`
        lease.lastHeartbeat = now()
        persist()
        return { url: null, pending: false, reason: lease.error }
      }
      await sleep(pollInterval)
      const ports = await listListeningPorts()
      if (ports.has(port)) {
        lease.status = 'active'
        lease.url = `http://localhost:${port}`
        lease.lastHeartbeat = now()
        persist()
        return { url: lease.url, pending: false }
      }
    }
    lease.status = 'error'
    lease.error = `${startTimeout / 1000}s 内未探测到 ${port} 端口监听，日志：${logPath}`
    lease.lastHeartbeat = now()
    persist()
    return { url: null, pending: false, reason: lease.error }
  }

  async function release (taskId: string): Promise<void> {
    const lease = leases.get(taskId)
    if (lease === undefined) return
    leases.delete(taskId)
    persist()
    await killLeasePids(lease)
  }

  async function sweepStale (): Promise<number> {
    const stale: string[] = []
    for (const [taskId, lease] of leases) {
      if (now() - lease.lastHeartbeat > STALE_LEASE_MS) stale.push(taskId)
    }
    for (const taskId of stale) await release(taskId)
    return stale.length
  }

  async function recover (): Promise<void> {
    let stored: unknown = null
    try {
      stored = JSON.parse(await readFile(leasesFile, 'utf8')) as unknown
    } catch {
      return
    }
    const list = (stored as { leases?: unknown }).leases
    if (!Array.isArray(list)) return
    const ports = await listListeningPorts()
    const revived = new Map<string, PortLease>()
    for (const entry of list) {
      if (!isValidStoredLease(entry)) continue
      const lease: PortLease = {
        taskId: entry.taskId as string,
        worktreePath: entry.worktreePath as string,
        ports: entry.ports as number[],
        pids: entry.pids as number[],
        status: entry.status as LeaseStatus,
        startedAt: entry.startedAt as number,
        lastHeartbeat: entry.lastHeartbeat as number
      }
      if (entry.url !== undefined) lease.url = entry.url as string
      if (entry.error !== undefined) lease.error = entry.error as string
      const alive = lease.pids.some(pid => isAlive(pid)) || lease.ports.some(port => ports.has(port))
      if (!alive) {
        // 插件重启后进程已不在：释放端口组（残留进程由 killLeasePids 兜底）
        void killLeasePids(lease)
        continue
      }
      // 进程仍在：续租（心跳从现在起重新计时），端口组继续归本任务
      lease.lastHeartbeat = now()
      revived.set(lease.taskId, lease)
    }
    if (revived.size !== leases.size) {
      leases = revived
      persist()
    }
  }

  return {
    leases: () => new Map(leases),
    async ensureTaskPreview (taskId: string, worktreePath: string): Promise<LivePreviewState> {
      // 惰性 sweep：不设定时器，每次探测顺带节流检查一次
      if (now() - lastSweepAt > SWEEP_INTERVAL_MS) {
        lastSweepAt = now()
        void sweepStale()
      }
      const existing = leases.get(taskId)
      if (existing !== undefined) {
        if (existing.status === 'active' && existing.url !== undefined) {
          const ports = await listListeningPorts()
          if (ports.has(existing.ports[0] as number)) {
            existing.lastHeartbeat = now()
            return { url: existing.url, pending: false }
          }
          // dev server 已崩溃：释放后重新启动
          await release(taskId)
        } else if (existing.status === 'starting') {
          existing.lastHeartbeat = now()
          return { url: null, pending: true, reason: '预览服务启动中…' }
        } else if (now() - existing.lastHeartbeat < ERROR_RETRY_MS) {
          return existing.error === undefined
            ? { url: null, pending: false }
            : { url: null, pending: false, reason: existing.error }
        } else {
          // 错误超过重试窗口：释放后重试
          await release(taskId)
        }
      }
      const run = acquireQueue.then(() => startFor(taskId, worktreePath))
      acquireQueue = run.then(() => undefined, () => undefined)
      return run
    },
    touch (taskId: string): void {
      const lease = leases.get(taskId)
      if (lease !== undefined) {
        lease.lastHeartbeat = now()
        persist()
      }
    },
    release,
    sweepStale,
    recover
  }
}
