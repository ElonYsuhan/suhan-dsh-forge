// 回归测试：个别 PMX 骨骼数组违反「父先子后」约定（mintswimsuit 的
// 左/右ひじ 排在父骨骼 左/右腕捩 之前），Babylon prepare 按数组顺序
// 组合时父终阵陈旧，肘部世界矩阵在两种不一致计算间逐帧摆动，IK 读取
// 不可能几何后陷入多解轮转（手臂双态/三态闪烁）。
// 验证 ensureParentFirstBoneOrder 重排后数组性质 + mintswimsuit 站姿
// 300 帧稳定。依赖仓库根 models/（gitlink，可能未检出）——缺失时自动跳过。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// 注意：MMDCompanion 静态导入会拉起 babylon-mmd 的 WASM 运行时，
// 必须在垫好 self/XHR 之后再动态导入（见 loadSkeleton）。

const MODELS_ROOT = fileURLToPath(new URL('../../../../models/', import.meta.url))
const MINT_PATH = `${MODELS_ROOT}mintswimsuit/model.pmx`

;(globalThis as any).self ??= globalThis
;(globalThis as any).addEventListener ??= () => {}
;(globalThis as any).postMessage ??= () => {}
class XHRStub {
  responseType = ''
  onload: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  private listeners: Record<string, Array<(e: any) => void>> = {}
  addEventListener (type: string, cb: (e: any) => void) { (this.listeners[type] ??= []).push(cb) }
  open () {}
  send () {
    const fire = (type: string) => { const cb = type === 'error' ? this.onerror : this.onload; cb?.({}); for (const l of this.listeners[type] ?? []) l({}) }
    setTimeout(() => fire('error'), 0)
  }
}
;(globalThis as any).XMLHttpRequest = XHRStub

async function loadSkeleton (dir: string): Promise<any> {
  const { ensureParentFirstBoneOrder } = await import('../three/MMDCompanion')
  const { NullEngine, Scene, Vector3, FreeCamera } = await import('@babylonjs/core')
  const { PBRMaterialBuilder, PmxLoader } = await import('babylon-mmd')
  class NoTextureBuilder extends PBRMaterialBuilder {
    async loadDiffuseTexture (...a: any[]): Promise<void> { a[a.length - 1]?.() }
    async loadSphereTexture (...a: any[]): Promise<void> { a[a.length - 1]?.() }
    async loadToonTexture (...a: any[]): Promise<void> { a[a.length - 1]?.() }
  }
  const buffer = readFileSync(`${MODELS_ROOT}${dir}/model.pmx`)
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const camera = new FreeCamera('cam', new Vector3(0, 10, 30), scene)
  camera.setTarget(Vector3.Zero())
  scene.activeCamera = camera
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  const loader: any = new PmxLoader({ materialBuilder: new NoTextureBuilder(), useSdef: false, buildMorph: true, buildSkeleton: true })
  const loadState: any = await new Promise(resolve => {
    loader.loadFile(scene, new Uint8Array(ab), '', (s: any) => resolve(s), undefined, true)
  })
  const result: any = await loader.importMeshAsync('', scene, loadState, '')
  return { result, scene, engine }
}

