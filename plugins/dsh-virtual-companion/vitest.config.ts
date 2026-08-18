import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: ['lib/**', 'node_modules/**'],
    pool: 'threads',
    server: {
      deps: {
        // babylon-mmd 的 ESM 有省略扩展名的相对导入，node 原生加载会失败
        inline: ['babylon-mmd']
      }
    }
  }
})
