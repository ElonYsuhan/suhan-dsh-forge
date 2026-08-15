import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const pluginRoot = fileURLToPath(new URL('../..', import.meta.url))

async function readJson (relativePath) {
  return JSON.parse(await readFile(join(pluginRoot, relativePath), 'utf8'))
}

function matchesWhitelist (entry, relative) {
  if (entry === relative) return true
  if (!entry.includes('*')) return false
  const pattern = entry
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${pattern}$`).test(relative)
}

describe('public package metadata', () => {
  it('exposes public npm release fields', async () => {
    const pkg = await readJson('package.json')

    expect(pkg.private).toBeUndefined()
    expect(pkg.license).toBe('MIT')
    expect(pkg.repository?.type).toBe('git')
    expect(pkg.repository?.url).toContain('github.com/ElonYsuhan/suhan-dsh-forge')
    expect(pkg.homepage).toContain('github.com/ElonYsuhan/suhan-dsh-forge')
    expect(Array.isArray(pkg.keywords)).toBe(true)
    expect(pkg.keywords.length).toBeGreaterThan(0)
    expect(pkg.publishConfig?.access).toBe('public')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('keeps exports targets inside the publish whitelist and present on disk', async () => {
    const pkg = await readJson('package.json')

    const requiredFiles = [
      'lib/index.js',
      'lib/invariant.js',
      'lib/client.js',
      'lib/client.js.map',
      'lib/types/**/*.d.ts',
      'cordis.patch.yml',
      'dsh-marketplace.json',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
    ]
    for (const file of requiredFiles) {
      expect(pkg.files, `files should include ${file}`).toContain(file)
    }

    const exportTargets = Object.values(pkg.exports).flatMap(value =>
      typeof value === 'string' ? [value] : Object.values(value),
    )
    for (const target of exportTargets) {
      const relative = target.replace(/^\.\//, '')
      if (relative === 'package.json') continue
      expect(
        pkg.files.some(entry => matchesWhitelist(entry, relative)),
        `files should cover export ${target}`,
      ).toBe(true)
      await expect(access(join(pluginRoot, relative))).resolves.toBeUndefined()
    }
  })

  it('declares public marketplace status and all permission arrays', async () => {
    const marketplace = await readJson('dsh-marketplace.json')

    expect(marketplace.status).toBe('public')
    for (const kind of ['network', 'filesystem', 'process', 'secrets']) {
      expect(Array.isArray(marketplace.permissions?.[kind]), `${kind} should be an array`).toBe(true)
    }
  })
})
