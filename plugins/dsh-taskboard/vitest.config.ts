import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.spec.js'],
    exclude: ['lib/**', 'node_modules/**'],
    pool: 'threads',
    // 真实 git worktree/rebase 集成测试在多文件并发下会超过默认 5s。
    testTimeout: 30_000
  }
})
