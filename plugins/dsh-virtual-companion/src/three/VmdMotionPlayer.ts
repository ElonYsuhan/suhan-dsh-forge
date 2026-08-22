import { Bone, Quaternion, Space, Vector3, type MorphTargetManager, type Scene, type Skeleton } from '@babylonjs/core'
import {
  VmdLoader,
  type MmdAnimation,
  type MmdBoneAnimationTrack,
  type MmdMovableBoneAnimationTrack
} from 'babylon-mmd'

interface BoundBoneTrack {
  bone: Bone
  frames: Uint32Array
  rotations: Float32Array
  positions: Float32Array | undefined
  basePosition: Vector3
  baseRotation: Quaternion
}

interface BoundMorphTrack {
  index: number
  frames: Uint32Array
  weights: Float32Array
  baseWeight: number
}

/** 一条 MMD 脚部 IK 链：大腿→膝盖→足ＩＫ 目标（左足/左ひざ/左足ＩＫ）。 */
interface BoundFootIk {
  upper: Bone
  lower: Bone
  /** 足ＩＫ 骨：VMD 位置轨道驱动其世界位置，即踝关节必须到达的目标。 */
  target: Bone
  /** 髋→膝、膝→踝 世界长度：bind 时实测冻结（旋转不变量，运行期不重测）。 */
  l1: number
  l2: number
}

/**
 * 轻量 VMD 播放器：使用 babylon-mmd 的官方 VMD 解析器，直接驱动当前
 * Skeleton。它不创建第二套 MMD runtime，因而可以与现有 PMX 加载、
 * 归一化和透明伴侣渲染共存；播放期间调用方必须停用程序化姿态/IK。
 */
export class VmdMotionPlayer {
  private readonly scene: Scene
  private skeleton: Skeleton | null = null
  private morphManager: MorphTargetManager | null = null
  private boneTracks: BoundBoneTrack[] = []
  private morphTracks: BoundMorphTrack[] = []
  private frame = 0
  private endFrame = 0
  private playing = false
  private holding = false
  private loop = true
  private loadSeq = 0
  private readonly rotationA = new Quaternion()
  private readonly rotationB = new Quaternion()
  private readonly rotationOut = new Quaternion()
  private footIks: BoundFootIk[] = []
  // 脚部 IK 求解暂存（逐帧求解，避免分配）
  private readonly vS = Vector3.Zero()
  private readonly vK = Vector3.Zero()
  private readonly vT = Vector3.Zero()
  private readonly vE0 = Vector3.Zero()
  private readonly vE = Vector3.Zero()
  private readonly vDir = Vector3.Zero()
  private readonly vA = Vector3.Zero()
  private readonly vB = Vector3.Zero()
  private readonly vN = Vector3.Zero()
  private readonly vCross = Vector3.Zero()
  private readonly vScale = Vector3.Zero()
  private readonly vTrans = Vector3.Zero()
  private readonly qB = new Quaternion()
  private readonly qC = new Quaternion()
  private readonly qD = new Quaternion()
  private readonly qE = new Quaternion()
  private readonly qF = new Quaternion()

  constructor (scene: Scene) {
    this.scene = scene
  }

  get active (): boolean { return this.holding && this.boneTracks.length > 0 }
  get status (): 'stopped' | 'playing' | 'paused' {
    if (!this.holding) return 'stopped'
    return this.playing ? 'playing' : 'paused'
  }
  get loaded (): boolean { return this.boneTracks.length > 0 }
  get currentTime (): number { return this.frame / 30 }
  get duration (): number { return this.endFrame / 30 }

  async load (url: string, skeleton: Skeleton, morphManager: MorphTargetManager | null): Promise<void> {
    const seq = ++this.loadSeq
    this.restoreBasePose()
    this.clearBindings()
    const animation = await new VmdLoader(this.scene).loadAsync('companion-motion', url)
    if (seq !== this.loadSeq) return
    this.bind(animation, skeleton, morphManager)
  }

  play (loop = true): boolean {
    if (!this.loaded) return false
    this.loop = loop
    this.holding = true
    this.playing = true
    return true
  }

  pause (): void { this.playing = false }

  seek (seconds: number): boolean {
    if (!this.loaded) return false
    this.frame = Math.min(this.endFrame, Math.max(0, seconds * 30))
    this.holding = true
    this.playing = false
    for (const track of this.boneTracks) this.applyBoneTrack(track, this.frame)
    for (const track of this.morphTracks) this.applyMorphTrack(track, this.frame)
    this.skeleton?.prepare(true)
    this.solveFootIks()
    this.skeleton?.prepare(true)
    return true
  }

  stop (): void {
    this.playing = false
    this.holding = false
    this.frame = 0
    this.restoreBasePose()
    this.skeleton?.prepare(true)
  }

