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
/** 待机肢体动作涉及的 MMD 标准骨骼名（按日文名匹配，缺失则跳过）。 */
const BODY_BONE_CANDIDATES = ['頭', '首', '上半身', '腰', '左腕', '右腕', '左ひじ', '右ひじ']

/**
 * 手背后姿势偏移：MMD 默认站姿双臂外张，这里把上臂后摆、手肘折叠，
 * 叠加到模型初始旋转上（左右镜像符号）。若某些模型方向相反再调整。
 */
const ARM_POSE_OFFSETS: Record<string, { x: number }> = {
  左腕: { x: -0.95 },
  右腕: { x: 0.95 },
  左ひじ: { x: -1.9 },
  右ひじ: { x: 1.9 }
}

interface BoneTarget {
  bone: THREE.Bone
  base: THREE.Euler
}

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
  private bodyBones = new Map<string, BoneTarget>()
  private speaking = false
  private fitDistance = 20
  private zoomFactor = 1
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200)

    // MMD 卡通材质按光源累加着色，总强度必须压低（约 0.9），
    // 否则浅色模型整体泛白；ACES 同时柔和高光滚降
    const ambient = new THREE.AmbientLight(0xffffff, 0.22)
    const hemisphere = new THREE.HemisphereLight(0xfff2e0, 0x8a7a9a, 0.1)
    const key = new THREE.DirectionalLight(0xffffff, 0.48)
    key.position.set(3, 6, 5)
    const rim = new THREE.DirectionalLight(0xffe9c8, 0.16)
    rim.position.set(-4, 3, -4)
    this.scene.add(ambient, hemisphere, key, rim)
  }

  /** 释放当前模型（切换模型前调用）。 */
  private clearModel (): void {
    this.vmdMorphs = []
    this.bodyBones.clear()
    this.mouthMorphs = []
    this.blinkMorph = undefined
    if (this.mesh !== null) {
      this.scene.remove(this.mesh)
      this.disposeObject(this.mesh)
      this.mesh = null
    }
  }

  /** 加载 PMX 模型与可选表情 VMD；重复调用即切换模型。 */
  async loadModel (modelUrl: string, expressionUrl?: string): Promise<void> {
    this.clearModel()
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

    // 收集待机肢体动作所需的骨骼及其基础旋转；
    // 手背后姿势偏移直接烘焙进基础旋转并立即应用。
    this.bodyBones.clear()
    for (const name of BODY_BONE_CANDIDATES) {
      const bone = mesh.skeleton.getBoneByName(name)
      if (bone !== undefined) {
        const base = bone.rotation.clone()
        const offset = ARM_POSE_OFFSETS[name]
        if (offset !== undefined) base.x += offset.x
        bone.rotation.copy(base)
        this.bodyBones.set(name, { bone, base })
      }
    }

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

    // 相机适配：完整取景 + 轻微俯视；记录基准距离供滚轮缩放
    const box = new THREE.Box3().setFromObject(mesh)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) * 0.72
    const distance = radius / Math.tan((this.camera.fov * Math.PI) / 360)
    this.fitDistance = distance * 1.25
    this.camera.position.set(0, center.y + size.y * 0.28, this.fitDistance)
    this.camera.lookAt(0, center.y + size.y * 0.18, 0)
    this.zoomFactor = 1
    this.resize()
    this.options.onStatus?.('ready')
  }

  /** 滚轮缩放：deltaY > 0 缩小，< 0 放大；0.25x-12x，可拉近至局部特写。 */
  zoomBy (deltaY: number): void {
    if (this.fitDistance <= 0) return
    this.zoomFactor = THREE.MathUtils.clamp(this.zoomFactor * (deltaY > 0 ? 1.1 : 0.9), 0.25, 12)
    this.camera.position.z = this.fitDistance * this.zoomFactor
  }

  /** 说话状态：驱动口型 morph 循环。 */
  setSpeaking (speaking: boolean): void {
    this.speaking = speaking
    if (!speaking) this.applyMorphs(this.mouthMorphs, 0)
  }

  /** 亮度（色调映射曝光），由设置面板滑杆驱动。 */
  setBrightness (brightness: number): void {
    this.renderer.toneMappingExposure = brightness
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
    mesh.rotation.y = Math.sin(time * 0.6) * 0.02
    this.updateBodyPose(time)

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

  /** 程序化肢体待机动作：呼吸、重心摆动、手臂轻摆与头部轻动。 */
  private updateBodyPose (time: number): void {
    if (this.bodyBones.size === 0) return
    const intensity = this.speaking ? 1.6 : 1
    const breathe = Math.sin(time * 1.6) * 0.02 * intensity
    const sway = Math.sin(time * 0.7) * 0.03 * intensity
    const headYaw = Math.sin(time * 0.4) * 0.05 * intensity
    const deltas: Record<string, { x?: number; y?: number; z?: number }> = {
      上半身: { x: breathe },
      首: { x: breathe * 0.5 },
      頭: { x: -breathe * 0.5, y: headYaw, z: sway * 0.4 },
      腰: { z: sway },
      左腕: { z: sway * 1.2 },
      右腕: { z: -sway * 1.2 },
      左ひじ: { z: -breathe * 0.6 },
      右ひじ: { z: -breathe * 0.6 }
    }
    for (const [name, delta] of Object.entries(deltas)) {
      const target = this.bodyBones.get(name)
      if (target === undefined) continue
      target.bone.rotation.set(
        target.base.x + (delta.x ?? 0),
        target.base.y + (delta.y ?? 0),
        target.base.z + (delta.z ?? 0)
      )
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
