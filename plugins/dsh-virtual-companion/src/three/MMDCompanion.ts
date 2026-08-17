/**
 * MMD 人物模型场景：用 three.js MMDLoader 加载用户本地 PMX 模型，
 * 驱动待机呼吸、眨眼、说话口型与表情 VMD。
 *
 * 模型资产由宿主 /virtual-companion/model/* 路由从本地数据目录提供，
 * 不随 npm 包分发（模型版权规则禁止二次配布）。
 */
import * as THREE from 'three'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'

/** VMD 中单个 morph 的关键帧序列。 */
interface VmdMorphTrack {
  name: string
  keys: Array<{ frame: number; weight: number }>
}

export interface MMDCompanionOptions {
  /** 状态回调：loading / ready / error（供界面切换立绘占位）。 */
  onStatus?: (status: 'loading' | 'ready' | 'error') => void
}

const MOUTH_CANDIDATES = ['あ', 'い', 'う', 'え', 'お']
const BLINK_CANDIDATES = ['まばたき', 'ウィンク', '笑い']
const VMD_FPS = 30

/**
 * 管理 one 人物模型的三维场景与动画循环。
 */
export class MMDCompanion {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly options: MMDCompanionOptions
  private mesh: THREE.SkinnedMesh | null = null
  private mouthMorphs: string[] = []
  private blinkMorph: string | undefined
  private vmdMorphs: VmdMorphTrack[] = []
  private speaking = false
  private disposed = false
  private rafId = 0
  private lastTime = performance.now()
  private nextBlinkAt = performance.now() + 2_000
  private blinkUntil = 0
  private mouthIndex = 0
  private nextMouthAt = 0

  constructor (canvas: HTMLCanvasElement, options: MMDCompanionOptions = {}) {
    this.canvas = canvas
    this.options = options
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputEncoding = THREE.sRGBEncoding

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200)

