/**
 * Babylon.js 渲染层：WebGPU（回退 WebGL2）+ babylon-mmd 加载 PMX，
 * PBR 材质 + HDR 环境光/IBL + 阴影 + 后处理（FXAA/Bloom/色调映射）。
 *
 * 动画与行为：待机呼吸、眨眼、说话口型（音量包络）、表情 VMD、
 * 瞬态手势、视线跟随、思考表情；默认站姿为 ElegantIdle
 * （TwoBoneIK 优雅手姿，聊天默认动作，见 ElegantIdle.ts）。
 * 模型资产由宿主 /virtual-companion/model/* 提供。
 */
import {
  AbstractEngine,
  Bone,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  Engine,
  HemisphericLight,
  ImportMeshAsync,
  Mesh,
  MeshBuilder,
  MorphTargetManager,
  RawTexture,
  Scene,
  ShadowGenerator,
  Texture,
  UniversalCamera,
  Vector3,
  WebGPUEngine
} from '@babylonjs/core'
import { ShadowOnlyMaterial } from '@babylonjs/materials'
import { PBRMaterialBuilder, RegisterMmdModelLoaders } from 'babylon-mmd'
import { ElegantIdle } from './ElegantIdle'

export type GestureName = 'wave' | 'nod' | 'shake' | 'tilt' | 'bow' | 'smile'