  dispose (): void {
    this.loadSeq += 1
    this.stop()
    this.clearBindings()
  }

  update (deltaSeconds: number): boolean {
    if (!this.active) return false
    // 暂停时继续独占骨骼，避免程序化待机重新接管并改写暂停帧。
    if (!this.playing) return true
    this.frame += deltaSeconds * 30
    if (this.frame > this.endFrame) {
      if (this.loop && this.endFrame > 0) this.frame %= this.endFrame
      else {
        this.stop()
        return false
      }
    }

    for (const track of this.boneTracks) this.applyBoneTrack(track, this.frame)
    for (const track of this.morphTracks) this.applyMorphTrack(track, this.frame)
    this.skeleton?.prepare(true)
    this.solveFootIks()
    this.skeleton?.prepare(true)
    return true
  }

  private bind (animation: MmdAnimation, skeleton: Skeleton, morphManager: MorphTargetManager | null): void {
    this.skeleton = skeleton
    this.morphManager = morphManager
    const bones = new Map(skeleton.bones.map(bone => [bone.name, bone]))
    const bindBone = (track: MmdBoneAnimationTrack | MmdMovableBoneAnimationTrack, positions?: Float32Array): void => {
      const bone = bones.get(track.name)
      // 根骨骼承载模型归一化、贴地和用户偏航；VMD 的单帧根轨道不能覆盖它。
      if (bone === undefined || bone.getParent() === null || track.frameNumbers.length === 0) return
      const baseRotation = new Quaternion()
      bone.getRotationQuaternionToRef(Space.LOCAL, undefined, baseRotation)
      this.boneTracks.push({
        bone,
        frames: track.frameNumbers,
        rotations: track.rotations,
        positions,
        basePosition: bone.getPosition(Space.LOCAL).clone(),
        baseRotation
      })
    }
    for (const track of animation.boneTracks) bindBone(track)
    for (const track of animation.movableBoneTracks) bindBone(track, track.positions)

    if (morphManager !== null) {
      for (const track of animation.morphTracks) {
        const index = this.findMorphIndex(morphManager, track.name)
        if (index < 0 || track.frameNumbers.length === 0) continue
        const target = morphManager.getTarget(index)
        this.morphTracks.push({
          index,
          frames: track.frameNumbers,
          weights: track.weights,
          baseWeight: target?.influence ?? 0
        })
      }
    }
    this.endFrame = animation.endFrame
    this.bindFootIks(skeleton)
    this.frame = 0
  }

  private applyBoneTrack (track: BoundBoneTrack, frame: number): void {
    const [left, right, weight] = this.sampleIndices(track.frames, frame)
    this.rotationA.set(
      track.rotations[left * 4] ?? 0,
      track.rotations[left * 4 + 1] ?? 0,
      track.rotations[left * 4 + 2] ?? 0,
      track.rotations[left * 4 + 3] ?? 1
    )
    if (left === right) this.rotationOut.copyFrom(this.rotationA)
    else {
      this.rotationB.set(
        track.rotations[right * 4] ?? 0,
        track.rotations[right * 4 + 1] ?? 0,
        track.rotations[right * 4 + 2] ?? 0,
        track.rotations[right * 4 + 3] ?? 1
      )
      Quaternion.SlerpToRef(this.rotationA, this.rotationB, weight, this.rotationOut)
    }
    track.bone.setRotationQuaternion(this.rotationOut)

    const positions = track.positions
    if (positions !== undefined) {
      // 桌面伴侣不是完整舞台：锁定水平位移并限制上下跳动，避免中心/沟槽
      // 轨道把整个人带出窄画布；肢体旋转与节奏仍完整保留。
      const ax = 0
      const ay = positions[left * 3 + 1] ?? 0
      const az = 0
      const bx = 0
      const by = positions[right * 3 + 1] ?? ay
      const bz = 0
      const y = ay + (by - ay) * weight
      track.bone.setPosition(new Vector3(
        track.basePosition.x + ax + (bx - ax) * weight,
        track.basePosition.y + Math.max(-1.5, Math.min(1.5, y)),
        track.basePosition.z + az + (bz - az) * weight
      ))
    }
  }

  private applyMorphTrack (track: BoundMorphTrack, frame: number): void {
    const manager = this.morphManager
    if (manager === null) return
    const [left, right, weight] = this.sampleIndices(track.frames, frame)
    const a = track.weights[left] ?? 0
    const b = track.weights[right] ?? a
    const target = manager.getTarget(track.index)
    if (target !== null) target.influence = a + (b - a) * weight
  }

