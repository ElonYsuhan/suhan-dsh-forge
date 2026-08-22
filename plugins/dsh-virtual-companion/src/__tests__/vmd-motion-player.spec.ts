import { Bone, Matrix, NullEngine, Quaternion, Scene, Skeleton, Space } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'

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
