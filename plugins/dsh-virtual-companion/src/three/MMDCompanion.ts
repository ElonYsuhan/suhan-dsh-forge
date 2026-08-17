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
const SMILE_CANDIDATES = ['笑い', 'にこり', '微笑', '笑顔']
const VMD_FPS = 30
/** 所有模型统一归一化到该世界高度（甘雨原生高度 19.9）。 */
const TARGET_MODEL_HEIGHT = 20

export type GestureName = 'wave' | 'nod' | 'shake' | 'tilt' | 'bow' | 'smile'

/** 手势时长（毫秒）与正弦包络（淡入淡出即交叉混合）。 */
const GESTURE_DURATIONS: Record<GestureName, number> = {
  wave: 1_600,
  nod: 900,
  shake: 1_000,
  tilt: 1_400,
  bow: 1_200,
  smile: 2_200
}
/** 待机肢体动作涉及的 MMD 标准骨骼名（按日文名匹配，缺失则跳过）。 */
const BODY_BONE_CANDIDATES = ['頭', '首', '上半身', '腰', '左腕', '右腕', '左ひじ', '右ひじ']

/**
 * 双手抱胸姿势偏移（根据 PMX 骨骼局部轴推导：左臂 +x 向后、右臂 +x 向前）：
 * 上臂前摆 + 内收，手肘折叠把前臂抬至胸前交叉。叠加到模型初始旋转上。
 */