  private sampleIndices (frames: Uint32Array, frame: number): [number, number, number] {
    if (frames.length <= 1 || frame <= (frames[0] ?? 0)) return [0, 0, 0]
    const last = frames.length - 1
    if (frame >= (frames[last] ?? 0)) return [last, last, 0]
    let low = 0
    let high = last
    while (low + 1 < high) {
      const mid = (low + high) >>> 1
      if ((frames[mid] ?? 0) <= frame) low = mid
      else high = mid
    }
    const start = frames[low] ?? 0
    const end = frames[high] ?? start
    return [low, high, end > start ? (frame - start) / (end - start) : 0]
  }

  private restoreBasePose (): void {
    for (const track of this.boneTracks) {
      track.bone.setPosition(track.basePosition)
      track.bone.setRotationQuaternion(track.baseRotation)
    }
    const manager = this.morphManager
    if (manager !== null) {
      for (const track of this.morphTracks) {
        const target = manager.getTarget(track.index)
        if (target !== null) target.influence = track.baseWeight
      }
    }
  }

  private clearBindings (): void {
    this.skeleton = null
    this.morphManager = null
    this.boneTracks = []
    this.morphTracks = []
    this.frame = 0
    this.endFrame = 0
    this.playing = false
    this.holding = false
    this.footIks = []
  }

  /**
   * 绑定 MMD 脚部 IK 链（大腿→膝盖→足ＩＫ）。VMD 的 足ＩＫ 位置轨道只
   * 移动目标骨，不求解腿链——不写回的话踝关节只跟随大腿/膝的旋转，
   * 脚就「飘」起来。这里检出 足ＩＫ 链并冻结髋→膝、膝→踝世界长度
   * （bind 姿态腿伸直，实测值即刚性段长；旋转不变量，运行期不重测）。
   * 链不连续或长度退化的模型（无 IK 骨等）跳过，退化为纯旋转跟随。
   */
  private bindFootIks (skeleton: Skeleton): void {
    skeleton.prepare(true)
    const bones = new Map(skeleton.bones.map(bone => [bone.name, bone]))
    const chains: ReadonlyArray<[string, string, string]> = [
      ['左足', '左ひざ', '左足ＩＫ'],
      ['右足', '右ひざ', '右足ＩＫ'],
      // 英文别名 PMX（足Ｌ 风格），检出不了就跳过
      ['足Ｌ', '足Ｌひざ', '足ＬＩＫ'],
      ['足Ｒ', '足Ｒひざ', '足ＲＩＫ']
    ]
    for (const [upperName, lowerName, targetName] of chains) {
      const upper = bones.get(upperName)
      const lower = bones.get(lowerName)
      const target = bones.get(targetName)
      if (upper === undefined || lower === undefined || target === undefined) continue
      if (lower.getParent() !== upper) continue
      const l1 = Vector3.Distance(upper.getAbsolutePosition(), lower.getAbsolutePosition())
      const l2 = Vector3.Distance(lower.getAbsolutePosition(), target.getAbsolutePosition())
      if (l1 < 1e-3 || l2 < 1e-3) continue
      this.footIks.push({ upper, lower, target, l1, l2 })
    }
  }

  /** 逐帧解全部脚部 IK：调用方负责在调用前刷新骨架（读世界位置）并在之后再次刷新（写回局部旋转）。 */
  private solveFootIks (): void {
    for (const foot of this.footIks) this.solveFootIk(foot)
  }

