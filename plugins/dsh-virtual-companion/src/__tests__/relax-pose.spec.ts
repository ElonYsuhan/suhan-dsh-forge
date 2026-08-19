// 回归测试：放松站姿 VPD（Blender mmd_tools 程序导出）解析与应用。
// 验证：Shift-JIS 骨骼名正确解码、四元数→欧拉写回骨骼后，手臂几何
// 与 Blender 结果一致（大臂下垂 叉开≈0°、肘在肩正下方、双手小腹前）。
// 依赖 models/motions/放松站姿-*.vpd 与模型文件（软链接，缺失自动跳过）。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MODELS_ROOT = fileURLToPath(new URL('../../../../models/', import.meta.url))
const VPD_PATH = fileURLToPath(new URL('../../../../models/motions/放松站姿-vivianne.vpd', import.meta.url))

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

describe.skipIf(!existsSync(VPD_PATH) || !existsSync(`${MODELS_ROOT}vivianne/model.pmx`))('放松站姿 VPD', () => {
  it('解析：6 根手臂骨骼 + Shift-JIS 名称 + 局部四元数', async () => {
    const { Quaternion } = await import('@babylonjs/core')
    const { parseVpdPose } = await import('../three/vpdPose')
    const buffer = readFileSync(VPD_PATH)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    const bones = parseVpdPose(arrayBuffer)
    const names = [...bones.keys()]
    expect(names).toHaveLength(6)
    expect(names).toEqual(expect.arrayContaining(['左腕', '左ひじ', '左手首', '右腕', '右ひじ', '右手首']))
    const qL = bones.get('左腕') as Quaternion
    // 局部坐标系的旋转轴在 z 分量：绕 z 转 ~50.8°（叉开 51° → 0°）
    expect(Math.abs(qL.z)).toBeGreaterThan(0.4)
    expect(qL.length()).toBeCloseTo(1, 5)
  })

  it('应用后手臂几何与 Blender 一致：叉开 0°、肘在肩下、手在小腹前', async () => {
    const { NullEngine, Scene, Vector3, Mesh, FreeCamera } = await import('@babylonjs/core')
    const { PBRMaterialBuilder, PmxLoader } = await import('babylon-mmd')
    const { parseVpdPose, quatToEulerXYZ } = await import('../three/vpdPose')

    class NoTextureBuilder extends PBRMaterialBuilder {
      async loadDiffuseTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
      async loadSphereTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
      async loadToonTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
    }

    const pmxPath = `${MODELS_ROOT}vivianne/model.pmx`
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
    const skeleton = root!.skeleton!
    const find = (name: string) => skeleton.bones.find(b => b.name === name)
    const upperL = find('左腕')!
    const lowerL = find('左ひじ')!
    const wristL = find('左手首')!

    // 应用 VPD 放松站姿（与 applyRelaxPose 相同写回路径：四元数→欧拉）
    const vpdBuffer = readFileSync(VPD_PATH)
    const vpdArrayBuffer = vpdBuffer.buffer.slice(vpdBuffer.byteOffset, vpdBuffer.byteOffset + vpdBuffer.byteLength) as ArrayBuffer
    const quats = parseVpdPose(vpdArrayBuffer)
    for (const [name, quat] of quats) {
      const bone = skeleton.bones.find(b => b.name === name)
      if (bone !== undefined) bone.setRotation(quatToEulerXYZ(quat))
    }
    // 根骨骼归一化（复刻 loadModel）
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
    for (const bone of skeleton.bones) {
      if (bone.getParent() !== null) continue
      bone.setScale(new Vector3(scale, scale, scale))
      bone.setRotation(new Vector3(0, Math.PI, 0))
      bone.setPosition(new Vector3(0, baseY, 0))
    }
    scene.render()

    const worldOf = (bone: any): Vector3 => {
      bone.computeWorldMatrix(true)
      return bone.getWorldMatrix().getTranslation()
    }
    // 模型空间（去掉根变换的旋转/平移，保留缩放无影响——只用方向与差值）
    const rootMat = (find('全ての親') ?? find('操作中心') ?? upperL.getParent()?.getParent() ?? skeleton.bones[0]) as any
    rootMat.computeWorldMatrix(true)
    const rootWorld = rootMat.getWorldMatrix()
    const toModel = (v: Vector3): Vector3 => {
      const local = v.subtract(rootWorld.getTranslation())
      const invQuat = rootWorld.getRotationMatrix().invert()
      return Vector3.TransformCoordinates(local, invQuat)
    }
    const shoulder = toModel(worldOf(upperL))
    const elbow = toModel(worldOf(lowerL))
    const wrist = toModel(worldOf(wristL))

    // babylon-mmd 为 Y-up：下垂方向是 (0,-1,0)，模型正面是 -Z
    const armDir = elbow.subtract(shoulder).normalize()
    const splayDeg = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(armDir, new Vector3(0, -1, 0))))) * 180 / Math.PI
    console.log(`[vivianne-vpd] 肩=(${shoulder.x.toFixed(2)},${shoulder.y.toFixed(2)},${shoulder.z.toFixed(2)}) 肘=(${elbow.x.toFixed(2)},${elbow.y.toFixed(2)},${elbow.z.toFixed(2)}) 腕=(${wrist.x.toFixed(2)},${wrist.y.toFixed(2)},${wrist.z.toFixed(2)}) 叉开=${splayDeg.toFixed(1)}°`)
    expect(splayDeg).toBeLessThan(5)
    // 肘在肩正下方（x/z 偏差 < 0.05，模型 20 单位身高）
    expect(Math.abs(elbow.x - shoulder.x)).toBeLessThan(0.05)
    expect(Math.abs(elbow.z - shoulder.z)).toBeLessThan(0.05)
    // 手在小腹前：低于肘 0.5+、在身体前方（z<0）、贴近身体中线
    // （归一化以顶点高度为基准，比骨骼高度大 ~32%，容差取 0.6）
    expect(wrist.y).toBeLessThan(elbow.y - 0.5)
    expect(wrist.z).toBeLessThan(shoulder.z - 0.2)
    expect(Math.abs(wrist.x - shoulder.x)).toBeLessThan(0.6)
    for (const mesh of meshes) mesh.dispose(false, true)
    scene.dispose()
    engine.dispose()
  }, 120_000)
})
