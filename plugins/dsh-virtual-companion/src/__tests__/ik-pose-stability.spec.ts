// 回归测试：真实 PMX + 真实 IK 管线，验证站姿在各偏航下无每帧交替摆动
// （此前极点按世界 x 判左右，模型转到 ~86.5° 附近时极点每帧翻侧、胳膊来回甩）。
// 依赖仓库根 models/（gitlink，可能未检出）——缺失时自动跳过。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MODEL_PATH = fileURLToPath(new URL('../../../../models/ganyu/model.pmx', import.meta.url))

// babylon-mmd 的 WASM worker 助手在模块顶层引用 self（浏览器环境符号），
// 无头环境先垫上再动态导入。
;(globalThis as any).self ??= globalThis
;(globalThis as any).addEventListener ??= () => {}
;(globalThis as any).postMessage ??= () => {}
// 贴图加载在 node 无 XHR：失败即回退默认贴图（骨架测试不需要贴图）
class XHRStub {
  responseType = ''
  onload: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  private listeners: Record<string, Array<(e: any) => void>> = {}
  addEventListener (type: string, cb: (e: any) => void) {
    ;(this.listeners[type] ??= []).push(cb)
  }

  open () {}
  send () {
    const fire = (type: string) => {
      const cb = type === 'error' ? this.onerror : this.onload
      cb?.({})
      for (const l of this.listeners[type] ?? []) l({})
    }
    setTimeout(() => fire('error'), 0)
  }
}
;(globalThis as any).XMLHttpRequest = XHRStub

describe.skipIf(!existsSync(MODEL_PATH))('ElegantIdle 站姿无振荡回归', () => {
  for (const [label, yaw] of [['正面 0°', 0], ['侧面 90°', Math.PI / 2], ['极点翻侧区 ~86.5°', 1.51]] as Array<[string, number]>) {
    it(`${label}：手/肘 300 帧收敛且无每帧交替`, async () => {
      const r = await runYaw(yaw)
      console.log(`${label} L手`, r.leftHand.map(v => v.toFixed(2)), 'L肘', r.leftElbow.map(v => v.toFixed(2)),
        'R手', r.rightHand.map(v => v.toFixed(2)), 'R肘', r.rightElbow.map(v => v.toFixed(2)),
        `maxStep=${r.maxStep.toFixed(5)} maxAlt=${r.maxAlt.toFixed(5)}`)
      expect(r.maxStep).toBeLessThan(0.05)
      expect(r.maxAlt).toBeLessThan(0.005)
      // 手必须落在目标上（肚脐下方小腹前），误差 < 0.1 单位
      expect(Math.abs(r.leftHand[1] - 11.1)).toBeLessThan(0.1)
      expect(Math.abs(r.rightHand[1] - 11.4)).toBeLessThan(0.1)
    }, 60_000)
  }
})

