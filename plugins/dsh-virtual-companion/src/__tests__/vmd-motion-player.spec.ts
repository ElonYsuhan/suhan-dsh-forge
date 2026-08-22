import { Bone, Matrix, NullEngine, Quaternion, Scene, Skeleton, Space, Vector3 } from '@babylonjs/core'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

// 真实模型/动作存放在 DSH 本地存储目录（个人版权素材，不入库）；缺失时跳过。
const MOTIONS_ROOT = process.env.HOME + '/.dsh/storages/dsh-virtual-companion/models/'

// babylon-mmd 入口包含浏览器 Worker 辅助模块，Node 测试需先提供全局 self。
;(globalThis as any).self ??= globalThis
;(globalThis as any).addEventListener ??= () => {}
;(globalThis as any).removeEventListener ??= () => {}
;(globalThis as any).postMessage ??= () => {}

describe('VmdMotionPlayer', () => {
  let engine: NullEngine | undefined

  afterEach(() => engine?.dispose())

  async function fixture () {
    const { VmdMotionPlayer } = await import('../three/VmdMotionPlayer')
    engine = new NullEngine()
    const scene = new Scene(engine)
    const skeleton = new Skeleton('test', 'test', scene)
    const root = new Bone('全ての親', skeleton, null, Matrix.Identity())
    const arm = new Bone('左腕', skeleton, root, Matrix.Translation(0, 1, 0))
    const player = new VmdMotionPlayer(scene)
    const animation = {
      boneTracks: [{
        name: '左腕',
        frameNumbers: new Uint32Array([0, 30]),
        rotations: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0])
      }],
      movableBoneTracks: [],
      morphTracks: [],
      endFrame: 30
    }
    ;(player as any).bind(animation, skeleton, null)
    return { player, arm }
  }

  it('播放时插值骨骼，暂停后保持当前帧并继续独占控制', async () => {
    const { player, arm } = await fixture()
    expect(player.play(false)).toBe(true)
    expect(player.update(0.5)).toBe(true)
    const halfway = arm.getRotationQuaternion(Space.LOCAL)
    expect(Math.abs(halfway.z)).toBeCloseTo(Math.SQRT1_2, 4)

    player.pause()
    expect(player.status).toBe('paused')
    expect(player.update(5)).toBe(true)
    expect(arm.getRotationQuaternion(Space.LOCAL).equalsWithEpsilon(halfway, 1e-6)).toBe(true)
  }, 30_000)

  it('单次播放结束后停止并恢复加载前姿态', async () => {
    const { player, arm } = await fixture()
    const base = arm.getRotationQuaternion(Space.LOCAL)
    player.play(false)
    expect(player.update(2)).toBe(false)
    expect(player.status).toBe('stopped')
    expect(player.currentTime).toBe(0)
    expect(Quaternion.AreClose(arm.getRotationQuaternion(Space.LOCAL), base)).toBe(true)
  }, 30_000)
})

// ── MMD 脚部 IK（足ＩＫ 目标追踪）────────────────────────────────────────────

