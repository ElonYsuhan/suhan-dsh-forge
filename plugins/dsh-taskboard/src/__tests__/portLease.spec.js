/**
 * 任务实时预览端口租约：分配/占用跳过/并发分租/释放/心跳/惰性 sweep/启动恢复/启动失败。
 * lsof 与 spawn 均为 mock；租约文件用真实临时目录验证持久化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PORTS_PER_TASK,
  STALE_LEASE_MS,
  createPortLeaseStore,
  devArgsFor,
  groupStarts
} from '../portLease.ts'

/** 当前「正在监听」的端口（mock lsof 输出） */
const listeningPorts = new Set()
const spawnCalls = []
// 远超 macOS 实际 pid 上限（~99999），保证 mock pid 永不撞真实进程（否则 release 会误杀）
let nextPid = 8_000_000

vi.mock('node:child_process', () => ({
  spawn: (command, args, options) => {
    const child = { pid: ++nextPid, exitCode: null, unref: vi.fn() }
    spawnCalls.push({ command, args, cwd: options?.cwd, env: options?.env, child })
    return child
  },
  execFile: (command, args, _options, callback) => {
    if (command !== 'lsof') {
      callback(new Error(`unexpected command ${command}`))
      return
    }
    // -nP -iTCP -sTCP:LISTEN -F n：每个监听端口一行 n<地址>
    let output = ''
    for (const port of listeningPorts) output += `n127.0.0.1:${port}\n`
    callback(null, output)
  }
}))

/** 构造带 dev script + node_modules 的任务 worktree 目录 */
function makeWorktree (devScript) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lease-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: devScript } }))
  mkdirSync(join(dir, 'node_modules'))
  return dir
}

/** 快速测试用 store：短探测节奏，可控时钟 */
function makeStore (options = {}) {
  let clock = 1_000_000
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lease-store-'))
  const leasesFile = join(dir, 'port-leases.json')
  const store = createPortLeaseStore({
    leasesFile,
    now: () => clock,
    pollIntervalMs: 5,
    startTimeoutMs: 200,
    ...options
  })
  return { store, leasesFile, advance: ms => { clock += ms } }
}

describe('devArgsFor', () => {
  it('vite 与 vitepress 使用 --port + --strictPort（spawn 时前置 dev）', () => {
    expect(devArgsFor('vite dev', 4310)).toEqual(['--port', '4310', '--strictPort'])
    expect(devArgsFor('vitepress dev docs', 4320)).toEqual(['--port', '4320', '--strictPort'])
  })

  it('next 使用 -p', () => {
    expect(devArgsFor('next dev', 4330)).toEqual(['-p', '4330'])
  })

  it('其他 dev script 不支持固定端口', () => {
    expect(devArgsFor('npm run watch', 4340)).toBeNull()
    expect(devArgsFor('node server.js', 4340)).toBeNull()
  })
})