  /**
   * 解析两骨 IK（肘圆法闭合解，MMD 风格）：把踝关节（膝下方 l2 处）解到
   * 足ＩＫ 目标的绝对位置，写回 大腿/膝 局部四元数。
   * - 膝极点取「当前膝」在肘圆平面上的投影：跟随 VMD 大腿摆动方向，
   *   帧间连续、无解间翻转；目标穿过髋关节等退化情形回退到轴心解。
   * - 距离钳制到腿长范围：目标够不着时腿完全伸直（与 MMD 一致）。
   * - 写回用「最短弧 × 当前世界朝向」→ 局部（保留 VMD 轨道自带的扭转）。
   */
  private solveFootIk (foot: BoundFootIk): void {
    const { upper, lower, target, l1, l2 } = foot
    const skeleton = upper.getSkeleton()
    // 髋 S、目标 T（世界；足ＩＫ 骨位置已含 VMD 轨道与センター跟随）
    this.vS.copyFrom(upper.getAbsolutePosition())
    this.vT.copyFrom(target.getAbsolutePosition())

    // 1) 目标方向与距离钳制
    this.vT.subtractToRef(this.vS, this.vDir)
    let d = this.vDir.length()
    const maxD = l1 + l2 - 1e-4
    const minD = Math.abs(l1 - l2) + 1e-4
    if (d < minD) d = minD
    else if (d > maxD) d = maxD
    if (d < 1e-4) return
    this.vDir.normalize()
    const u = this.vDir

    // 2) 肘圆：E0 = S + u·a（膝在轴上的投影点），h = 圆半径（垂距）
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    this.vE0.copyFrom(u).scaleInPlace(a).addInPlace(this.vS)
    const h2 = l1 * l1 - a * a
    const h = h2 > 1e-6 ? Math.sqrt(h2) : 0

    let elbow: Vector3
    if (h > 1e-4) {
      // 3) 膝解唯一：当前膝在肘圆平面上的投影方向 × h
      this.vK.copyFrom(lower.getAbsolutePosition()).subtractInPlace(this.vS)
      const pDot = Vector3.Dot(this.vK, u)
      this.vK.x -= u.x * pDot
      this.vK.y -= u.y * pDot
      this.vK.z -= u.z * pDot
      if (this.vK.lengthSquared() > 1e-8) {
        this.vK.normalize().scaleInPlace(h)
        this.vE.copyFrom(this.vE0).addInPlace(this.vK)
        elbow = this.vE
      } else {
        elbow = this.vE0
      }
    } else {
      elbow = this.vE0
    }

    // 4) 大腿：最短弧(髋→膝 → 髋→肘)
    this.vA.copyFrom(lower.getAbsolutePosition()).subtractInPlace(this.vS).normalize()
    this.vB.copyFrom(elbow).subtractInPlace(this.vS).normalize()
    this.applyIkRotation(upper, this.vA, this.vB)
    if (skeleton !== null) skeleton.prepare(true)

    // 5) 小腿：最短弧(膝→踝 → 肘→目标)，踝方向 = 膝骨局部偏移经世界矩阵变换
    this.vK.copyFrom(lower.getAbsolutePosition())
    this.vN.copyFrom(lower.getPosition(Space.LOCAL)).normalize()
    Vector3.TransformNormalToRef(this.vN, lower.getWorldMatrix(), this.vN)
    this.vN.normalize()
    this.vA.copyFrom(this.vT).subtractInPlace(elbow)
    if (this.vA.lengthSquared() < 1e-10) return
    this.vA.normalize()
    this.applyIkRotation(lower, this.vN, this.vA)
  }

  /** 沿 arc(from→to) 旋转骨骼当前世界朝向后写回局部四元数（保留扭转）。 */
  private applyIkRotation (bone: Bone, from: Vector3, to: Vector3): void {
    const parent = bone.getParent()
    this.worldQuatToRef(parent ?? bone, this.qB)
    this.worldQuatToRef(bone, this.qC)
    this.shortestArcToRef(from, to, this.qD)
    // qWorldNew = qD * qC（最短弧叠加在当前朝向上）
    this.qE.copyFrom(this.qD).multiplyInPlace(this.qC)
    // 局部 = 父世界四元数⁻¹ × qWorldNew
    this.qF.copyFrom(this.qB).invertInPlace()
    this.qF.multiplyInPlace(this.qE)
    bone.setRotationQuaternion(this.qF)
  }

  private worldQuatToRef (bone: Bone, out: Quaternion): void {
    bone.getWorldMatrix().decompose(this.vScale, out, this.vTrans)
  }

  /** 最短弧四元数：把 from 方向旋到 to 方向（半角公式，无分配）。 */
  private shortestArcToRef (from: Vector3, to: Vector3, out: Quaternion): void {
    Vector3.CrossToRef(from, to, this.vCross)
    const lenSq = this.vCross.lengthSquared()
    const w = Math.max(-1, Math.min(1, Vector3.Dot(from, to)))
    if (lenSq > 1e-10) {
      this.vCross.normalize()
      const sinHalf = Math.sqrt(0.5 * (1 - w))
      const cosHalf = Math.sqrt(0.5 * (1 + w))
      out.x = this.vCross.x * sinHalf
      out.y = this.vCross.y * sinHalf
      out.z = this.vCross.z * sinHalf
      out.w = cosHalf
    } else if (w < -0.999) {
      // 180°：绕任意垂直于 from 的轴
      this.vCross.set(1, 0, 0)
      if (Math.abs(from.x) > 0.9) this.vCross.set(0, 1, 0)
      Vector3.CrossToRef(from, this.vCross, this.vA)
      this.vA.normalize()
      Quaternion.RotationAxisToRef(this.vA, Math.PI, out)
    } else {
      out.set(0, 0, 0, 1)
    }
  }

  private findMorphIndex (manager: MorphTargetManager, name: string): number {
    for (let index = 0; index < manager.numTargets; index++) {
      if (manager.getTarget(index)?.name === name) return index
    }
    return -1
  }
}