describe('VmdMotionPlayer 脚部 IK', () => {
  let engine: NullEngine | undefined

  afterEach(() => engine?.dispose())

  /** 合成腿骨架：全ての親 → 左足(髋) → 左ひざ(膝) → 左足首(踝)，
   *   左足ＩＫ 挂在根上（bind 位置即踝关节）。髋 y=3，l1=l2=2，踝 y=−1。 */
  async function legFixture () {
    const { VmdMotionPlayer } = await import('../three/VmdMotionPlayer')
    engine = new NullEngine()
    const scene = new Scene(engine)
    const skeleton = new Skeleton('legs', 'legs', scene)
    const root = new Bone('全ての親', skeleton, null, Matrix.Identity())
    const hip = new Bone('左足', skeleton, root, Matrix.Translation(0, 3, 0))
    const knee = new Bone('左ひざ', skeleton, hip, Matrix.Translation(0, -2, 0))
    const ankle = new Bone('左足首', skeleton, knee, Matrix.Translation(0, -2, 0))
    new Bone('左足ＩＫ', skeleton, root, Matrix.Translation(0, -1, 0))
    const player = new VmdMotionPlayer(scene)
    const bind = (anim: any): any => (player as any).bind(anim, skeleton, null)
    return { player, skeleton, bind, hip, knee, ankle }
  }

  function kickAnimation (targetY: number): any {
    // 左足 旋转轨道（60° 外摆）：没有 IK 时脚会随大腿甩出去；
    // 左足ＩＫ 位置轨道：踝目标从 bind（y=−1）抬到 targetY。
    const thighSwing = Float32Array.of(0, 0, 0, 1, 0, 0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6))
    return {
      boneTracks: [{
        name: '左足',
        frameNumbers: new Uint32Array([0, 30]),
        rotations: thighSwing
      }],
      movableBoneTracks: [{
        name: '左足ＩＫ',
        frameNumbers: new Uint32Array([0, 30]),
        rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
        positions: new Float32Array([0, 0, 0, 0, targetY, 0])
      }],
      morphTracks: [],
      endFrame: 30
    }
  }

  it('踝关节吸附到足ＩＫ 目标：大腿旋转甩开也被 IK 拉回', async () => {
    const { player, bind, hip, knee, ankle } = await legFixture()
    bind(kickAnimation(0.5))
    player.play(false)
    const target = ankle.getSkeleton().bones.find(b => b.name === '左足ＩＫ')!
    // 0.1s 步进播放 1 秒：每帧都钉在目标上（无逐帧追赶/摆动）
    for (let step = 0; step < 10; step++) {
      expect(player.update(0.1)).toBe(true)
      expect(Vector3.Distance(ankle.getAbsolutePosition(), target.getAbsolutePosition())).toBeLessThan(1e-3)
    }
    // seek 到踢腿顶点 frame 30：目标抬到最高处仍被精确追踪
    expect(player.seek(1)).toBe(true)
    expect(Vector3.Distance(ankle.getAbsolutePosition(), target.getAbsolutePosition())).toBeLessThan(1e-3)
    // 两段长度保持（未拉伸/未塌缩），膝在极点侧（大腿外摆方向 x>0）
    expect(Vector3.Distance(hip.getAbsolutePosition(), knee.getAbsolutePosition())).toBeCloseTo(2, 3)
    expect(Vector3.Distance(knee.getAbsolutePosition(), ankle.getAbsolutePosition())).toBeCloseTo(2, 3)
    expect(knee.getAbsolutePosition().x).toBeGreaterThan(0.5)
  }, 30_000)

  it('目标超过腿长时腿完全伸直（方向保留）', async () => {
    const { player, bind, hip, ankle } = await legFixture()
    bind(kickAnimation(-1.5)) // 目标 (0, −2.5)：距髋 5.5 > l1+l2=4
    player.play(false)
    expect(player.update(1)).toBe(true)
    const hipPos = hip.getAbsolutePosition()
    expect(Vector3.Distance(hipPos, ankle.getAbsolutePosition())).toBeCloseTo(4, 3)
    expect(Math.abs(ankle.getAbsolutePosition().x)).toBeLessThan(0.02) // 仍指向髋正下方（膝微偏极点侧）
    expect(ankle.getAbsolutePosition().y).toBeCloseTo(-1, 2)
  }, 30_000)

  it('无足ＩＫ 位置轨道时脚保持原地站立（目标 = bind 位置）', async () => {
    const { player, bind, ankle } = await legFixture()
    bind({
      boneTracks: [{
        name: '左足',
        frameNumbers: new Uint32Array([0, 30]),
        rotations: Float32Array.of(0, 0, 0, 1, 0, 0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6))
      }],
      movableBoneTracks: [],
      morphTracks: [],
      endFrame: 30
    })
    player.play(false)
    expect(player.update(1)).toBe(true)
    // 大腿转了 60°，踝仍钉在 bind 位置 (0, −1, 0)
    expect(ankle.getAbsolutePosition().x).toBeLessThan(1e-2)
    expect(ankle.getAbsolutePosition().y).toBeCloseTo(-1, 2)
  }, 30_000)
})

// ── 真实模型 × 真实 VMD 验收（缺失自动跳过）────────────────────────────────