const TARGET_MODEL_HEIGHT = 20
const MOUTH_CANDIDATES = ['あ', 'い', 'う', 'え', 'お']
const BLINK_CANDIDATES = ['まばたき', 'ウィンク', '笑い']
const SMILE_CANDIDATES = ['笑い', 'にこり', '微笑', '笑顔']
const BODY_BONE_CANDIDATES = ['頭', '首', '上半身', '腰', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首']

/** 重心偏侧（S 形微侧，避免完全对称的僵硬站姿）：腰/上身/头反向微倾。 */
const GRAVITY_SHIFT: Record<string, { z?: number }> = {
  腰: { z: 0.02 },
  上半身: { z: -0.03 },
  頭: { z: 0.025 }
}

/** 手腕自然姿态（IK 生效时也应用；腕/肘由 ElegantIdle 接管）。 */
const WRIST_POSE: Record<string, { z?: number }> = {
  左手首: { z: -0.1 },
  右手首: { z: 0.1 }
}

/** 手臂兜底姿态（仅当模型缺少 IK 骨骼链时使用；IK 生效时无效）。 */
const ARM_FALLBACK_OFFSETS: Record<string, { x?: number; z?: number }> = {
  左腕: { x: -0.15, z: -1.05 },
  右腕: { x: -0.15, z: 1.05 },
  左ひじ: { x: -0.4 },
  右ひじ: { x: -0.4 }
}

/** NaturalHandPose：手指轻微弯曲（段号 1→0 索引；指尖方向经实测为 -x，与肘同向）。 */
const FINGER_CURVATURE = [-0.05, -0.09, -0.12]
const FINGER_NAME_RE = /^(左|右)(親指|人差し指|中指|薬指|小指)(\d+)$/

const GESTURE_DURATIONS: Record<GestureName, number> = {
  wave: 1_600,
  nod: 900,
  shake: 1_000,
  tilt: 1_400,
  bow: 1_200,
  smile: 2_200
}

interface BoneTarget {
  bone: Bone
  base: Vector3
}

interface VmdMorphTrack {
  name: string
  keys: Array<{ frame: number; weight: number }>
}

export interface MMDCompanionOptions {
  onStatus?: (status: 'loading' | 'ready' | 'error') => void
}

let loadersRegistered = false

/**
 * 管理一个人物模型的 Babylon 场景与动画循环。
 * 对外接口与原 three 实现一致，组件无需改动。
 */
export class MMDCompanion {
  private readonly canvas: HTMLCanvasElement
  private readonly options: MMDCompanionOptions
  private engine: AbstractEngine | null = null
  private scene: Scene | null = null
  private mesh: Mesh | null = null
  private meshes: Mesh[] = []
  private morphManager: MorphTargetManager | null = null
  private bodyBones = new Map<string, BoneTarget>()
  private mouthMorphs: string[] = []
  private blinkMorph: string | undefined
  private smileMorph: string | undefined
  private vmdMorphs: VmdMorphTrack[] = []
  private faceLight: DirectionalLight | null = null
  private ground: Mesh | null = null
  private shadowGen: ShadowGenerator | null = null
  private speaking = false
  private thinking = false
  private speechLevel = 0
  private fitDistance = 30
  private baseY = 0
  private centerY = 10
  private gesture: { name: GestureName; startAt: number } | null = null
  private lookTarget = { x: 0, y: 0 }
  private currentLook = { x: 0, y: 0 }
  private disposed = false
  private renderLoopStarted = false
  private lastTime = performance.now()
  private nextBlinkAt = performance.now() + 2_000
  private blinkUntil = 0
  private mouthIndex = 0
  private nextMouthAt = 0
  private loadSeq = 0
  // 用户拖拽旋转：附加偏航（叠加在根骨骼 π 基准上）+ 相机俯仰轨道
  private userYaw = 0
  private cameraPitch = 0
  /** 优雅站姿状态（TwoBoneIK 驱动双手，角色聊天默认动作）。 */
  private readonly elegantIdle = new ElegantIdle()
  private ikActive = false

  constructor (canvas: HTMLCanvasElement, options: MMDCompanionOptions = {}) {
    this.canvas = canvas
    this.options = options
    // 调试钩子：控制台/无头浏览器可读写场景状态，用于朝向等视觉问题诊断
    const self = this
    ;(globalThis as unknown as { __mmdDebug?: unknown }).__mmdDebug = {
      get camera () { return self.scene?.activeCamera ?? null },
      get meshes () { return self.meshes },
      get skeleton () { return self.mesh?.skeleton ?? null },
      rotateRoots (angle: number): string[] {
        const skeleton = self.mesh?.skeleton
        if (skeleton === null || skeleton === undefined) return []
        const rotated: string[] = []
        for (const bone of skeleton.bones) {
          if (bone.getParent() === null) {
            bone.setRotation(new Vector3(0, angle, 0))
            rotated.push(bone.name)
          }
        }
        return rotated
      },
      rotateBy (yaw: number, pitch: number): void { self.rotateBy(yaw, pitch) },
      /** 姿态基准（base 向量；updateBodyPose 每帧叠加呼吸后写回骨骼，可原地调参）。 */
      get bonePose () {
        const out: Record<string, number[]> = {}
        for (const [name, target] of self.bodyBones) out[name] = [target.base.x, target.base.y, target.base.z]
        return out
      },
      setBoneBase (name: string, x: number, y: number, z: number): boolean {
        const target = self.bodyBones.get(name)
        if (target === undefined) return false
        target.base.set(x, y, z)
        return true
      },
      boneMatrix (name: string): number[] {
        const mesh = self.mesh
        const skeleton = mesh?.skeleton
        if (mesh === null || skeleton === null || skeleton === undefined) return []
        const mats = skeleton.getTransformMatrices(mesh)
        const idx = skeleton.bones.findIndex(b => b.name === name)
        if (idx < 0) return []
        return Array.from(mats.slice(idx * 16, idx * 16 + 16)).map(v => Math.round(v * 100) / 100)
      },
      /** ElegantIdle 诊断：手/肘世界位置 + 肘关节角（反关节检查）。 */
      getIkState () { return self.elegantIdle.getState() },
      /** 调参：左右手 IK 目标（归一化模型空间：身高 20、脚底 y=0、正面 -z）。 */
      setIkTargets (lx: number, ly: number, lz: number, rx: number, ry: number, rz: number): void {
        self.elegantIdle.leftHand.set(lx, ly, lz)
        self.elegantIdle.rightHand.set(rx, ry, rz)
      },
      /** 调参：肘极点偏移（模型空间，相对肩部：x=外侧幅度，y=向下，z=向前）。 */
      setIkPoles (x: number, y: number, z: number): void {
        self.elegantIdle.poleOffset.set(x, y, z)
      }
    }
  }

  /** 加载 PMX 模型与可选表情 VMD；重复调用即切换模型。 */
  async loadModel (modelUrl: string, expressionUrl?: string): Promise<void> {
    // 加载序号守卫：快速连续加载时，先发起的请求后返回会导致旧网格
    // 叠在新模型之上（表现为「两个模型」），过期加载直接作废
    const seq = ++this.loadSeq
    this.options.onStatus?.('loading')
    await this.ensureEngine()
    const scene = this.scene
    if (scene === null) return

    this.clearModel()

    if (!loadersRegistered) {
      RegisterMmdModelLoaders()
      loadersRegistered = true
    }
    const result = await ImportMeshAsync(modelUrl, scene, {
      pluginExtension: '.pmx',
      name: 'model.pmx',
      pluginOptions: {
        mmdmodel: {
          materialBuilder: new PBRMaterialBuilder(),
          // SDEF 球形变形参数是模型原始单位，骨骼整体缩放后失配会
          // 把顶点压碎；BDEF 是尺度不变的，牺牲少量肩肘形变质量
          useSdef: false,
          buildMorph: true,
          buildSkeleton: true
        }
      }
    })
    if (seq !== this.loadSeq) {
      for (const mesh of result.meshes) mesh.dispose(false, true)
      return
    }
    const meshes = result.meshes.filter(m => m instanceof Mesh)
    const root = meshes.find(m => m.getTotalVertices() > 0)
    if (root === undefined || meshes.length === 0) {
      this.options.onStatus?.('error')
      throw new Error('PMX 加载失败：未找到网格')
    }
    this.meshes = meshes
    this.mesh = root
    for (const mesh of meshes) {
      this.shadowGen?.addShadowCaster(mesh, true)
    }

    // babylon-mmd 使用 PMX 原始坐标，模型正面朝 -Z，相机在 +Z，
    // 根骨骼必须转 180°；Babylon 的 Bone 继承 Node 而非
    // TransformNode，直接赋 rotation 是惰性的、不会触发矩阵更新，
    // 必须用 setRotation。

    // 高度归一化 + 脚底贴地：网格顶点缓冲在加载时已被蒙皮成
    // 「绑定空间」（骨骼静止姿态，脚底≈0、自然尺寸），渲染时着色器
    // 再把骨骼世界矩阵乘上去——根骨骼的缩放/旋转/平移恰好作用
    // 一次于渲染结果（不再走 CPU 蒙皮，否则双重应用会缩到一半）。
    // 因此以顶点缓冲实测高度为基准；缩放/旋转/平移全部只作用于
    // 根骨骼（局部变换沿骨骼链逐级相乘，若对每根骨骼 setScale
    // 会按深度累积导致深层骨骼塌缩成点）；根骨骼可能不止一根
    // （「操作中心」与「全ての親」并存），必须全部处理。
    const info = this.measureBuffer()
    const skeletonScale = info.height > 0 ? TARGET_MODEL_HEIGHT / info.height : 1
    this.baseY = -info.minY * skeletonScale
    this.centerY = info.centerY * skeletonScale + this.baseY
    const skeleton1 = root.skeleton
    if (skeleton1 !== null) {
      const s = new Vector3(skeletonScale, skeletonScale, skeletonScale)
      for (const bone of skeleton1.bones) {
        if (bone.getParent() !== null) continue
        bone.setScale(s)
        bone.setRotation(new Vector3(0, Math.PI + this.userYaw, 0))
        bone.setPosition(new Vector3(0, this.baseY, 0))
      }
    }

    // morph 名称索引
    this.morphManager = root.morphTargetManager ?? null
    const morphNames = new Set<string>()
    if (this.morphManager !== null) {
      for (let i = 0; i < this.morphManager.numTargets; i++) {
        const target = this.morphManager.getTarget(i)
        if (target !== null) morphNames.add(target.name)
      }
    }
    this.mouthMorphs = MOUTH_CANDIDATES.filter(name => morphNames.has(name))
    this.blinkMorph = BLINK_CANDIDATES.find(name => morphNames.has(name))
    this.smileMorph = SMILE_CANDIDATES.find(name => morphNames.has(name))
    this.gesture = null

    // 骨骼与姿态
    this.bodyBones.clear()
    const skeleton = root.skeleton
    if (skeleton !== null) {
      // TwoBoneIK 骨骼链（腕→ひじ→手首）；链完整则手/臂交给 ElegantIdle 接管
      const find = (name: string): Bone | undefined => skeleton.bones.find(b => b.name === name)
      const upperL = find('左腕')
      const lowerL = find('左ひじ')
      const wristL = find('左手首')
      const upperR = find('右腕')
      const lowerR = find('右ひじ')
      const wristR = find('右手首')
      this.ikActive = upperL !== undefined && lowerL !== undefined && wristL !== undefined &&
        upperR !== undefined && lowerR !== undefined && wristR !== undefined
      this.elegantIdle.detach()
      if (this.ikActive) {
        this.elegantIdle.attach(root, upperL!, lowerL!, wristL!, upperR!, lowerR!, wristR!)
      }

      for (const name of BODY_BONE_CANDIDATES) {
        const bone = skeleton.bones.find(b => b.name === name)
        if (bone === undefined) continue
        const base = bone.getRotation()
        // 偏移优先级：手腕自然姿态 / 重心偏侧（始终生效）；
        // 手臂兜底仅在 IK 不可用时生效（IK 生效时 腕/肘 由 IK 每帧覆盖）。
        const offset = WRIST_POSE[name] ?? GRAVITY_SHIFT[name]
        const fallback = this.ikActive ? undefined : ARM_FALLBACK_OFFSETS[name]
        if (fallback !== undefined) {
          base.x += fallback.x ?? 0
          base.z += fallback.z ?? 0
        }
        if (offset !== undefined) {
          base.z += offset.z ?? 0
        }
        bone.setRotation(base)
        this.bodyBones.set(name, { bone, base })
      }

      // NaturalHandPose：手指轻微弯曲（近端 → 远端递增，形成自然弧线）
      for (const bone of skeleton.bones) {
        const match = FINGER_NAME_RE.exec(bone.name)
        if (match === null) continue
        const segment = Math.max(0, Number(match[3]) - 1)
        const curve = FINGER_CURVATURE[Math.min(FINGER_CURVATURE.length - 1, segment)] ?? 0
        const rot = bone.getRotation()
        rot.x += curve
        bone.setRotation(rot)
      }
    }

    // 地面阴影接收（ShadowOnly 材质，透明画布只显示影子）
    if (this.ground === null) {
      this.ground = MeshBuilder.CreateDisc('companion-ground', { radius: 8 }, scene)
      this.ground.rotation.x = Math.PI / 2
      this.ground.material = new ShadowOnlyMaterial('companion-shadow', scene)
      this.ground.receiveShadows = true
    }
    this.ground.position.y = 0.02

    // 表情 VMD（仅 morph 轨道；自解析，兼容未知 morph 名）
    if (expressionUrl !== undefined) {
      this.vmdMorphs = await this.loadVmdMorphs(expressionUrl, morphNames)
      if (seq !== this.loadSeq) return
    }

    // 相机满框取景（高度填满画布）+ 用户旋转状态
    const halfFov = 30 * Math.PI / 360
    this.fitDistance = (TARGET_MODEL_HEIGHT / 2 / Math.tan(halfFov)) * 1.02
    this.applyUserTransform()
    this.resize()
    this.start()
    this.options.onStatus?.('ready')
  }

  /**
   * 拖拽旋转模型：水平拖动 = 偏航（模型绕 Y 轴自转，叠加在正面
   * 基准之上），垂直拖动 = 相机俯仰轨道（±60° 内）。
   */
  rotateBy (yawDelta: number, pitchDelta: number): void {
    this.userYaw += yawDelta
    this.cameraPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, this.cameraPitch + pitchDelta))
    this.applyUserTransform()
  }

  /** 设置模型绝对偏航（度）：0 = 正面朝向相机。 */
  setYawDegrees (degrees: number): void {
    this.userYaw = (degrees * Math.PI) / 180
    this.applyUserTransform()
  }

  /** 当前偏航角（度，0-360），0 = 正面朝向相机。 */
  getYawDegrees (): number {
    return (((this.userYaw * 180) / Math.PI) % 360 + 360) % 360
  }

  /** 把用户偏航应用到根骨骼、俯仰应用到相机。 */
  private applyUserTransform (): void {
    const skeleton = this.mesh?.skeleton
    if (skeleton !== null && skeleton !== undefined) {
      for (const bone of skeleton.bones) {
        if (bone.getParent() === null) {
          bone.setRotation(new Vector3(0, Math.PI + this.userYaw, 0))
        }
      }
    }
    const camera = this.scene?.activeCamera
    if (camera instanceof UniversalCamera) {
      const pitch = this.cameraPitch
      camera.position.set(0, this.centerY + Math.sin(pitch) * this.fitDistance, Math.cos(pitch) * this.fitDistance)
      camera.setTarget(new Vector3(0, this.centerY, 0))
    }
  }

  setSpeaking (speaking: boolean): void {
    this.speaking = speaking
    if (!speaking) {
      for (const name of this.mouthMorphs) this.setMorph(name, 0)
    }
  }

  setThinking (thinking: boolean): void {
    this.thinking = thinking
  }

  setLookTarget (x: number, y: number): void {
    this.lookTarget = {
      x: Math.min(1, Math.max(-1, x)),
      y: Math.min(1, Math.max(-1, y))
    }
  }

  setBrightness (brightness: number): void {
    const scene = this.scene
    if (scene === null) return
    scene.imageProcessingConfiguration.exposure = brightness
  }

  setFaceLight (intensity: number): void {
    if (this.faceLight !== null) this.faceLight.intensity = Math.min(2, Math.max(0, intensity))
  }

  setSpeechLevel (level: number): void {
    this.speechLevel = Math.min(1, Math.max(0, level))
  }

  playGesture (name: GestureName): void {
    this.gesture = { name, startAt: performance.now() }
  }

  /** 启动渲染循环；引擎懒初始化（loadModel 内），可在加载完成后再次调用。 */
  start (): void {
    if (this.engine === null || this.scene === null || this.renderLoopStarted) return
    this.renderLoopStarted = true
    this.engine.runRenderLoop(() => {
      if (this.disposed) return
      const now = performance.now()
      const delta = Math.min(0.05, (now - this.lastTime) / 1_000)
      this.lastTime = now
      this.update(delta, now)
      this.scene?.render()
    })
  }

  resize (): void {
    const parent = this.canvas.parentElement
    const width = Math.max(1, parent?.clientWidth ?? this.canvas.clientWidth)
    const height = Math.max(1, parent?.clientHeight ?? this.canvas.clientHeight)
    this.engine?.setSize(width, height)
    const camera = this.scene?.activeCamera
    if (camera instanceof UniversalCamera) {
      camera.fov = (30 * Math.PI) / 180
    }
  }

  dispose (): void {
    if (this.disposed) return
    this.disposed = true
    this.renderLoopStarted = false
    this.clearModel()
    this.engine?.dispose()
    this.engine = null
    this.scene = null
  }

  /** 初始化 WebGPU 引擎（失败回退 WebGL2），搭建场景、灯光、HDR 环境与后处理。 */
  private async ensureEngine (): Promise<void> {
    if (this.engine !== null) return
    let engine: AbstractEngine
    try {
      const webgpu = new WebGPUEngine(this.canvas, { antialias: true })
      await webgpu.initAsync()
      engine = webgpu
    } catch {
      engine = new Engine(this.canvas, true, { antialias: true })
    }
    this.engine = engine

    const scene = new Scene(engine)
    scene.clearColor = new Color4(0, 0, 0, 0)
    this.scene = scene

    // 相机：UniversalCamera 位置与朝向完全显式（无任何隐式重算），
    // 置于模型正面 +Z、看向模型中心
    const camera = new UniversalCamera('companion-cam', new Vector3(0, this.centerY, 30), scene)
    camera.minZ = 0.1
    camera.maxZ = 200
    camera.fov = (30 * Math.PI) / 180
    scene.activeCamera = camera

    // 灯光：主光 + 面部直射光 + 半球环境
    const key = new DirectionalLight('key', new Vector3(-0.4, -0.8, -0.5), scene)
    key.position = new Vector3(3, 8, 5)
    key.intensity = 0.6
    const face = new DirectionalLight('face', new Vector3(0, -0.2, -1), scene)
    face.position = new Vector3(0, 3, 8)
    face.intensity = 0.85
    this.faceLight = face
    new HemisphericLight('hemi', new Vector3(0.4, 1, 0.3), scene).intensity = 0.35

    // 阴影：主光投影（模型加载后注册投影体）
    const shadowGen = new ShadowGenerator(1024, key)
    shadowGen.useBlurExponentialShadowMap = true
    shadowGen.blurKernel = 16
    shadowGen.setDarkness(0.4)
    this.shadowGen = shadowGen

    // HDR 环境光 / IBL：程序化渐变天空等距柱状贴图
    const envSize = 256
    const envData = new Float32Array(envSize * envSize * 4)
    for (let y = 0; y < envSize; y++) {
      const v = y / (envSize - 1)
      for (let x = 0; x < envSize; x++) {
        const u = x / (envSize - 1)
        const i = (y * envSize + x) * 4
        // 顶部暖白天空 → 底部冷灰，右侧偏暖模拟窗口光
        const sky = 0.35 + v * 0.75 + (u > 0.5 ? 0.15 : 0)
        const warm = 0.9 + v * 0.1
        envData[i] = sky * warm
        envData[i + 1] = sky
        envData[i + 2] = sky * (0.92 + v * 0.08)
        envData[i + 3] = 1
      }
    }
    const envTexture = RawTexture.CreateRGBATexture(
      envData, envSize, envSize, scene, false, false,
      Texture.BILINEAR_SAMPLINGMODE, Engine.TEXTURETYPE_FLOAT
    )
    scene.environmentTexture = envTexture
    scene.environmentIntensity = 0.5

    // 后处理：FXAA + Bloom + ACES 色调映射
    scene.imageProcessingConfiguration.toneMappingEnabled = true
    const pipeline = new DefaultRenderingPipeline('pipeline', true, scene)
    pipeline.fxaaEnabled = true
    pipeline.bloomEnabled = true
    pipeline.bloomThreshold = 0.85
    pipeline.bloomWeight = 0.25
  }

  private clearModel (): void {
    this.vmdMorphs = []
    this.elegantIdle.detach()
    this.ikActive = false
    this.bodyBones.clear()
    this.mouthMorphs = []
    this.blinkMorph = undefined
    this.smileMorph = undefined
    for (const mesh of this.meshes) {
      mesh.dispose(false, true)
    }
    this.meshes = []
    this.mesh = null
  }

  /** 读取顶点缓冲（加载后即绑定空间）的 Y 范围，作为归一化基准。 */
  private measureBuffer (): { height: number; minY: number; centerY: number } {
    let min = Infinity
    let max = -Infinity
    for (const mesh of this.meshes) {
      const data = mesh.getVerticesData('position')
      if (data === null || data === undefined) continue
      for (let index = 1; index < data.length; index += 3) {
        const y = data[index] ?? 0
        if (y < min) min = y
        if (y > max) max = y
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
      return { height: 0, minY: 0, centerY: 0 }
    }
    return { height: max - min, minY: min, centerY: (min + max) / 2 }
  }

  private setMorph (name: string, weight: number): void {
    const manager = this.morphManager
    if (manager === null) return
    const target = manager.getTargetByName(name)
    if (target !== null) target.influence = weight
  }

  private update (_delta: number, now: number): void {
    if (this.mesh === null) return
    const time = now / 1_000

    // 站稳：不做 mesh 级漂浮摇摆（CPU 蒙皮忽略 mesh 变换），
    // 呼吸/摆动在骨骼层（updateBodyPose）完成。
    this.updateBodyPose(time, now)
    this.applyGesture(now)
    // IK 姿态修正必须最后执行（scene.render() 前）：手势设置的目标
    // 偏移在此刻生效，且 IK 对 腕/ひじ 的覆盖不会被呼吸回写覆盖。
    this.elegantIdle.update(time)
  }

  private updateBodyPose (time: number, now: number): void {
    if (this.bodyBones.size === 0) return
    const intensity = this.speaking ? 1.5 : 1
    const breathe = Math.sin(time * 1.6) * 0.012 * intensity
    const sway = Math.sin(time * 0.7) * 0.008 * intensity
    const headYaw = Math.sin(time * 0.4) * 0.03 * intensity
    // 注意：腕/ひじ 不在此处 —— IK 生效时由 ElegantIdle 每帧接管，
    // 直接写会与 IK 求解打架（表现为手乱颤）。
    const deltas: Record<string, { x?: number; y?: number; z?: number }> = {
      上半身: { x: breathe },
      首: { x: breathe * 0.5 },
      頭: { x: -breathe * 0.5, y: headYaw, z: sway * 0.4 },
      腰: { z: sway }
    }
    for (const [name, delta] of Object.entries(deltas)) {
      const target = this.bodyBones.get(name)
      if (target === undefined) continue
      target.bone.setRotation(new Vector3(
        target.base.x + (delta.x ?? 0),
        target.base.y + (delta.y ?? 0),
        target.base.z + (delta.z ?? 0)
      ))
    }

    // 视线跟随 + 思考表情
    this.currentLook.x += (this.lookTarget.x - this.currentLook.x) * 0.08
    this.currentLook.y += (this.lookTarget.y - this.currentLook.y) * 0.08
    const head = this.bodyBones.get('頭')
    if (head !== undefined) {
      // 模型已整体旋转 180°，视线左右映射取反
      const headRot = head.bone.getRotation()
      headRot.y += -this.currentLook.x * 0.32
      headRot.x += -this.currentLook.y * 0.16
      if (this.thinking) {
        headRot.z += 0.16
        headRot.x += 0.05
      }
      head.bone.setRotation(headRot)
    }

    // 眨眼
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 90
      this.nextBlinkAt = now + 2_500 + (now % 2_500)
    }
    if (this.blinkMorph !== undefined) {
      this.setMorph(this.blinkMorph, now < this.blinkUntil ? 1 : 0)
    }

    // 口型（音量包络）
    if (this.speaking && this.mouthMorphs.length > 0 && now >= this.nextMouthAt) {
      const current = this.mouthMorphs[this.mouthIndex]
      if (current !== undefined) this.setMorph(current, 0)
      this.mouthIndex = (this.mouthIndex + 1) % this.mouthMorphs.length
      const next = this.mouthMorphs[this.mouthIndex]
      if (next !== undefined) this.setMorph(next, 0.3 + this.speechLevel * 0.7)
      this.nextMouthAt = now + 130
    }

    // 表情 VMD morph 插值
    const firstTrack = this.vmdMorphs[0]
    if (firstTrack !== undefined && firstTrack.keys.length > 0) {
      const lastKey = firstTrack.keys[firstTrack.keys.length - 1]
      if (lastKey !== undefined && lastKey.frame > 0) {
        const frame = (time * 30) % lastKey.frame
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

  private applyGesture (now: number): void {
    if (this.gesture === null) return
    const { name, startAt } = this.gesture
    const duration = GESTURE_DURATIONS[name]
    const elapsed = now - startAt
    if (elapsed >= duration) {
      this.gesture = null
      this.elegantIdle.rightArmOffset.set(0, 0, 0)
      return
    }
    const progress = elapsed / duration
    const envelope = Math.sin(Math.PI * progress)
    const time = now / 1_000

    const addBone = (boneName: string, dx: number, dy: number, dz: number): void => {
      const target = this.bodyBones.get(boneName)
      if (target === undefined) return
      const rot = target.bone.getRotation()
      rot.x += dx
      rot.y += dy
      rot.z += dz
      target.bone.setRotation(rot)
    }

    switch (name) {
      case 'wave': {
        // 右手经 IK 目标偏移抬起挥手（横向摆动叠在 IK 求解前）
        // 目标从「小腹前」抬到面部前：y +5.3 ≈ 头部高度，z 收回到脸前
        const offset = this.elegantIdle.rightArmOffset
        offset.set(Math.sin(time * 18) * 0.7 * envelope, 5.3 * envelope, 0.45 * envelope)
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

  /** 手写 VMD morph 轨道解析（VMD 二进制：morph 段固定 15 字节 Shift-JIS 名）。 */
  private async loadVmdMorphs (url: string, morphNames: Set<string>): Promise<VmdMorphTrack[]> {
    try {
      const response = await fetch(url)
      if (!response.ok) return []
      const buffer = await response.arrayBuffer()
      const view = new DataView(buffer)
      if (view.getUint8(0) !== 0x56 || view.getUint8(1) !== 0x6F) return [] // 'Vo'
      let offset = 50 // 签名 30 字节 + 模型名 20 字节
      const boneCount = view.getUint32(offset, true)
      offset += 4 + boneCount * 111 // 骨骼帧：每帧 15 名 + 16 键 + 80 帧 = 111 字节
      const morphCount = view.getUint32(offset, true)
      offset += 4
      const grouped = new Map<string, Array<{ frame: number; weight: number }>>()
      for (let i = 0; i < morphCount; i++) {
        const nameBytes = new Uint8Array(buffer, offset, 15)
        let end = 0
        while (end < 15 && nameBytes[end] !== 0) end += 1
        const name = new TextDecoder('shift_jis').decode(nameBytes.slice(0, end))
        offset += 15
        const frame = view.getUint32(offset, true)
        offset += 4
        const weight = view.getFloat32(offset, true)
        offset += 4
        if (name === '' || !morphNames.has(name)) continue
        const list = grouped.get(name) ?? []
        list.push({ frame, weight })
        grouped.set(name, list)
      }
      return [...grouped.entries()]
        .map(([name, keys]) => ({ name, keys: keys.sort((a, b) => a.frame - b.frame) }))
        .filter(track => track.keys.length > 0)
    } catch {
      return []
    }
  }
}