const ARM_POSE_OFFSETS: Record<string, { x?: number; z?: number }> = {
  左腕: { x: -0.55, z: 0.35 },
  右腕: { x: 0.55, z: 0.35 },
  左ひじ: { x: -1.45, z: 0.25 },
  右ひじ: { x: 1.45, z: 0.25 }
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
  private smileMorph: string | undefined
  private vmdMorphs: VmdMorphTrack[] = []
  private bodyBones = new Map<string, BoneTarget>()
  private speaking = false
  private speechLevel = 0
  private fitDistance = 20
  private gesture: { name: GestureName; startAt: number } | null = null
  private lookTarget = { x: 0, y: 0 }
  private currentLook = { x: 0, y: 0 }
  private baseScale = 1
  private baseY = 0
  private faceLight: THREE.DirectionalLight
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

    // 无方向的环境光/半球光会给模型所有面均匀加白（“雾感”来源），
    // 只保留极弱环境补光 + 主光 + 背光，靠方向光塑造明暗
    const ambient = new THREE.AmbientLight(0xffffff, 0.1)
    const key = new THREE.DirectionalLight(0xffffff, 0.52)
    key.position.set(3, 6, 5)
    const rim = new THREE.DirectionalLight(0xffe9c8, 0.12)
    rim.position.set(-4, 3, -4)
    // 面部直射光：从正面补光照亮面部，强度可由设置面板动态调整
    this.faceLight = new THREE.DirectionalLight(0xffffff, 0.85)
    this.faceLight.position.set(0, 2, 6)
    this.scene.add(ambient, key, rim, this.faceLight)
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

    // 高度归一化：所有模型缩放到统一世界高度，脚底贴地（y=0），
    // 换模型时取景与站姿保持一致。
    const rawBox = new THREE.Box3().setFromObject(mesh)
    const rawSize = rawBox.getSize(new THREE.Vector3())
    if (rawSize.y > 0) {
      mesh.scale.multiplyScalar(TARGET_MODEL_HEIGHT / rawSize.y)
    }
    this.baseScale = mesh.scale.y
    mesh.updateMatrixWorld(true)
    const groundedBox = new THREE.Box3().setFromObject(mesh)
    this.baseY = -groundedBox.min.y
    mesh.position.y = this.baseY

    const dictionary = mesh.morphTargetDictionary as Record<string, number> | undefined
    const names = dictionary === undefined ? [] : Object.keys(dictionary)
    this.mouthMorphs = MOUTH_CANDIDATES.filter(name => names.includes(name))
    this.blinkMorph = BLINK_CANDIDATES.find(name => names.includes(name))
    this.smileMorph = SMILE_CANDIDATES.find(name => names.includes(name))
    this.gesture = null

    // 收集待机肢体动作所需的骨骼及其基础旋转；
    // 手背后姿势偏移直接烘焙进基础旋转并立即应用。
    this.bodyBones.clear()
    for (const name of BODY_BONE_CANDIDATES) {
      const bone = mesh.skeleton.getBoneByName(name)
      if (bone !== undefined) {
        const base = bone.rotation.clone()
        const offset = ARM_POSE_OFFSETS[name]
        if (offset !== undefined) {
          base.x += offset.x ?? 0
          base.z += offset.z ?? 0
        }
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

    // 相机适配：高度归一化后按画布满框取景——高度恰好填满画布
    // （脚贴底、头贴顶），宽裙摆等超宽部分允许横向出画。
    // 放大通过组件放大画布 DOM 实现（相机保持取景距离不变）。
    mesh.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(mesh)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const halfFov = (this.camera.fov * Math.PI) / 360
    this.fitDistance = size.y / 2 / Math.tan(halfFov) * 1.02
    this.camera.position.set(0, center.y, this.fitDistance)
    this.camera.lookAt(0, center.y, 0)
    this.resize()
    this.options.onStatus?.('ready')
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

  /** 播放一次瞬态手势（与待机层叠加混合，新手势替换旧手势）。 */
  playGesture (name: GestureName): void {
    this.gesture = { name, startAt: performance.now() }
  }

  /** 语音音量包络（0-1），驱动口型张合幅度。 */
  setSpeechLevel (level: number): void {
    this.speechLevel = Math.min(1, Math.max(0, level))
  }

  /** 视线跟随目标（-1..1 归一化，组件把指针位置映射进来）。 */
  setLookTarget (x: number, y: number): void {
    this.lookTarget = {
      x: Math.min(1, Math.max(-1, x)),
      y: Math.min(1, Math.max(-1, y))
    }
  }

  /** 面部直射光强度（0-2），设置面板滑杆动态调整。 */
  setFaceLight (intensity: number): void {
    this.faceLight.intensity = Math.min(2, Math.max(0, intensity))
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

    // 站稳：不做整体漂浮/摇摆，只保留轻微呼吸缩放与骨骼级生机
    const breathe = Math.sin(time * 1.6) * 0.003
    mesh.scale.setScalar(this.baseScale * (1 + breathe + (this.speaking ? 0.008 : 0)))
    mesh.position.y = this.baseY
    mesh.rotation.y = 0
    this.updateBodyPose(time)

    // 视线跟随：头部朝目标平滑微转
    this.currentLook.x += (this.lookTarget.x - this.currentLook.x) * 0.08
    this.currentLook.y += (this.lookTarget.y - this.currentLook.y) * 0.08
    const head = this.bodyBones.get('頭')
    if (head !== undefined) {
      head.bone.rotation.y += this.currentLook.x * 0.32
      head.bone.rotation.x += -this.currentLook.y * 0.16
    }

    // 眨眼：每 2.5-5 秒一次，约 90ms 快闭快开
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 90
      this.nextBlinkAt = now + 2_500 + (now % 2_500)
    }
    if (this.blinkMorph !== undefined) {
      this.setMorph(this.blinkMorph, now < this.blinkUntil ? 1 : 0)
    }

    // 口型：说话时每 ~130ms 切换口型，张合幅度随音量包络
    if (this.speaking && this.mouthMorphs.length > 0) {
      if (now >= this.nextMouthAt) {
        const current = this.mouthMorphs[this.mouthIndex]
        if (current !== undefined) this.setMorph(current, 0)
        this.mouthIndex = (this.mouthIndex + 1) % this.mouthMorphs.length
        const next = this.mouthMorphs[this.mouthIndex]
        if (next !== undefined) this.setMorph(next, 0.3 + this.speechLevel * 0.7)
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
    this.applyGesture(now)
  }

  /** 瞬态手势：正弦包络淡入淡出，与待机姿态叠加混合。 */
  private applyGesture (now: number): void {
    if (this.gesture === null) return
    const { name, startAt } = this.gesture
    const duration = GESTURE_DURATIONS[name]
    const elapsed = now - startAt
    if (elapsed >= duration) {
      this.gesture = null
      return
    }
    const progress = elapsed / duration
    const envelope = Math.sin(Math.PI * progress)
    const time = now / 1_000

    const addBone = (boneName: string, dx: number, dy: number, dz: number): void => {
      const target = this.bodyBones.get(boneName)
      if (target === undefined) return
      target.bone.rotation.x += dx
      target.bone.rotation.y += dy
      target.bone.rotation.z += dz
    }

    switch (name) {
      case 'wave': {
        // 右臂抬起挥手：上臂前举 + 手肘微屈 + 手腕快速摆动
        addBone('右腕', 1.25 * envelope, 0, Math.sin(time * 18) * 0.18 * envelope)
        addBone('右ひじ', 0.45 * envelope, 0, 0)
        break
      }
      case 'nod':
        addBone('頭', Math.sin(progress * Math.PI * 2) * 0.2, 0, 0)
        break
      case 'shake':
        addBone('頭', 0, Math.sin(progress * Math.PI * 2) * 0.25, 0)
        break
      case 'tilt':
        addBone('頭', 0, 0, 0.26 * envelope)
        break
      case 'bow':
        addBone('上半身', 0.35 * envelope, 0, 0)
        addBone('首', 0.2 * envelope, 0, 0)
        break
      case 'smile':
        if (this.smileMorph !== undefined) {
          this.setMorph(this.smileMorph, envelope * 0.9)
        }
        break
    }
  }

  /** 程序化肢体待机动作：极小幅度的呼吸与头部生机，身体站稳不晃。 */
  private updateBodyPose (time: number): void {
    if (this.bodyBones.size === 0) return
    const intensity = this.speaking ? 1.5 : 1
    const breathe = Math.sin(time * 1.6) * 0.012 * intensity
    const sway = Math.sin(time * 0.7) * 0.008 * intensity
    const headYaw = Math.sin(time * 0.4) * 0.03 * intensity
    const deltas: Record<string, { x?: number; y?: number; z?: number }> = {
      上半身: { x: breathe },
      首: { x: breathe * 0.5 },
      頭: { x: -breathe * 0.5, y: headYaw, z: sway * 0.4 },
      腰: { z: sway },
      左腕: { z: sway },
      右腕: { z: -sway },
      左ひじ: { z: -breathe * 0.4 },
      右ひじ: { z: -breathe * 0.4 }
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

  /** 画布尺寸变化时由组件调用（滚轮缩放/窗口变化）。 */
  resize (): void {
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