    const ambient = new THREE.AmbientLight(0xffffff, 0.95)
    const hemisphere = new THREE.HemisphereLight(0xfff3e0, 0x8a7a9a, 0.7)
    const key = new THREE.DirectionalLight(0xffffff, 1.25)
    key.position.set(3, 6, 5)
    const rim = new THREE.DirectionalLight(0xffe9c8, 0.9)
    rim.position.set(-4, 3, -4)
    this.scene.add(ambient, hemisphere, key, rim)
  }

  /** 加载 PMX 模型与可选表情 VMD。 */
  async load (modelUrl: string, expressionUrl?: string): Promise<void> {
    const loader = new MMDLoader()
    this.options.onStatus?.('loading')
    const mesh = await loader.loadAsync(modelUrl)
    if (this.disposed) return
    this.scene.add(mesh)
    this.mesh = mesh

    const dictionary = mesh.morphTargetDictionary as Record<string, number> | undefined
    const names = dictionary === undefined ? [] : Object.keys(dictionary)
    this.mouthMorphs = MOUTH_CANDIDATES.filter(name => names.includes(name))
    this.blinkMorph = BLINK_CANDIDATES.find(name => names.includes(name))

    // 表情 VMD：morphs 为扁平关键帧数组，按名称分组后逐轨插值；
    // 未知 morph 名静默跳过（不同模型的表情名不一致，由待机口型/眨眼兜底）。
    if (expressionUrl !== undefined) {
      try {
        const clip = await new Promise<any>((resolve, reject) => {
          loader.loadVMD(expressionUrl, resolve, undefined, reject)
        })
        const grouped = new Map<string, Array<{ frame: number; weight: number }>>()
        for (const morph of Array.isArray(clip?.morphs) ? clip.morphs : []) {
          const name = typeof morph.morphName === 'string' ? morph.morphName : ''
          if (name === '' || !names.includes(name)) continue
          if (typeof morph.frame !== 'number' || typeof morph.weight !== 'number') continue
          const list = grouped.get(name) ?? []
          list.push({ frame: morph.frame, weight: morph.weight })
          grouped.set(name, list)
        }
        this.vmdMorphs = [...grouped.entries()]
          .map(([name, keys]) => ({ name, keys: keys.sort((left, right) => left.frame - right.frame) }))
          .filter(track => track.keys.length > 0)
      } catch {
        // 表情包缺失或损坏不影响基本待机与口型
      }
    }

    // 相机适配：完整取景 + 轻微俯视
    const box = new THREE.Box3().setFromObject(mesh)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) * 0.72
    const distance = radius / Math.tan((this.camera.fov * Math.PI) / 360)
    this.camera.position.set(0, center.y + size.y * 0.28, distance * 1.25)
    this.camera.lookAt(0, center.y + size.y * 0.18, 0)
    this.resize()
    this.options.onStatus?.('ready')
  }

  /** 说话状态：驱动口型 morph 循环。 */
  setSpeaking (speaking: boolean): void {
    this.speaking = speaking
    if (!speaking) this.applyMorphs(this.mouthMorphs, 0)
  }

  /** 启动渲染循环。 */
  start (): void {
    this.rafId = requestAnimationFrame(this.tick)
  }

  /** 停止循环并释放 GPU 资源。 */
  dispose (): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    if (this.mesh !== null) {
      this.disposeObject(this.mesh)
      this.mesh = null
    }
    this.renderer.dispose()
  }

  private setMorph (name: string, weight: number): void {
    const mesh = this.mesh
    if (mesh === null) return
    const index = mesh.morphTargetDictionary?.[name]
    if (index === undefined) return
    mesh.morphTargetInfluences![index] = weight
  }

  private applyMorphs (names: string[], weight: number): void {
    for (const name of names) this.setMorph(name, weight)
  }

  private readonly tick = (): void => {
    if (this.disposed) return
    const now = performance.now()
    const delta = Math.min(0.05, (now - this.lastTime) / 1_000)
    this.lastTime = now
    this.update(delta, now)
    this.renderer.render(this.scene, this.camera)
    this.rafId = requestAnimationFrame(this.tick)
  }

  private update (_delta: number, now: number): void {
    const mesh = this.mesh
    if (mesh === null) return
    const time = now / 1_000

    // 待机呼吸：轻微缩放与上下浮动
    const breathe = Math.sin(time * 1.6) * 0.004
    mesh.scale.setScalar(1 + breathe + (this.speaking ? 0.01 : 0))
    mesh.position.y = Math.sin(time * 2) * 0.08
    mesh.rotation.y = Math.sin(time * 0.6) * 0.06

    // 眨眼：每 2.5-5 秒一次，约 90ms 快闭快开
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 90
      this.nextBlinkAt = now + 2_500 + (now % 2_500)
    }
    if (this.blinkMorph !== undefined) {
      this.setMorph(this.blinkMorph, now < this.blinkUntil ? 1 : 0)
    }

    // 口型：说话时每 ~130ms 切换一个口型 morph
    if (this.speaking && this.mouthMorphs.length > 0) {
      if (now >= this.nextMouthAt) {
        const current = this.mouthMorphs[this.mouthIndex]
        if (current !== undefined) this.setMorph(current, 0)
        this.mouthIndex = (this.mouthIndex + 1) % this.mouthMorphs.length
        const next = this.mouthMorphs[this.mouthIndex]
        if (next !== undefined) this.setMorph(next, 0.85)
        this.nextMouthAt = now + 130
      }
    }

    // 表情 VMD：按 30fps 时间轴插值 morph 权重
    const firstTrack = this.vmdMorphs[0]
    if (firstTrack !== undefined && firstTrack.keys.length > 0) {
      const lastKey = firstTrack.keys[firstTrack.keys.length - 1]
      if (lastKey !== undefined && lastKey.frame > 0) {
        const frame = (time * VMD_FPS) % lastKey.frame
        for (const track of this.vmdMorphs) {
          const keys = track.keys
          const firstKey = keys[0]
          if (firstKey === undefined) continue
          let previous = firstKey
          let next = firstKey
          for (let index = 0; index < keys.length - 1; index++) {
            const left = keys[index]
            const right = keys[index + 1]
            if (left === undefined || right === undefined) continue
            if (frame >= left.frame && frame <= right.frame) {
              previous = left
              next = right
              break
            }
          }
          const span = next.frame - previous.frame
          const weight = span <= 0
            ? previous.weight
            : previous.weight + ((next.weight - previous.weight) * (frame - previous.frame)) / span
          this.setMorph(track.name, weight)
        }
      }
    }
  }

  private resize (): void {
    const parent = this.canvas.parentElement
    const width = Math.max(1, parent?.clientWidth ?? this.canvas.clientWidth)
    const height = Math.max(1, parent?.clientHeight ?? this.canvas.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private disposeObject (root: THREE.Object3D): void {
    root.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        const material = child.material
        if (Array.isArray(material)) material.forEach(item => item.dispose())
        else material.dispose()
      }
    })
    root.clear()
  }
}
