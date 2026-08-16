import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(sourceRoot, 'views/PluginListView.vue'), 'utf8')
const stylesSource = readFileSync(join(sourceRoot, 'styles.css'), 'utf8')
const viteConfigSource = readFileSync(join(sourceRoot, '../vite.config.ts'), 'utf8')

describe('plugin card marketplace adjustments', () => {
  it('makes the whole plugin card clickable without a separate detail button', () => {
    expect(appSource).toContain('role="button"')
    expect(appSource).toContain('tabindex="0"')
    expect(appSource).toContain('@click="openPlugin(plugin, $event)"')
    expect(appSource).toContain('@keydown.enter="openPlugin(plugin, $event)"')
    expect(appSource).toContain('@keydown.space.prevent="openPlugin(plugin, $event)"')
    expect(appSource).not.toMatch(/<button[^>]*>\s*查看详情\s*<\/button>/)
  })

  it('keeps the card layout compact and visibly focusable', () => {
    expect(stylesSource).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));')
    expect(stylesSource).toContain('min-height: 220px;')
    expect(stylesSource).toContain('cursor: pointer;')
    expect(stylesSource).toContain('.plugin-card:focus-visible')
  })

  it('tracks plugin metadata files so catalog data can update in dev', () => {
    expect(viteConfigSource).toContain("this.addWatchFile(packageJsonPath)")
    expect(viteConfigSource).toContain("this.addWatchFile(marketplacePath)")
  })
})