async function runYaw (yaw: number): Promise<{
  maxStep: number
  maxAlt: number
  leftHand: number[]
  rightHand: number[]
  leftElbow: number[]
  rightElbow: number[]
}> {
  const { NullEngine, Scene, Vector3, Mesh, FreeCamera } = await import('@babylonjs/core')
  const { PBRMaterialBuilder, PmxLoader } = await import('babylon-mmd')
  const { ElegantIdle } = await import('../three/ElegantIdle')

  // 骨架复现不需要贴图：跳过全部贴图加载，避免 node 无网络环境挂起
  class NoTextureBuilder extends PBRMaterialBuilder {
    async loadDiffuseTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
    async loadSphereTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
    async loadToonTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
  }

  const buffer = readFileSync(MODEL_PATH)
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const camera = new FreeCamera('repro-cam', new Vector3(0, 10, 30), scene)
  camera.setTarget(Vector3.Zero())
  scene.activeCamera = camera
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  const loader: any = new PmxLoader({ materialBuilder: new NoTextureBuilder(), useSdef: false, buildMorph: true, buildSkeleton: true })
  const view = new Uint8Array(arrayBuffer)
  const loadState: any = await new Promise(resolve => {
    loader.loadFile(scene, view, '', (state: any) => resolve(state), undefined, true)
  })
  const result: any = await loader.importMeshAsync('', scene, loadState, '')
  const meshes = result.meshes as Mesh[]
  const root = meshes.find(m => m instanceof Mesh && m.getTotalVertices() > 0)
  expect(root).toBeDefined()
  const mesh = root as Mesh
  const skeleton = mesh.skeleton
  expect(skeleton).toBeDefined()

  // 复刻 loadModel 的归一化：根骨骼 scale/rotation（含用户偏航）/position
  let minY = Infinity
  let maxY = -Infinity
  for (const m of meshes) {
    const data = m.getVerticesData('position')
    if (data === null || data === undefined) continue
    for (let i = 1; i < data.length; i += 3) {
      if (data[i] < minY) minY = data[i]
      if (data[i] > maxY) maxY = data[i]
    }
  }
  const height = maxY - minY
  const scale = height > 0 ? 20 / height : 1
  const baseY = -minY * scale
  for (const bone of skeleton!.bones) {
    if (bone.getParent() !== null) continue
    bone.setScale(new Vector3(scale, scale, scale))
    bone.setRotation(new Vector3(0, Math.PI + yaw, 0))
    bone.setPosition(new Vector3(0, baseY, 0))
  }

  const find = (name: string) => skeleton!.bones.find(b => b.name === name)
  const upperL = find('左腕')!
  const lowerL = find('左ひじ')!
  const wristL = find('左手首')!
  const upperR = find('右腕')!
  const lowerR = find('右ひじ')!
  const wristR = find('右手首')!
  const idle = new ElegantIdle()
  idle.attach(mesh, upperL, lowerL, wristL, upperR, lowerR, wristR)

  // 复刻 updateBodyPose：呼吸/摆动/头部微动每帧写回躯干骨骼
  const bodyBases = new Map<string, Vector3>()
  for (const name of ['上半身', '首', '頭', '腰']) {
    const bone = find(name)
    if (bone !== undefined) bodyBases.set(name, bone.getRotation().clone())
  }
  const track: Array<number[]> = []
  for (let frame = 0; frame < 300; frame++) {
    const time = frame / 60
    const breathe = Math.sin(time * 1.6) * 0.012
    const sway = Math.sin(time * 0.7) * 0.008
    const headYaw = Math.sin(time * 0.4) * 0.03
    const deltas: Record<string, { x?: number; y?: number; z?: number }> = {
      上半身: { x: breathe },
      首: { x: breathe * 0.5 },
      頭: { x: -breathe * 0.5, y: headYaw, z: sway * 0.4 },
      腰: { z: sway }
    }
    for (const [name, delta] of Object.entries(deltas)) {
      const base = bodyBases.get(name)
      const bone = find(name)
      if (base === undefined || bone === undefined) continue
      bone.setRotation(new Vector3(base.x + (delta.x ?? 0), base.y + (delta.y ?? 0), base.z + (delta.z ?? 0)))
    }
    idle.update(time)
    scene.render()
    const state = idle.getState()!
    track.push([...state.leftHand, ...state.rightHand, ...state.leftElbow, ...state.rightElbow])
  }
  // 只看稳态（跳过前 60 帧收敛期）：相邻帧位移与交替性
  const steady = track.slice(60)
  let maxStep = 0
  let maxAlt = 0
  for (let i = 2; i < steady.length; i++) {
    for (let k = 0; k < 6; k++) {
      const step = Math.abs(steady[i][k] - steady[i - 1][k])
      if (step > maxStep) maxStep = step
      const d1 = steady[i][k] - steady[i - 1][k]
      const d2 = steady[i - 1][k] - steady[i - 2][k]
      const alt = d1 * d2 < 0 ? Math.min(Math.abs(d1), Math.abs(d2)) : 0
      if (alt > maxAlt) maxAlt = alt
    }
  }
  const last = steady[steady.length - 1]
  return {
    maxStep,
    maxAlt,
    leftHand: last.slice(0, 3),
    rightHand: last.slice(3, 6),
    leftElbow: last.slice(6, 9),
    rightElbow: last.slice(9, 12)
  }
}