describe.skipIf(!existsSync(MINT_PATH))('骨骼数组父先子后重排回归', () => {
  it('mintswimsuit 重排后无子先于父；骨骼集合与层级不变', async () => {
    const { ensureParentFirstBoneOrder } = await import('../three/MMDCompanion')
    const { result, engine } = await loadSkeleton('mintswimsuit')
    const skeleton = result.meshes.find((m: any) => m.getTotalVertices() > 0).skeleton
    const namesBefore = skeleton.bones.map((b: any) => b.name)
    const childrenOf = new Map<string, string[]>()
    for (const b of skeleton.bones) {
      const p = b.getParent()
      if (p !== null) {
        const list = childrenOf.get(p.name) ?? []
        list.push(b.name)
        childrenOf.set(p.name, list)
      }
    }
    ensureParentFirstBoneOrder(skeleton)
    const idx = new Map(skeleton.bones.map((b: any, i: number) => [b.name, i]))
    let bad = 0
    for (const b of skeleton.bones) {
      const p = b.getParent()
      if (p !== null && (idx.get(p.name) ?? -1) > idx.get(b.name)!) bad++
    }
    expect(bad).toBe(0)
    // 集合与层级不变：每个骨骼仍挂同一个父、同一组子
    expect(skeleton.bones.map((b: any) => b.name).sort()).toEqual([...namesBefore].sort())
    for (const b of skeleton.bones) {
      const p = b.getParent()
      const parentName = p?.name ?? null
      const kids = (childrenOf.get(b.name) ?? []).sort()
      expect(b.getChildren().map((c: any) => c.name).sort()).toEqual(kids)
      void parentName
    }
    engine.dispose()
  }, 120_000)

  it('mintswimsuit 敛手站姿 300 帧稳定（重排后无多解轮转）', async () => {
    const { ensureParentFirstBoneOrder } = await import('../three/MMDCompanion')
    const { result, scene, engine } = await loadSkeleton('mintswimsuit')
    const { Vector3, Mesh } = await import('@babylonjs/core')
    const { ElegantIdle } = await import('../three/ElegantIdle')
    const meshes = result.meshes as any[]
    const root = meshes.find((m: any) => m instanceof Mesh && m.getTotalVertices() > 0)
    const mesh = root as Mesh
    const skeleton = root.skeleton
    ensureParentFirstBoneOrder(skeleton)

    let minY = Infinity, maxY = -Infinity
    for (const m of meshes) {
      const data = m.getVerticesData('position')
      if (data === null || data === undefined) continue
      for (let i = 1; i < data.length; i += 3) { if (data[i] < minY) minY = data[i]; if (data[i] > maxY) maxY = data[i] }
    }
    const height = maxY - minY
    const scale = height > 0 ? 20 / height : 1
    const baseY = -minY * scale
    for (const bone of skeleton.bones) {
      if (bone.getParent() !== null) continue
      bone.setScale(new Vector3(scale, scale, scale))
      bone.setRotation(new Vector3(0, Math.PI, 0))
      bone.setPosition(new Vector3(0, baseY, 0))
    }
    const find = (name: string) => skeleton.bones.find((b: any) => b.name === name)
    const idle = new ElegantIdle()
    idle.attach(mesh, find('左腕'), find('左ひじ'), find('左手首'), find('右腕'), find('右ひじ'), find('右手首'))

    const bodyBases = new Map<string, Vector3>()
    for (const name of ['上半身', '首', '頭', '腰']) {
      const b = find(name)
      if (b !== undefined) bodyBases.set(name, b.getRotation().clone())
    }
    const hands: number[][] = []
    for (let frame = 0; frame < 300; frame++) {
      const time = frame / 60
      const breathe = Math.sin(time * 1.6) * 0.012
      const sway = Math.sin(time * 0.7) * 0.008
      const headYaw = Math.sin(time * 0.4) * 0.03
      const deltas: Record<string, { x?: number; y?: number; z?: number }> = {
        上半身: { x: breathe }, 首: { x: breathe * 0.5 },
        頭: { x: -breathe * 0.5, y: headYaw, z: sway * 0.4 }, 腰: { z: sway }
      }
      for (const [name, delta] of Object.entries(deltas)) {
        const base = bodyBases.get(name); const b = find(name)
        if (base === undefined || b === undefined) continue
        b.setRotation(new Vector3(base.x + (delta.x ?? 0), base.y + (delta.y ?? 0), base.z + (delta.z ?? 0)))
      }
      idle.update(time)
      scene.render()
      const s = idle.getState()
      if (s !== null) hands.push([...s.leftHand, ...s.rightHand])
    }
    const steady = hands.slice(60)
    let maxStep = 0, maxAlt = 0
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
    // 手落在目标附近（敛手站姿：左 11.1 / 右 11.4，误差 < 0.25）
    const last = steady[steady.length - 1]
    expect(Math.abs(last[1] - 11.1)).toBeLessThan(0.25)
    expect(Math.abs(last[4] - 11.4)).toBeLessThan(0.25)
    expect(maxStep).toBeLessThan(0.05)
    expect(maxAlt).toBeLessThan(0.05)
    engine.dispose()
  }, 120_000)
})
