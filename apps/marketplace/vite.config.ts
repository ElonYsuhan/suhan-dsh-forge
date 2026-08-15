import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

const virtualModuleId = 'virtual:dsh-plugins'
const resolvedVirtualModuleId = `\0${virtualModuleId}`

function dshPluginCatalog(): Plugin {
  const pluginsRoot = resolve(import.meta.dirname, '../../plugins')

  return {
    name: 'suhan-dsh-plugin-catalog',
    resolveId(id) {
      return id === virtualModuleId ? resolvedVirtualModuleId : undefined
    },
    async load(id) {
      if (id !== resolvedVirtualModuleId) return undefined

      const directories = (await readdir(pluginsRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()

      const plugins = await Promise.all(directories.map(async directory => {
        const pluginRoot = join(pluginsRoot, directory)
        const [packageJson, marketplace] = await Promise.all([
          readFile(join(pluginRoot, 'package.json'), 'utf8').then(JSON.parse),
          readFile(join(pluginRoot, 'dsh-marketplace.json'), 'utf8').then(JSON.parse),
        ])

        return {
          id: directory,
          packageName: packageJson.name,
          version: packageJson.version,
          description: packageJson.description,
          ...marketplace,
        }
      }))

      return `export default ${JSON.stringify(plugins)}`
    },
  }
}

export default defineConfig({
  plugins: [dshPluginCatalog(), vue()],
  build: {
    target: 'es2022',
  },
})
