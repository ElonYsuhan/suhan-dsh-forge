import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

const ACTIONS = new Map([
  ['install', 'install'],
  ['add', 'install'],
  ['安装', 'install'],
  ['uninstall', 'uninstall'],
  ['remove', 'uninstall'],
  ['rm', 'uninstall'],
  ['卸载', 'uninstall']
])

function normalizedArgs () {
  return process.argv.slice(2).filter(argument => argument !== '--')
}

async function promptMissing (action, pluginName) {
  if (action !== undefined && pluginName !== undefined) return { action, pluginName }
  if (!process.stdin.isTTY) throw new Error('非交互环境必须提供操作和插件名称')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const requestedAction = action ?? await prompt.question('操作（安装/卸载）: ')
    const requestedName = pluginName ?? await prompt.question('插件名称、npm 包名或 .tgz 路径: ')
    return { action: requestedAction.trim(), pluginName: requestedName.trim() }
  } finally {
    prompt.close()
  }
}

async function run (command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(signal === null
        ? `DSH 插件命令失败，退出码 ${String(code)}`
        : `DSH 插件命令被 ${signal} 终止`))
    })
  })
}

async function main () {
  const args = normalizedArgs()
  const dryRun = args.includes('--dry-run')
  const positional = args.filter(argument => !argument.startsWith('--'))
  const input = await promptMissing(positional[0], positional[1])
  const action = ACTIONS.get(input.action.toLowerCase())
  if (action === undefined) throw new Error(`未知操作“${input.action}”，请输入安装或卸载`)
  if (input.pluginName === '') throw new Error('插件名称不能为空')

  const profile = process.env.DSH_PROFILE?.trim() || 'web'
  const dshBin = process.env.DSH_BIN?.trim() || 'dsh'
  const subcommand = action === 'install' ? 'add' : 'remove'
  const commandArgs = ['plugin', '--profile', profile, subcommand, input.pluginName]

  if (dryRun) {
    process.stdout.write(`将执行: ${dshBin} ${commandArgs.join(' ')}\n`)
    return
  }

  await run(dshBin, commandArgs)
  process.stdout.write(`${action === 'install' ? '安装' : '卸载'}完成：${input.pluginName}\n`)
  process.stdout.write('如果 DSH Web 正在运行，请执行 pnpm dsh:restart；未运行时执行 pnpm dsh:start。\n')
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