describe('端口租约', () => {
  beforeEach(() => {
    listeningPorts.clear()
    spawnCalls.length = 0
  })

  afterEach(() => {
    // 清理 mock 标记的「监听端口」；真实临时目录由各自用例删除
  })

  it('端口池按组划分：4300-4999，每组 10 个连续端口', () => {
    const starts = groupStarts()
    expect(starts[0]).toBe(4300)
    expect(starts).toHaveLength(70)
    expect(starts[1]).toBe(4310)
    expect(starts.at(-1)).toBe(4990)
    expect(PORTS_PER_TASK).toBe(10)
  })

  it('依赖未安装：pending 且不申请端口、不启动', async () => {
    const { store } = makeStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lease-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: 'vite dev' } }))
    // 无 node_modules

    const result = await store.ensureTaskPreview('task-a', dir)
    expect(result.pending).toBe(true)
    expect(result.reason).toContain('依赖安装中')
    expect(spawnCalls.length).toBe(0)
    expect(store.leases().size).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('无 dev script：返回原因，不占用端口', async () => {
    const { store } = makeStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lease-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }))
    mkdirSync(join(dir, 'node_modules'))

    const result = await store.ensureTaskPreview('task-a', dir)
    expect(result.pending).toBe(false)
    expect(result.reason).toContain('没有 dev script')
    expect(store.leases().size).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('启动 vite dev server：spawn strictPort + CI=true，端口出现后返回地址并持久化', async () => {
    const { store, leasesFile } = makeStore()
    const worktree = makeWorktree('vite dev')

    const promise = store.ensureTaskPreview('task-a', worktree)
    await vi.waitFor(() => {
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0].command).toBe('pnpm')
      expect(spawnCalls[0].args).toEqual(['dev', '--port', '4300', '--strictPort'])
      expect(spawnCalls[0].cwd).toBe(worktree)
      // 无 TTY 下 pnpm 依赖重装不应中止
      expect(spawnCalls[0].env?.CI).toBe('true')
    })

    listeningPorts.add(4300)
    const result = await promise
    expect(result).toEqual({ url: 'http://localhost:4300', pending: false })
    expect(store.leases().get('task-a')?.status).toBe('active')

    // 租约持久化到数据目录
    await vi.waitFor(() => {
      const saved = JSON.parse(readFileSync(leasesFile, 'utf8'))
      expect(saved.leases).toHaveLength(1)
      expect(saved.leases[0].taskId).toBe('task-a')
      expect(saved.leases[0].ports).toEqual(Array.from({ length: 10 }, (_, i) => 4300 + i))
      expect(saved.leases[0].status).toBe('active')
    })

    // 重复请求：复用已有租约，不重复启动
    const again = await store.ensureTaskPreview('task-a', worktree)
    expect(again.url).toBe('http://localhost:4300')
    expect(spawnCalls.length).toBe(1)
    rmSync(worktree, { recursive: true, force: true })
  })

  it('已占用端口组被跳过，申请下一组空闲端口', async () => {
    const { store } = makeStore()
    const worktree = makeWorktree('vite dev')
    listeningPorts.add(4300)
    listeningPorts.add(4310) // 前两组被占

    const promise = store.ensureTaskPreview('task-a', worktree)
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
    expect(spawnCalls[0].args).toEqual(['dev', '--port', '4320', '--strictPort'])
    listeningPorts.add(4320)
    const result = await promise
    expect(result.url).toBe('http://localhost:4320')
    rmSync(worktree, { recursive: true, force: true })
  })

  it('并发任务各自申请不同端口组（租约表唯一约束）', async () => {
    const { store } = makeStore()
    const worktreeA = makeWorktree('vite dev')
    const worktreeB = makeWorktree('vite dev')

    const promiseA = store.ensureTaskPreview('task-a', worktreeA)
    const promiseB = store.ensureTaskPreview('task-b', worktreeB)
    // a 的探测窗口内出现 4300 → a 先 resolve，b 才能开始
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
    expect(spawnCalls[0].args[2]).toBe('4300')
    listeningPorts.add(4300)
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(2))
    expect(spawnCalls[1].args[2]).toBe('4310')
    listeningPorts.add(4310)

    const [a, b] = await Promise.all([promiseA, promiseB])
    expect(a.url).toBe('http://localhost:4300')
    expect(b.url).toBe('http://localhost:4310')
    expect(store.leases().size).toBe(2)
    rmSync(worktreeA, { recursive: true, force: true })
    rmSync(worktreeB, { recursive: true, force: true })
  })

  it('release 终止 dev server 并归还端口组（后续任务可复用同组）', async () => {
    const { store } = makeStore()
    const worktreeA = makeWorktree('vite dev')
    const worktreeB = makeWorktree('vite dev')

    const promiseA = store.ensureTaskPreview('task-a', worktreeA)
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
    listeningPorts.add(4300)
    const result = await promiseA
    expect(result.url).toBe('http://localhost:4300')

    await store.release('task-a')
    expect(store.leases().size).toBe(0)
    // 模拟：dev server 被杀后端口不再监听
    listeningPorts.delete(4300)

    // 归还后 task-b 重新拿到 4300 组
    const promiseB = store.ensureTaskPreview('task-b', worktreeB)
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(2))
    expect(spawnCalls[1].args[2]).toBe('4300')
    listeningPorts.add(4300)
    const b = await promiseB
    expect(b.url).toBe('http://localhost:4300')
    rmSync(worktreeA, { recursive: true, force: true })
    rmSync(worktreeB, { recursive: true, force: true })
  })

  it('心跳续租：touch 后 sweep 不回收，超时后回收', async () => {
    const { store, advance } = makeStore()
    const worktree = makeWorktree('vite dev')
    const promise = store.ensureTaskPreview('task-a', worktree)
    listeningPorts.add(4300)
    await promise

    advance(STALE_LEASE_MS / 2)
    store.touch('task-a') // 心跳续租
    advance(STALE_LEASE_MS / 2 + 1_000) // 总间隔 > STALE_LEASE_MS，但 touch 刷新过
    expect(await store.sweepStale()).toBe(0)
    expect(store.leases().get('task-a')).toBeDefined()

    advance(STALE_LEASE_MS + 1_000) // 之后不再 touch
    expect(await store.sweepStale()).toBe(1)
    expect(store.leases().size).toBe(0)
    rmSync(worktree, { recursive: true, force: true })
  })

  it('recover 恢复持久化租约：端口仍在监听的续租，进程已死的释放', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lease-store-'))
    const leasesFile = join(dir, 'port-leases.json')
    const worktree = makeWorktree('vite dev')
    // 手工构造：alive 租约 pid 指向真实存活进程；dead 租约 pid/端口均不存在
    writeFileSync(leasesFile, JSON.stringify({
      version: 1,
      leases: [
        {
          taskId: 'alive', worktreePath: worktree,
          ports: Array.from({ length: 10 }, (_, i) => 4300 + i),
          pids: [process.pid], status: 'active', url: 'http://localhost:4300',
          startedAt: 1, lastHeartbeat: 1
        },
        {
          taskId: 'dead', worktreePath: worktree,
          ports: Array.from({ length: 10 }, (_, i) => 4990 + i),
          pids: [999999], status: 'active', url: 'http://localhost:4990',
          startedAt: 1, lastHeartbeat: 1
        }
      ]
    }, null, 2))
    listeningPorts.add(4300)

    const store = createPortLeaseStore({ leasesFile, now: () => 2_000_000, pollIntervalMs: 5, startTimeoutMs: 200 })
    await store.recover()

    const revived = store.leases()
    expect(revived.size).toBe(1)
    expect(revived.get('alive')?.taskId).toBe('alive')
    // 续租后心跳从现在重新计时，避免启动即被 sweep
    expect(revived.get('alive')?.lastHeartbeat).toBe(2_000_000)
    await vi.waitFor(() => {
      const saved = JSON.parse(readFileSync(leasesFile, 'utf8'))
      expect(saved.leases).toHaveLength(1)
      expect(saved.leases[0].taskId).toBe('alive')
    })
    rmSync(dir, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  it('启动超时：error 租约记录原因，重试窗口内不重复启动', async () => {
    const { store } = makeStore()
    const worktree = makeWorktree('vite dev')

    // 端口始终不出现（不 add 到 listeningPorts）→ 45s 探测超时（测试缩短为 200ms）
    const result = await store.ensureTaskPreview('task-a', worktree)
    expect(result.url).toBeNull()
    expect(result.reason).toContain('未探测到')
    expect(store.leases().get('task-a')?.status).toBe('error')

    // 错误重试窗口内：直接返回原因，不再 spawn
    const retry = await store.ensureTaskPreview('task-a', worktree)
    expect(retry.reason).toContain('未探测到')
    expect(spawnCalls.length).toBe(1)
    rmSync(worktree, { recursive: true, force: true })
  })

  it('dev server 崩溃（端口消失）：释放后自动重新启动', async () => {
    const { store } = makeStore()
    const worktree = makeWorktree('vite dev')
    // 先等 acquire 完成（spawn 已在 acquire 之后），再让端口出现，否则占用检测会提前看到它
    const promise = store.ensureTaskPreview('task-a', worktree)
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1))
    listeningPorts.add(4300)
    await promise

    // 模拟崩溃：端口不再监听
    listeningPorts.delete(4300)
    const again = store.ensureTaskPreview('task-a', worktree)
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(2))
    listeningPorts.add(4300)
    const result = await again
    expect(result.url).toBe('http://localhost:4300')
    expect(store.leases().get('task-a')?.status).toBe('active')
    rmSync(worktree, { recursive: true, force: true })
  })

  it('dev script 不支持固定端口：返回原因，不占用端口组', async () => {
    const { store } = makeStore()
    const worktree = makeWorktree('node server.js')

    const result = await store.ensureTaskPreview('task-a', worktree)
    expect(result.pending).toBe(false)
    expect(result.reason).toContain('不支持固定端口')
    expect(spawnCalls.length).toBe(0)
    expect(store.leases().size).toBe(0)
    rmSync(worktree, { recursive: true, force: true })
  })
})
