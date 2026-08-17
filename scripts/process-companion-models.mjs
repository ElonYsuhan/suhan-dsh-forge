/**
 * 处理 MMD 人物模型并放入虚拟伙伴本地模型目录。
 *
 * 用法：node scripts/process-companion-models.mjs [模型相对路径...]
 * 输出：$DSH_HOME/storages/dsh-virtual-companion/models/<id>/model.pmx + 原始相对路径纹理
 *
 * 规则：
 * - 复制源目录内全部图片纹理（保持 PMX 引用的相对路径与文件名/扩展名），
 *   仅将 >1024px 的 PNG/JPG/BMP 降尺寸；TGA 等保持原样
 * - 模型版权禁止二次配布，产物只落本地数据目录，不进 git/npm
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import process from 'node:process'

const execFileAsync = promisify(execFile)

const MODELS = [
  { id: 'ganyu', source: 'ganyu_by_原神_7381ccd84ee8763ce63b3ad638e1c49b/甘雨.pmx', label: '甘雨' },
  { id: 'changye', source: '长夜焕生/长夜焕生.pmx', label: '王昭君·长夜焕生' },
  { id: 'alice', source: '爱丽丝照修复/爱丽丝照3.pmx', label: '爱丽丝' },
  { id: 'qianxiao', source: '千咲黑色16+_by_玄明子_9b88d86533cd01f3874d2837b407cce2/千咲黑色16+.pmx', label: '千咲' },
  { id: 'jialuo', source: '伽罗-最初的交响/伽罗-最初的交响/伽罗-最初的交响.pmx', label: '伽罗·最初的交响' }
]

const DEFAULT_SRC = resolve(process.env.HOME ?? '', 'Documents', '模型', '人物模型')
const MAX_TEXTURE_EDGE = 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.dds', '.webp'])

function modelRoot () {
  const override = process.env.DSH_VIRTUAL_COMPANION_MODELS?.trim()
  if (override !== undefined && override !== '') return resolve(override)
  return resolve(process.env.DSH_HOME ?? resolve(process.env.HOME ?? '', '.dsh'), 'storages', 'dsh-virtual-companion', 'models')
}

async function walkFiles (dir) {
  const files = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  return files
}

async function downscale (source, target, extension) {
  const lower = extension.toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.bmp'].includes(lower)) {
    try {
      await execFileAsync('sips', ['-Z', String(MAX_TEXTURE_EDGE), source, '--out', target], { encoding: 'utf8' })
      return
    } catch {
      // sips 失败时退回原样复制
    }
  }
  await copyFile(source, target)
}

async function main () {
  const sourceRoot = process.env.MODEL_SRC?.trim() || DEFAULT_SRC
  const root = modelRoot()
  const targets = MODELS.filter(model => process.argv.slice(2).length === 0 || process.argv.slice(2).includes(model.id))

  for (const model of targets) {
    const pmxSource = resolve(sourceRoot, model.source)
    try {
      await stat(pmxSource)
    } catch {
      process.stderr.write(`跳过 ${model.id}：找不到 ${pmxSource}\n`)
      continue
    }
    const modelSrcDir = dirname(pmxSource)
    const targetDir = join(root, model.id)
    await mkdir(targetDir, { recursive: true })

    const files = await walkFiles(modelSrcDir)
    let textureCount = 0
    for (const file of files) {
      const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension)) continue
      const rel = relative(modelSrcDir, file)
      const target = join(targetDir, rel)
      await mkdir(dirname(target), { recursive: true })
      await downscale(file, target, extension)
      textureCount += 1
    }

    await copyFile(pmxSource, join(targetDir, 'model.pmx'))
    process.stderr.write(`已处理 ${model.id}（${model.label}）：${textureCount} 张纹理 -> ${targetDir}\n`)
  }
  process.stderr.write(`完成。模型根目录：${root}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
