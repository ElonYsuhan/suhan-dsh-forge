// 回归测试：新增人物模型必须能被 PmxLoader 正常加载（网格 + 骨架），
// 并报告 IK 骨骼链（腕/ひじ/手首）是否齐全（齐全则站姿 IK 接管手臂）。
// 模型位于 DSH 存储目录（软链接 models/），缺失时自动跳过。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MODELS_ROOT = fileURLToPath(new URL('../../../../models/', import.meta.url))

const CASES: Array<{ id: string; label: string }> = [
  { id: 'vivianne', label: '薇薇安' },
  { id: 'jinwu', label: '金乌·毛绒派对' },
  { id: 'zankou-original', label: 'Zankou·原皮' },
  { id: 'zankou-skin2-black', label: 'Zankou·皮肤2黑' }
]

;(globalThis as any).self ??= globalThis
;(globalThis as any).addEventListener ??= () => {}
;(globalThis as any).postMessage ??= () => {}
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

for (const { id, label } of CASES) {
  const pmxPath = `${MODELS_ROOT}${id}/model.pmx`
  describe.skipIf(!existsSync(pmxPath))(`模型加载 ${label} (${id})`, () => {
    it('importMeshAsync 成功：网格/骨架/IK 链齐全', async () => {
      const { NullEngine, Scene, Vector3, Mesh, FreeCamera } = await import('@babylonjs/core')
      const { PBRMaterialBuilder, PmxLoader } = await import('babylon-mmd')

      class NoTextureBuilder extends PBRMaterialBuilder {
        async loadDiffuseTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
        async loadSphereTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
        async loadToonTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
      }

      const buffer = readFileSync(pmxPath)
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
      expect(root!.skeleton).toBeDefined()
      const skeleton = root!.skeleton!

      // 报告 IK 骨骼链与口部/眨眼 morph 的覆盖情况（不强制要求——不同建模组命名不同）
      const names = skeleton.bones.map(b => b.name)
      const ik = ['左腕', '左ひじ', '左手首', '右腕', '右ひじ', '右手首']
      const missing = ik.filter(n => !names.includes(n))
      const morphs = new Set<string>()
      const mgr = root!.morphTargetManager
      if (mgr !== null) {
        for (let i = 0; i < mgr.numTargets; i++) {
          const t = mgr.getTarget(i)
          if (t !== null) morphs.add(t.name)
        }
      }
      console.log(`[${id}] bones=${names.length} morphs=${morphs.size} IK链缺失=${missing.length ? missing.join(',') : '无'} 口形候选=${morphs.size}`)
      for (const mesh of meshes) mesh.dispose(false, true)
      scene.dispose()
      engine.dispose()
    }, 120_000)
  })
}
