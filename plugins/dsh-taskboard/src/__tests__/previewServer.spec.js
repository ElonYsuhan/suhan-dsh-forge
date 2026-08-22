/**
 * 页面预览基地址解析：复用运行中 dev server / 启动 pnpm dev / 插件仓库回退宿主 / 不可用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPreviewBaseCache, resolvePreviewBase } from '../previewServer.ts'

/** 可控的 lsof / spawn 行为 */
const listeners = new Map() // port -> { pid, cwd }
const spawnCalls = []

vi.mock('node:child_process', () => ({
  spawn: (command, args, options) => {
    spawnCalls.push({ command, args, cwd: options?.cwd, env: options?.env })
    return { unref: vi.fn() }
  },
  execFile: (command, args, _options, callback) => {
    if (command !== 'lsof') {
      callback(new Error(`unexpected command ${command}`))
      return
    }
    const flatArgs = args.join(' ')
    if (flatArgs.includes('-d cwd')) {
      // -a -p <pid> -d cwd -F n
      const pid = flatArgs.match(/-p (\d+)/)?.[1]
      const entry = [...listeners.values()].find(l => String(l.pid) === pid)
      callback(null, entry === undefined ? '' : `n${entry.cwd}\n`)
      return
    }
    // -nP -iTCP -sTCP:LISTEN -F pcn
    let output = ''
    for (const [port, entry] of listeners) {
      output += `p${entry.pid}\ncnode\nn127.0.0.1:${port}\n`
    }
    callback(null, output)
  }
}))

/** 构造临时项目目录 */
function makeProject ({ devScript, withPluginsDir }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-preview-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: devScript === null ? {} : { dev: devScript }
  }))
  if (withPluginsDir) mkdirSync(join(dir, 'plugins'))
  return dir
}

describe('resolvePreviewBase', () => {
  beforeEach(() => {
    listeners.clear()
    spawnCalls.length = 0
    clearPreviewBaseCache()
  })

  it('复用已在运行且工作目录匹配项目的 dev server', async () => {
    const project = makeProject({ devScript: 'vite dev', withPluginsDir: false })
    listeners.set(5173, { pid: 101, cwd: project })

    const result = await resolvePreviewBase(project)
    expect(result.baseUrl).toBe('http://localhost:5173')
    expect(spawnCalls.length).toBe(0)
    rmSync(project, { recursive: true, force: true })
  })

  it('无 dev script 的插件 monorepo 回退到宿主 3080', async () => {
    const project = makeProject({ devScript: null, withPluginsDir: true })
    const result = await resolvePreviewBase(project)
    expect(result.baseUrl).toBe('http://localhost:3080')
    rmSync(project, { recursive: true, force: true })
  })

  it('无 dev script 且非插件仓库：返回不可用原因', async () => {
    const project = makeProject({ devScript: null, withPluginsDir: false })
    const result = await resolvePreviewBase(project)
    expect(result.baseUrl).toBeNull()
    expect(result.error).toContain('没有 dev script')
    rmSync(project, { recursive: true, force: true })
  })

  it('启动 pnpm dev 并轮询探测到新端口后返回基地址', async () => {
    const project = makeProject({ devScript: 'vite dev', withPluginsDir: false })
    const promise = resolvePreviewBase(project)

    // 无运行端口：进入启动分支，pnpm dev 被拉起（真实轮询间隔 ~800ms/轮）
    await vi.waitFor(() => {
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0].command).toBe('pnpm')
      expect(spawnCalls[0].args).toEqual(['dev'])
      expect(spawnCalls[0].cwd).toBe(project)
    })
    // 无 TTY 下 pnpm 依赖重装不应中止（否则 vitepress 等项目永远起不来）
    expect(spawnCalls[0].env?.CI).toBe('true')

    // dev server 出现后下一轮探测到并返回
    listeners.set(5173, { pid: 202, cwd: project })
    const result = await promise
    expect(result.baseUrl).toBe('http://localhost:5173')
    rmSync(project, { recursive: true, force: true })
  })

  it('并发请求合并为一次探测（缓存结果复用）', async () => {
    const project = makeProject({ devScript: 'vite dev', withPluginsDir: false })
    const first = resolvePreviewBase(project)
    const second = resolvePreviewBase(project)
    // 等 pnpm dev 已拉起（启动前端口快照已拍），再让 dev server 出现
    await vi.waitFor(() => {
      expect(spawnCalls).toHaveLength(1)
    })
    listeners.set(5174, { pid: 303, cwd: project })
    const [a, b] = await Promise.all([first, second])
    expect(a.baseUrl).toBe('http://localhost:5174')
    expect(b.baseUrl).toBe('http://localhost:5174')
    expect(spawnCalls.length).toBe(1)
    rmSync(project, { recursive: true, force: true })
  })
})
