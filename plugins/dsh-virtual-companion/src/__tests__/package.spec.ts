import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const pluginRoot = fileURLToPath(new URL('../..', import.meta.url))

async function readJson (relativePath: string): Promise<any> {
  return JSON.parse(await readFile(join(pluginRoot, relativePath), 'utf8')) as any
}

describe('virtual-companion package metadata', () => {
  it('satisfies DSH plugin baseline scripts and publish whitelist', async () => {
    const pkg = await readJson('package.json')

    for (const script of ['build', 'lint', 'pack:check', 'release', 'test', 'typecheck']) {
      expect(typeof pkg.scripts?.[script], `scripts.${script}`).toBe('string')
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.type).toBe('module')
    expect(pkg.files).toEqual(expect.arrayContaining([
      'lib/index.js',
      'lib/client.js',
      'lib/client.js.map',
      'lib/types/**/*.d.ts',
      'cordis.patch.yml',
      'dsh-marketplace.json',
      'README.md',
      'LICENSE',
      'CHANGELOG.md'
    ]))
  })

  it('declares internal marketplace status with private package and empty low-risk permissions', async () => {
    const pkg = await readJson('package.json')
    const marketplace = await readJson('dsh-marketplace.json')

    expect(pkg.private).toBe(true)
    expect(marketplace.status).toBe('internal')
    expect(marketplace.schemaVersion).toBe(1)
    for (const kind of ['network', 'filesystem', 'process', 'secrets']) {
      expect(Array.isArray(marketplace.permissions?.[kind]), `${kind} should be an array`).toBe(true)
    }
    expect(marketplace.quality.unitTests).toBe(true)
    expect(marketplace.quality.contractTests).toBe(true)
    expect(marketplace.quality.browserTests).toBe(false)
  })

  it('keeps the cordis patch id and package name aligned', async () => {
    const pkg = await readJson('package.json')
    const patch = await readFile(join(pluginRoot, 'cordis.patch.yml'), 'utf8')

    expect(pkg.name).toBe('@suhan-dsh/virtual-companion')
    expect(patch).toContain('id: virtual-companion')
    expect(patch).toContain('name: \'@suhan-dsh/virtual-companion\'')
  })
})
