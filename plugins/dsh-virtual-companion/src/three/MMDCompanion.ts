/**
 * Babylon.js 渲染层：WebGPU（回退 WebGL2）+ babylon-mmd 加载 PMX，
 * PBR 材质 + HDR 环境光/IBL + 阴影 + 后处理（FXAA/Bloom/色调映射）。
 *
 * 动画与行为沿用原实现：待机呼吸、眨眼、说话口型（音量包络）、
 * 表情 VMD、瞬态手势、视线跟随、思考表情、手臂垂落姿态。
 * 模型资产由宿主 /virtual-companion/model/* 提供。
 */
import {
  AbstractEngine,
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
  TransformNode,
  UniversalCamera,
  Vector3,
  WebGPUEngine
} from '@babylonjs/core'
import { ShadowOnlyMaterial } from '@babylonjs/materials'
import { PBRMaterialBuilder, RegisterMmdModelLoaders } from 'babylon-mmd'

export type GestureName = 'wave' | 'nod' | 'shake' | 'tilt' | 'bow' | 'smile'

const TARGET_MODEL_HEIGHT = 20
const MOUTH_CANDIDATES = ['あ', 'い', 'う', 'え', 'お']
const BLINK_CANDIDATES = ['まばたき', 'ウィンク', '笑い']
const SMILE_CANDIDATES = ['笑い', 'にこり', '微笑', '笑顔']
const BODY_BONE_CANDIDATES = ['頭', '首', '上半身', '腰', '左腕', '右腕', '左ひじ', '右ひじ']

/** 手臂自然垂落偏移（经 PMX 骨骼模拟实测）：静止外张 ~54°，内收 1.05 rad；左 -z / 右 +z；-x 前摆。 */
const ARM_POSE_OFFSETS: Record<string, { x?: number; z?: number }> = {
  左腕: { x: -0.08, z: -1.05 },
  右腕: { x: -0.08, z: 1.05 },
  左ひじ: { x: -0.12 },
  右ひじ: { x: -0.12 }
}

const GESTURE_DURATIONS: Record<GestureName, number> = {
  wave: 1_600,
  nod: 900,
  shake: 1_000,
  tilt: 1_400,
  bow: 1_200,
  smile: 2_200
}

interface BoneTarget {
  bone: TransformNode
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
  private baseScale = 1
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

  constructor (canvas: HTMLCanvasElement, options: MMDCompanionOptions = {}) {
    this.canvas = canvas
    this.options = options
  }

  /** 加载 PMX 模型与可选表情 VMD；重复调用即切换模型。 */
  async loadModel (modelUrl: string, expressionUrl?: string): Promise<void> {
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
          useSdef: true,
          buildMorph: true,
          buildSkeleton: true
        }
      }
    })
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

    // babylon-mmd 坐标系下模型面朝 -Z，相机在 +Z 看到的是背面。
    // 蒙皮网格的渲染变换由骨骼决定（转 mesh 无效），因此旋转
    // 骨骼根（bones[0]，通常为 全ての親）180° 使模型面向相机。
    const topBone = root.skeleton?.bones[0] as unknown as TransformNode | undefined
    if (topBone !== undefined) {
      topBone.rotation.y = Math.PI
    }

    // 高度归一化 + 脚底贴地
    const info = this.measureModel()
    if (info.height > 0) {
      root.scaling.scaleInPlace(TARGET_MODEL_HEIGHT / info.height)
      this.baseScale = root.scaling.y
    }
    const after = this.measureModel()
    this.baseY = -after.minY
    root.position.y = this.baseY
    this.centerY = after.centerY

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
      for (const name of BODY_BONE_CANDIDATES) {
        const bone = skeleton.bones.find(b => b.name === name) as unknown as TransformNode | undefined
        if (bone === undefined) continue
        const base = bone.rotation.clone()
        const offset = ARM_POSE_OFFSETS[name]
        if (offset !== undefined) {
          base.x += offset.x ?? 0
          base.z += offset.z ?? 0
        }
        bone.rotation = base
        this.bodyBones.set(name, { bone, base })
      }
    }

    // 地面阴影接收（ShadowOnly 材质，透明画布只显示影子）
    if (this.ground === null) {
      this.ground = MeshBuilder.CreateDisc('companion-ground', { radius: 8 }, scene)
      this.ground.rotation.x = Math.PI / 2
      this.ground.material = new ShadowOnlyMaterial('companion-shadow', scene)
      this.ground.receiveShadows = true
    }
    this.ground.position.y = this.baseY + 0.02

    // 表情 VMD（仅 morph 轨道；自解析，兼容未知 morph 名）
    if (expressionUrl !== undefined) {
      this.vmdMorphs = await this.loadVmdMorphs(expressionUrl, morphNames)
    }

    // 相机满框取景（高度填满画布）
    const halfFov = 30 * Math.PI / 360
    this.fitDistance = after.height / 2 / Math.tan(halfFov) * 1.02
    const camera = scene.activeCamera
    if (camera instanceof UniversalCamera) {
      camera.position.set(0, this.centerY, this.fitDistance)
      camera.setTarget(new Vector3(0, this.centerY, 0))
    }
    this.resize()
    this.start()
    this.options.onStatus?.('ready')
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

  private measureModel (): { height: number; minY: number; centerY: number } {
    const mesh = this.mesh
    if (mesh === null) return { height: 0, minY: 0, centerY: 0 }
    const info = mesh.getBoundingInfo()
    const min = info.boundingBox.minimumWorld
    const max = info.boundingBox.maximumWorld
    return {
      height: max.y - min.y,
      minY: min.y,
      centerY: (min.y + max.y) / 2
    }
  }

  private setMorph (name: string, weight: number): void {
    const manager = this.morphManager
    if (manager === null) return
    const target = manager.getTargetByName(name)
    if (target !== null) target.influence = weight
  }

  private update (_delta: number, now: number): void {
    const mesh = this.mesh
    if (mesh === null) return
    const time = now / 1_000

    // 站稳：轻微呼吸缩放，不做漂浮摇摆
    const breathe = Math.sin(time * 1.6) * 0.003
    mesh.scaling.setAll(this.baseScale * (1 + breathe + (this.speaking ? 0.008 : 0)))
    mesh.position.y = this.baseY

    this.updateBodyPose(time, now)
    this.applyGesture(now)
  }

  private updateBodyPose (time: number, now: number): void {
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

    // 视线跟随 + 思考表情
    this.currentLook.x += (this.lookTarget.x - this.currentLook.x) * 0.08
    this.currentLook.y += (this.lookTarget.y - this.currentLook.y) * 0.08
    const head = this.bodyBones.get('頭')
    if (head !== undefined) {
      // 模型已整体旋转 180°，视线左右映射取反
      head.bone.rotation.y += -this.currentLook.x * 0.32
      head.bone.rotation.x += -this.currentLook.y * 0.16
      if (this.thinking) {
        head.bone.rotation.z += 0.16
        head.bone.rotation.x += 0.05
      }
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
        addBone('右腕', -1.25 * envelope, 0, Math.sin(time * 18) * 0.18 * envelope)
        addBone('右ひじ', -0.45 * envelope, 0, 0)
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
