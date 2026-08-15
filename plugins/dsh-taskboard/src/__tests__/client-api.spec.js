import { afterEach, describe, expect, it, vi } from 'vitest'
import { runItem } from '../client/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('taskboard client API errors', () => {
  it('shows the host precondition message when a task cannot run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: '当前工作区不是 Git 仓库。任务执行需要独立 Git worktree。'
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' }
    })))

    await expect(runItem('workspace', 'item')).rejects.toThrow('当前工作区不是 Git 仓库')
  })
})
