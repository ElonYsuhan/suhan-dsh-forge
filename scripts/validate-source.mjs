import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import process from 'node:process'

const packageRoot = process.cwd()
const roots = process.argv.slice(2).map(path => resolve(packageRoot, path))
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx'])
const forbidden = [
  { pattern: /\beval\s*\(/, message: '禁止使用 eval' },
  { pattern: /\bnew\s+Function\s*\(/, message: '禁止使用 new Function' },
  { pattern: /(?:api[_-]?key|token|secret)\s*[:=]\s*['"][^'"]+['"]/i, message: '疑似硬编码凭证' }
]

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path))
    else if (sourceExtensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

const files = (await Promise.all(roots.map(collect))).flat()
const errors = []
for (const file of files) {
  const source = await readFile(file, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) errors.push(`${relative(packageRoot, file)}: ${rule.message}`)
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`- ${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`源码门禁已检查 ${files.length} 个文件。\n`)
}
