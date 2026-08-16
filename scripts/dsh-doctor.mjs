import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const FIX = process.argv.includes('--fix')

/** 进程快照：pid、ppid、RSS(KB)、命令行。 */
async function processList () {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
  return stdout.split('\n').filter(Boolean).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match === null ? undefined : { pid: Number.parseInt(match[1], 10), ppid: Number.parseInt(match[2], 10), rssKB: Number.parseInt(match[3], 10), command: match[4] }
  }).filter(entry => entry !== undefined)
}

function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminate (pid) {
  if (!alive(pid)) return
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 2_000
  while (alive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!alive(pid)) return
  process.kill(pid, 'SIGKILL')
}

function mb (kb) {
  return `${(kb / 1024).toFixed(0)}MB`
}

async function memorySnapshot () {
  const { stdout } = await execFileAsync('vm_stat', { encoding: 'utf8' })
  const pageSize = Number.parseInt(stdout.match(/page size of (\d+)/)[1], 10)
  const pages = name => {
    const match = stdout.match(new RegExp(`Pages ${name}:\\s+(\\d+)`))
    return match === null ? 0 : Number.parseInt(match[1], 10) * pageSize
  }
  const { stdout: swapOut } = await execFileAsync('sysctl', ['vm.swapusage'], { encoding: 'utf8' })
  const swapUsedMatch = swapOut.match(/used = (\d+\.\d+)M/)
  const swapTotalMatch = swapOut.match(/total = (\d+\.\d+)M/)
  const swapUsed = swapUsedMatch === null ? undefined : Number.parseFloat(swapUsedMatch[1]) / 1024
  const swapTotal = swapTotalMatch === null ? undefined : Number.parseFloat(swapTotalMatch[1]) / 1024
  return {
    freeGB: pages('free') / 1024 ** 3,
    reclaimableGB: (pages('inactive') + pages('speculative')) / 1024 ** 3,
    swapUsedGB: swapUsed,
    swapTotalGB: swapTotal
  }
}

async function main () {
  const entries = await processList()

  const isVitest = entry => /(?:^|\s)vitest(?:\s|$)/.test(entry.command) || /\(vitest\s+\d+\)/.test(entry.command)
  const isDshHost = entry => /\bdsh\s+web\b/.test(entry.command)

  const vitestOrphans = entries.filter(entry => isVitest(entry) && entry.ppid === 1 && !isDshHost(entry))
  const nodeOrphans = entries.filter(entry =>
    entry.ppid === 1 &&
    !isDshHost(entry) &&
    /\bnode\b/.test(entry.command) &&
    !isVitest(entry) &&
    entry.pid !== process.pid)

  for (const orphan of vitestOrphans) {
    process.stdout.write(`${FIX ? '已终止' : '待清理'} vitest 孤儿 PID ${orphan.pid}（${mb(orphan.rssKB)}）：${orphan.command.slice(0, 80)}\n`)
    if (FIX) await terminate(orphan.pid)
  }
  if (vitestOrphans.length === 0) process.stdout.write('✓ 无 vitest 孤儿进程。\n')

  if (nodeOrphans.length > 0) {
    process.stdout.write('\n其他脱离终端的 node 进程（可能是手动后台任务，未自动处理）：\n')
    for (const entry of nodeOrphans) {
      process.stdout.write(`  PID ${entry.pid}（${mb(entry.rssKB)}）：${entry.command.slice(0, 80)}\n`)
    }
    process.stdout.write('  确认无用后可手动 kill 上述 PID。\n')
  }

  const hosts = entries.filter(isDshHost)
  if (hosts.length > 0) {
    process.stdout.write('\nDSH 宿主（常驻服务，不处理）：\n')
    for (const host of hosts) process.stdout.write(`  PID ${host.pid}（${mb(host.rssKB)}）\n`)
  }

  const memory = await memorySnapshot()
  process.stdout.write('\n内存快照：\n')
  process.stdout.write(`  空闲 ${memory.freeGB.toFixed(1)}GB；可回收 ${memory.reclaimableGB.toFixed(1)}GB\n`)
  if (memory.swapUsedGB !== undefined) {
    process.stdout.write(`  swap ${memory.swapUsedGB.toFixed(1)}GB / ${memory.swapTotalGB.toFixed(1)}GB${memory.swapUsedGB > memory.swapTotalGB * 0.7 ? '（偏高）' : ''}\n`)
  }
  const top = entries.slice().sort((a, b) => b.rssKB - a.rssKB).slice(0, 5)
  process.stdout.write('  内存占用 Top 5：\n')
  for (const entry of top) process.stdout.write(`    ${mb(entry.rssKB).padStart(8)}  ${entry.command.slice(0, 70)}\n`)

  if (!FIX && vitestOrphans.length > 0) {
    process.stdout.write('\n提示：执行 pnpm dsh:doctor --fix 清理确认的 vitest 孤儿。\n')
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
