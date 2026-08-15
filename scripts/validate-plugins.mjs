import { access, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const pluginsRoot = join(root, 'plugins')
const requiredScripts = ['build', 'lint', 'pack:check', 'test', 'typecheck']
const requiredPublishedFiles = ['README.md', 'cordis.patch.yml', 'dsh-marketplace.json']
const permissionKinds = ['network', 'filesystem', 'process', 'secrets']
const qualityKinds = ['unitTests', 'contractTests', 'browserTests']
const statuses = new Set(['internal', 'preview', 'public', 'deprecated'])

function assert(condition, message, errors) {
  if (!condition) errors.push(message)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function validatePlugin(directory) {
  const errors = []
  const pluginRoot = join(pluginsRoot, directory)
  const packagePath = join(pluginRoot, 'package.json')
  const marketplacePath = join(pluginRoot, 'dsh-marketplace.json')
  const tsconfigPath = join(pluginRoot, 'tsconfig.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'))
  const tsconfig = await exists(tsconfigPath)
    ? JSON.parse(await readFile(tsconfigPath, 'utf8'))
    : {}
  const prefix = `${relative(root, pluginRoot)}:`

  assert(typeof packageJson.name === 'string' && packageJson.name.trim() !== '', `${prefix} 缺少 package name`, errors)
  assert(typeof packageJson.version === 'string' && packageJson.version.trim() !== '', `${prefix} 缺少 package version`, errors)
  assert(typeof packageJson.description === 'string' && packageJson.description.trim() !== '', `${prefix} 缺少 package description`, errors)
  assert(typeof packageJson.license === 'string' && packageJson.license.trim() !== '', `${prefix} 缺少 package license`, errors)
  assert(packageJson.type === 'module', `${prefix} package.json 必须使用 ESM`, errors)
  assert(typeof packageJson.main === 'string', `${prefix} 缺少 main`, errors)
  assert(typeof packageJson.types === 'string', `${prefix} 缺少 types`, errors)
  assert(packageJson.exports?.['.'] !== undefined, `${prefix} 缺少根 exports`, errors)
  assert(packageJson.dsh?.client !== undefined || packageJson.dsh?.bundle !== undefined, `${prefix} 缺少 dsh.client 或 dsh.bundle`, errors)
  assert(packageJson.dsh?.bundle?.patch === './cordis.patch.yml', `${prefix} dsh.bundle.patch 必须指向 ./cordis.patch.yml`, errors)
  assert(packageJson.peerDependencies?.['@deepseek-ai/cordis'] !== undefined, `${prefix} Cordis 必须是 peerDependency`, errors)
  assert(Array.isArray(packageJson.files), `${prefix} 必须使用 files 发布白名单`, errors)
  assert(!packageJson.files?.some(entry => entry === 'datas' || entry.startsWith('datas/')), `${prefix} 运行数据不得进入发布包`, errors)
  for (const file of requiredPublishedFiles) {
    assert(packageJson.files?.includes(file), `${prefix} files 白名单必须包含 ${file}`, errors)
  }
  for (const script of requiredScripts) {
    assert(typeof packageJson.scripts?.[script] === 'string', `${prefix} 缺少 scripts.${script}`, errors)
  }
  assert(tsconfig.compilerOptions?.strict === true, `${prefix} tsconfig.json 必须启用 strict`, errors)

  assert(marketplace.schemaVersion === 1, `${prefix} dsh-marketplace schemaVersion 必须为 1`, errors)
  assert(typeof marketplace.displayName?.['zh-CN'] === 'string' && marketplace.displayName['zh-CN'].trim() !== '', `${prefix} 缺少中文展示名`, errors)
  assert(typeof marketplace.displayName?.['en-US'] === 'string' && marketplace.displayName['en-US'].trim() !== '', `${prefix} 缺少英文展示名`, errors)
  assert(typeof marketplace.summary?.['zh-CN'] === 'string' && marketplace.summary['zh-CN'].trim() !== '', `${prefix} 缺少中文简介`, errors)
  assert(typeof marketplace.summary?.['en-US'] === 'string' && marketplace.summary['en-US'].trim() !== '', `${prefix} 缺少英文简介`, errors)
  assert(Array.isArray(marketplace.categories) && marketplace.categories.length > 0, `${prefix} categories 必须是非空数组`, errors)
  assert(Array.isArray(marketplace.tags) && marketplace.tags.length > 0, `${prefix} tags 必须是非空数组`, errors)
  assert(typeof marketplace.compatibility?.dsh === 'string', `${prefix} 缺少 DSH 兼容范围`, errors)
  assert(typeof marketplace.compatibility?.node === 'string', `${prefix} 缺少 Node.js 兼容范围`, errors)
  assert(Array.isArray(marketplace.compatibility?.profiles) && marketplace.compatibility.profiles.length > 0, `${prefix} 缺少 profile 兼容列表`, errors)
  assert(typeof marketplace.permissions === 'object' && marketplace.permissions !== null, `${prefix} 缺少权限声明`, errors)
  for (const permission of permissionKinds) {
    assert(Array.isArray(marketplace.permissions?.[permission]), `${prefix} permissions.${permission} 必须是数组`, errors)
  }
  for (const quality of qualityKinds) {
    assert(typeof marketplace.quality?.[quality] === 'boolean', `${prefix} quality.${quality} 必须是布尔值`, errors)
  }
  assert(statuses.has(marketplace.status), `${prefix} status 必须是 internal、preview、public 或 deprecated`, errors)
  if (marketplace.status === 'internal') {
    assert(packageJson.private === true, `${prefix} internal 插件必须设置 private: true`, errors)
  }

  for (const file of ['README.md', 'cordis.patch.yml', 'dsh-marketplace.json', 'src', 'tsconfig.json']) {
    assert(await exists(join(pluginRoot, file)), `${prefix} 缺少 ${file}`, errors)
  }
  const hasTests = await exists(join(pluginRoot, 'tests')) || await exists(join(pluginRoot, 'src', '__tests__'))
  assert(hasTests, `${prefix} 缺少 tests/ 或 src/__tests__/`, errors)

  return errors
}

const entries = await readdir(pluginsRoot, { withFileTypes: true })
const pluginDirectories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
if (pluginDirectories.length === 0) throw new Error('plugins/ 下没有插件')

const results = await Promise.all(pluginDirectories.map(validatePlugin))
const errors = results.flat()
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`- ${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`已验证 ${pluginDirectories.length} 个 DSH 插件结构。\n`)
}
