import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(sourceRoot, 'App.vue'), 'utf8')
const pluginSource = readFileSync(join(sourceRoot, 'views/PluginListView.vue'), 'utf8')
const qualitySource = readFileSync(join(sourceRoot, 'views/QualityGateView.vue'), 'utf8')
const stylesSource = readFileSync(join(sourceRoot, 'styles.css'), 'utf8')
const viteConfigSource = readFileSync(join(sourceRoot, '../vite.config.ts'), 'utf8')

describe('plugin card marketplace adjustments', () => {
  it('makes the whole plugin card clickable without a separate detail button', () => {
    expect(pluginSource).toContain('role="button"')
    expect(pluginSource).toContain('tabindex="0"')
    expect(pluginSource).toContain('@click="openPlugin(plugin, $event)"')
    expect(pluginSource).toContain('@keydown.enter="openPlugin(plugin, $event)"')
    expect(pluginSource).toContain('@keydown.space.prevent="openPlugin(plugin, $event)"')
    expect(pluginSource).not.toMatch(/<button[^>]*>\s*\u67e5\u770b\u8be6\u60c5\s*<\/button>/)
  })

  it('keeps the card layout compact and visibly focusable', () => {
    expect(stylesSource).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));')
    expect(stylesSource).toContain('min-height: 196px;')
    expect(stylesSource).toContain('cursor: pointer;')
    expect(stylesSource).toContain('.plugin-card:focus-visible')
  })

  it('avoids redundant navigation and header actions', () => {
    expect(appSource).not.toContain('<nav aria-label="\u4e3b\u5bfc\u822a">')
    expect(pluginSource).not.toContain('primary-link')
    expect(qualitySource).not.toContain('primary-link')
    expect(appSource).toContain('class="module-tabs"')
  })

  it('tracks plugin metadata files so catalog data can update in dev', () => {
    expect(viteConfigSource).toContain("this.addWatchFile(packageJsonPath)")
    expect(viteConfigSource).toContain("this.addWatchFile(marketplacePath)")
  })

  it('automatically discovers per-plugin artifacts and shows them in the management page', () => {
    expect(viteConfigSource).toContain("const artifactsRoot = resolve(import.meta.dirname, '../../artifacts')")
    expect(viteConfigSource).toContain('readdir(join(artifactsRoot, pluginId)')
    expect(pluginSource).toContain('本地产物')
    expect(pluginSource).toContain('artifactCount(plugin)')
  })
})