describe.skipIf(!existsSync(MOTIONS_ROOT))('VmdMotionPlayer 真实动作脚部追踪', () => {
  it.each(['yaotounaonao', 'vietnam-drum', 'i-love-you'] as const)('%s：双足踝关节逐帧吸附足ＩＫ 目标', async (motion) => {
    const vmdPath = `${MOTIONS_ROOT}motions/${motion}/motion.vmd`
    if (!existsSync(vmdPath)) return
    const { NullEngine, Scene, Vector3, Mesh, FreeCamera } = await import('@babylonjs/core')
    const { PBRMaterialBuilder, PmxLoader } = await import('babylon-mmd')
    const { VmdMotionPlayer } = await import('../three/VmdMotionPlayer')

    class NoTextureBuilder extends PBRMaterialBuilder {
      async loadDiffuseTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
      async loadSphereTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
      async loadToonTexture (...args: any[]): Promise<void> { args[args.length - 1]?.() }
    }

    const engine = new NullEngine()
    const scene = new Scene(engine)
    const camera = new FreeCamera('cam', new Vector3(0, 10, 30), scene)
    camera.setTarget(Vector3.Zero())
    scene.activeCamera = camera

    // 真实默认模型（红蔷薇·舞者 短裙）
    const buffer = readFileSync(`${MOTIONS_ROOT}hongqiangwei-short/model.pmx`)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    const loader: any = new PmxLoader({ materialBuilder: new NoTextureBuilder(), useSdef: false, buildMorph: true, buildSkeleton: true })
    const loadState: any = await new Promise(resolve => {
      loader.loadFile(scene, new Uint8Array(arrayBuffer), '', (state: any) => resolve(state), undefined, true)
    })
    const result: any = await loader.importMeshAsync('', scene, loadState, '')
    const root = result.meshes.find((m: any) => m instanceof Mesh && m.getTotalVertices() > 0)
    expect(root).toBeDefined()
    const skeleton = root.skeleton as Skeleton
    const bones = new Map(skeleton.bones.map((b: Bone) => [b.name, b]))
    const leftAnkle = bones.get('左足首')
    const rightAnkle = bones.get('右足首')
    expect(leftAnkle).toBeDefined()
    expect(rightAnkle).toBeDefined()

    // 二进制解析真实 VMD（30 字节头 + 20 字节模型名，骨骼帧 111 字节）——
    // VmdLoader 需要 HTTP 拉取，测试直接喂解析结果给 bind。
    const vmdBytes = readFileSync(vmdPath)
    const dv = new DataView(vmdBytes.buffer, vmdBytes.byteOffset, vmdBytes.byteLength)
    const dec = new TextDecoder('shift_jis')
    const rotationTracks = new Map<string, { frames: number[]; rots: number[] }>()
    const positionTracks = new Map<string, { frames: number[]; rots: number[]; pos: number[] }>()
    let o = 50
    const frameCount = dv.getUint32(o, true)
    o += 4
    let endFrame = 0
    for (let i = 0; i < frameCount; i++) {
      const name = dec.decode(vmdBytes.subarray(o, o + 15)).split('\0')[0]
      const frame = dv.getUint32(o + 15, true)
      const pos = [dv.getFloat32(o + 19, true), dv.getFloat32(o + 23, true), dv.getFloat32(o + 27, true)]
      const rot = [dv.getFloat32(o + 31, true), dv.getFloat32(o + 35, true), dv.getFloat32(o + 39, true), dv.getFloat32(o + 43, true)]
      o += 111
      if (frame > endFrame) endFrame = frame
      const hasPos = pos.some(v => Math.abs(v) > 1e-6)
      const map = hasPos ? positionTracks : rotationTracks
      const track = map.get(name) ?? { frames: [] as number[], rots: [] as number[], pos: [] as number[] }
      track.frames.push(frame)
      track.rots.push(...rot)
      if (hasPos) track.pos.push(...pos)
      map.set(name, track)
    }
    const animation = {
      boneTracks: [...rotationTracks].map(([name, t]) => ({
        name,
        frameNumbers: new Uint32Array(t.frames),
        rotations: new Float32Array(t.rots)
      })),
      movableBoneTracks: [...positionTracks].map(([name, t]) => ({
        name,
        frameNumbers: new Uint32Array(t.frames),
        rotations: new Float32Array(t.rots),
        positions: new Float32Array(t.pos)
      })),
      morphTracks: [],
      endFrame
    }

    const player = new VmdMotionPlayer(scene)
    ;(player as any).bind(animation, skeleton, null)
    player.play(false)
    // 播放前 1.5 秒（每 0.1s 一帧）：双足踝关节必须逐帧钉在足ＩＫ 目标上
    for (let s = 0; s < 1.5; s += 0.1) {
      expect(player.update(0.1)).toBe(true)
      const leftIk = bones.get('左足ＩＫ')!
      const rightIk = bones.get('右足ＩＫ')!
      expect(Vector3.Distance(leftAnkle.getAbsolutePosition(), leftIk.getAbsolutePosition())).toBeLessThan(0.05)
      expect(Vector3.Distance(rightAnkle.getAbsolutePosition(), rightIk.getAbsolutePosition())).toBeLessThan(0.05)
    }
    engine.dispose()
  }, 120_000)
})
