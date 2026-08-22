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
  }

  private findMorphIndex (manager: MorphTargetManager, name: string): number {
    for (let index = 0; index < manager.numTargets; index++) {
      if (manager.getTarget(index)?.name === name) return index
    }
    return -1
  }
}
