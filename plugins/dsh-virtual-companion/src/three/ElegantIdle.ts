/**
 * ElegantIdle —— 角色默认站姿状态（聊天时启用）。
 *
 * 目标姿态（古风女性端庄站立 / 敛手而立）：
 * - 肩放松下沉，大臂自然贴近身体向下，不抬高、不外展、不后伸
 * - 肘轻微弯曲（≈120～140°），位于身体两侧稍前
 * - 前臂自两侧向前、向内收拢，双手在小腹正前方（肚脐下方）轻叠
 * - 右手轻搭左手，高低错位 2～5cm，不机械对称
 * - 手腕自然；手指轻微弯曲（宿主 NaturalHandPose）
 * - 保留轻微呼吸/摆动（第一阶段已关闭，静态稳定后恢复）
 *
 * 结构：Idle 动画 + IK 姿态修正 + Additive 微动作。
 * 本模块用自研 TwoBoneIK（肘圆法闭合解）每帧求解并写入 腕/ひじ 旋转。
 * 不用 Babylon BoneIKController：MMD 骨骼链常含 捩（twist）骨骼
 * （左腕→左腕捩→左ひじ→左手捩→左手首），控制器以 lower 的父骨骼为
 * 上臂，会取到零长度的捩骨骼，导致手臂塌缩成一点。
 *
 * 稳定性设计（防两个合法肘解之间来回翻转）：
 * - 全部几何在模型空间求解（目标/肩/极点均模型坐标，偏航无关）
 * - 左右臂「外侧」符号在肩数据有效的首帧冻结，运行期绝不动态判断
 * - 每帧算出圆上两个候选肘解，永远选离上一帧肘位置最近的那个
 * - 连续性约束：与上一帧肘方向绕肩夹角 > 30° 时拒绝并保持上一帧
 * - 解析解单帧直接写回，不保留会在相邻帧间反复追赶的旋转残差
 */
import { Bone, Matrix, Mesh, Quaternion, Space, Vector3 } from '@babylonjs/core'

export interface ElegantIdleState {
  leftHand: number[]
  rightHand: number[]
  leftElbow: number[]
  rightElbow: number[]
  leftAngleDeg: number
  rightAngleDeg: number
  active: boolean
}

/** 一条 IK 臂链：上臂（腕/肩关节）→ 前臂（ひじ）→ 手（手首）。 */
interface ArmChain {
  upper: Bone
  lower: Bone
  wrist: Bone
}

/** 连续性约束：新肘解与上一帧肘方向绕肩夹角超过该值则拒绝。 */
const MAX_ELBOW_TURN_DEG = 30

export class ElegantIdle {
  /**
   * 手部目标（归一化模型空间：身高 20、脚底 y=0、正面 −z）：
   * 肚脐下方小腹前，双手轻叠——右手略高略前搭在左手上。
   * 暂不调整：先验证静态稳定，再整体抬高到小腹位置。
   */
  leftHand = new Vector3(-0.4, 11.1, -1.2)
  rightHand = new Vector3(0.5, 11.4, -1.45)
  /**
   * 肘部极点偏移（模型空间，相对肩部）：x 为「外侧」幅度（左右侧符号
   * 在 attach 时固定），y 向下，z 向前（模型正面 −z，正值 = 向前）。
   * 作用：肘落在身体两侧、略向前，大臂自然下垂不后伸。
   */
  poleOffset = new Vector3(2.5, -2.5, 0.5)
  /** 瞬态手势对右手的偏移（wave 等），无手势时为零向量。 */
  rightArmOffset = Vector3.Zero()
  /**
   * 写回平滑系数（0~1）：默认直接写解析解，保证站姿单帧收敛。
   * 仅保留为诊断调参入口；默认姿态不得依赖跨帧追赶，否则骨架矩阵与
   * 渲染帧不同步时会表现为手臂在目标两侧来回抖动。
   */
  smoothing = 1

  private mesh: Mesh | null = null
  private left: ArmChain | null = null
  private right: ArmChain | null = null
  private rootMat: Matrix | null = null
  /** 左右臂「外侧」符号（模型空间肩 x 符号）：肩数据有效的首帧冻结，
   *  此后运行期不变。不能放在 attach：首个 update 前骨骼世界矩阵尚未
   *  初始化（全零），会把两侧都判成 +1。 */
  private sideL: number | null = null
  private sideR: number | null = null
  /** 上一帧肘位置（模型空间），双候选解选择与连续性约束用。 */
  private prevElbowL: Vector3 | null = null
  private prevElbowR: Vector3 | null = null

  // 每帧求解的暂存量（避免分配）：p* 世界点，s* 求解向量，q* 四元数
  private readonly pS = Vector3.Zero()
  private readonly pE = Vector3.Zero()
  private readonly pW = Vector3.Zero()
  private readonly pT = Vector3.Zero()
  private readonly pP = Vector3.Zero()
  private readonly sA = Vector3.Zero()
  private readonly sB = Vector3.Zero()
  private readonly sC = Vector3.Zero()
  private readonly sD = Vector3.Zero()
  private readonly sE = Vector3.Zero()
  private readonly sF = Vector3.Zero()
  private readonly sG = Vector3.Zero()
  private readonly sH = Vector3.Zero()
  private readonly qB = new Quaternion()
  private readonly qC = new Quaternion()
  private readonly qD = new Quaternion()
  private readonly qE = new Quaternion()
  private readonly qF = new Quaternion()
  /** 姿态空间矩阵（= 根世界矩阵去掉归一化缩放）与组成分量。
   *  vScale/vTrans 仅供姿态空间分解使用；worldQuatToRef 用独立的
   *  wScale/wTrans，绝不污染这里（曾因混用导致右臂极点计算错乱、
   *  肘解每帧翻转）。 */
  private readonly poseMat = new Matrix()
  private readonly poseQuat = new Quaternion()
  private readonly oneScale = new Vector3(1, 1, 1)
  private readonly vScale = Vector3.Zero()
  private readonly vTrans = Vector3.Zero()
  private readonly wScale = Vector3.Zero()
  private readonly wTrans = Vector3.Zero()

  get active (): boolean {
    return this.mesh !== null && this.left !== null && this.right !== null
  }

  /** 绑定 IK 链：upper = 腕（肩关节），lower = ひじ，末端 = 手首。
   *  左右臂「外侧」符号在首个有效帧（肩数据非零）冻结，运行期不变。 */
  attach (mesh: Mesh, upperLeft: Bone, lowerLeft: Bone, wristLeft: Bone, upperRight: Bone, lowerRight: Bone, wristRight: Bone): void {
    this.mesh = mesh
    this.left = { upper: upperLeft, lower: lowerLeft, wrist: wristLeft }
    this.right = { upper: upperRight, lower: lowerRight, wrist: wristRight }
    this.sideL = null
    this.sideR = null
    this.prevElbowL = null
    this.prevElbowR = null
  }

  detach (): void {
    this.left = null
    this.right = null
    this.rootMat = null
    this.mesh = null
    this.sideL = null
    this.sideR = null
    this.prevElbowL = null
    this.prevElbowR = null
    this.rightArmOffset.set(0, 0, 0)
  }

  /** 每帧求解：模型空间解出肘位，世界空间写回 腕/ひじ。
   *  _time 保留给呼吸/摆动微动作（第一阶段关闭，静态稳定后恢复）。 */
  update (_time: number): void {
    if (!this.active) return
    const left = this.left as ArmChain
    const right = this.right as ArmChain
    this.armRoot().computeWorldMatrix(true) // 强制刷新，杜绝陈旧根矩阵
    this.rootMat = this.armRoot().getWorldMatrix()
    this.buildPoseMat()
    // 第一阶段：微动作全关（先验证静态姿态稳定，之后再恢复呼吸/摆动）
    const breathe = 0 // Math.sin(time * 1.6) * 0.012
    const sway = 0 // Math.sin(time * 0.7) * 0.01

    // 左臂
    this.sA.copyFrom(this.leftHand)
    this.sA.y += breathe
    this.sA.x += sway
    const resultL = this.solveArm(left, this.sA, this.sideL, this.prevElbowL)
    if (resultL.side !== null) this.sideL = resultL.side
    if (resultL.elbow !== null) {
      this.prevElbowL ??= Vector3.Zero()
      this.prevElbowL.copyFrom(resultL.elbow)
    }

    // 右臂（叠加瞬态手势偏移）
    this.sB.copyFrom(this.rightHand)
    this.sB.addInPlace(this.rightArmOffset)
    this.sB.y += breathe
    this.sB.x -= sway
    const resultR = this.solveArm(right, this.sB, this.sideR, this.prevElbowR)
    if (resultR.side !== null) this.sideR = resultR.side
    if (resultR.elbow !== null) {
      this.prevElbowR ??= Vector3.Zero()
      this.prevElbowR.copyFrom(resultR.elbow)
    }
  }

  /** 验证/诊断：手、肘世界位置 + 肘关节角（度，反关节检查用）。 */
  getState (): ElegantIdleState | null {
    if (!this.active) return null
    const left = this.left as ArmChain
    const right = this.right as ArmChain
    return {
      leftHand: this.worldPos(left.wrist),
      rightHand: this.worldPos(right.wrist),
      leftElbow: this.worldPos(left.lower),
      rightElbow: this.worldPos(right.lower),
      leftAngleDeg: this.elbowAngleDeg(left),
      rightAngleDeg: this.elbowAngleDeg(right),
      active: true
    }
  }

  /** 手臂链最顶端的祖先（全ての親 等，带归一化/旋转的根）。 */
  private armRoot (): Bone {
    let bone = (this.left as ArmChain).upper
    let parent = bone.getParent()
    while (parent !== null) {
      bone = parent
      parent = bone.getParent()
    }
    return bone
  }

  /** 姿态空间矩阵：根世界矩阵去掉归一化缩放，只保留旋转与平移。 */
  private buildPoseMat (): void {
    if (this.rootMat === null) return
    this.rootMat.decompose(this.vScale, this.poseQuat, this.vTrans)
    Matrix.ComposeToRef(this.oneScale, this.poseQuat, this.vTrans, this.poseMat)
  }

  /**
   * 解析 TwoBoneIK（肘圆法，模型空间求解，单帧闭合解）：
   * 1) 目标方向 + 距离钳制（上限满臂长：手必须到达目标，超限才防过度伸展）
   * 2) 肘圆：轴距 a、圆半径 h，圆心 E0
   * 3) 两个候选肘解（圆上相对两点）：永远选离上一帧肘位置最近的；
   *    与上一帧绕肩夹角 > 30° 则拒绝并保持上一帧（防两个解之间翻转）
   * 4) 以「最短弧 × 当前世界朝向」写回 腕/ひじ 局部四元数（保留扭转）
   */
  private solveArm (arm: ArmChain, targetLocal: Vector3, side: number | null, prevElbow: Vector3 | null): { elbow: Vector3 | null; side: number | null } {
    const { upper, lower, wrist } = arm
    this.worldPosToRef(upper, this.pS)
    this.worldPosToRef(lower, this.pE)
    this.worldPosToRef(wrist, this.pW)

    // 模型空间：肩 S、目标 T（targetLocal 即模型空间）、极点 P。
    // 目标必须先复制到独立暂存——targetLocal 可能是 sA/sB，随后会被
    // 肩位覆盖（曾导致 T 被顶掉、解退化成钳制垃圾解）。
    this.pT.copyFrom(targetLocal)
    const T = this.pT
    this.worldToPoseRef(this.pS, this.sA)
    const S = this.sA
    // 「外侧」符号在肩数据有效后的首帧固定，此后每帧沿用。
    // 注意：首个 update 发生在首次渲染前，此时骨骼世界矩阵尚未初始化
    // （全零）——S=(0,0,0) 会把两侧都判成 +1；数据无效时放弃本帧，
    // 下一帧矩阵有效后再冻结。
    if (side === null) {
      if (S.lengthSquared() > 1e-4) side = S.x >= 0 ? 1 : -1
      else return { elbow: null, side: null }
    }
    this.pP.set(S.x + side * this.poleOffset.x, S.y + this.poleOffset.y, S.z - this.poleOffset.z)
    const P = this.pP

    const l1 = Vector3.Distance(this.pS, this.pE)
    const l2 = Vector3.Distance(this.pE, this.pW)
    if (l1 < 1e-3 || l2 < 1e-3) return { elbow: null, side }

    // 1) 目标方向 u 与钳制距离
    T.subtractToRef(S, this.sB)
    let d = this.sB.length()
    const maxD = l1 + l2 - 1e-4
    const minD = Math.abs(l1 - l2) + 1e-4
    if (d < minD) d = minD
    else if (d > maxD) d = maxD
    if (d < 1e-4) return { elbow: null, side }
    this.sB.normalize()
    const u = this.sB

    // 2) 肘圆：E0 = S + u·a（肘在轴上的投影点），h = 圆半径（垂距）
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    this.sC.copyFrom(u).scaleInPlace(a).addInPlace(S) // sC = E0
    const h2 = l1 * l1 - a * a
    const h = h2 > 1e-6 ? Math.sqrt(h2) : 0

    // 3) 两个候选肘解 + 连续性选择
    let elbowModel: Vector3
    if (h > 1e-4) {
      P.subtractToRef(S, this.sD)
      const pDot = Vector3.Dot(this.sD, u)
      this.sD.x -= u.x * pDot
      this.sD.y -= u.y * pDot
      this.sD.z -= u.z * pDot
      if (this.sD.lengthSquared() > 1e-8) {
        this.sD.normalize().scaleInPlace(h) // sD = 垂距向量（候选 A 偏移）
        this.sE.copyFrom(this.sC).addInPlace(this.sD) // 候选 A = E0 + h·dir
        this.sF.copyFrom(this.sC).subtractInPlace(this.sD) // 候选 B = E0 − h·dir
        if (prevElbow !== null) {
          // 永远选离上一帧肘位置最近的候选解
          if (Vector3.Distance(this.sF, prevElbow) < Vector3.Distance(this.sE, prevElbow)) {
            this.sE.copyFrom(this.sF)
          }
          // 连续性约束：与上一帧肘方向绕肩夹角 > 30° 拒绝，保持上一帧
          this.sG.copyFrom(this.sE).subtractInPlace(S)
          this.sH.copyFrom(prevElbow).subtractInPlace(S)
          const gLen = this.sG.length()
          const hLen = this.sH.length()
          if (gLen > 1e-10 && hLen > 1e-10) {
            const cosAng = Vector3.Dot(this.sG, this.sH) / (gLen * hLen)
            const angDeg = Math.acos(Math.max(-1, Math.min(1, cosAng))) * 180 / Math.PI
            if (angDeg > MAX_ELBOW_TURN_DEG) this.sE.copyFrom(prevElbow)
          }
        }
        elbowModel = this.sE
      } else {
        elbowModel = this.sC
      }
    } else {
      elbowModel = this.sC // 目标与轴共线：肘在轴上
    }

    // 肘（模型空间）→ 世界，用于写回
    Vector3.TransformCoordinatesToRef(elbowModel, this.poseMat, this.pT)

    // 4) 肩：最短弧(当前上臂方向 → elbowWorld − S_world)
    // 注意：u 别名 sB，写回向量必须用其他暂存（sD 在候选选择后已空闲），
    // 否则步骤 5 的 T′ = S + u·d 会拿被顶掉的 u 计算（前臂指向垃圾方向）。
    this.pE.subtractToRef(this.pS, this.sD)
    this.sD.normalize()
    this.pT.subtractToRef(this.pS, this.sC)
    this.sC.normalize()
    this.applyArmRotation(upper, this.sD, this.sC)

    // 5) 肘：最短弧(当前前臂方向 → T′_world − elbowWorld)，T′ = S + u·d（钳制后目标点）
    // 上臂刚刚旋转，肘和腕的世界位置已经改变；必须刷新后再取当前前臂
    // 方向。沿用步骤 1 的旧位置会让前臂追逐上一帧几何，浏览器中可见
    // 为手臂在目标两侧反复修正。
    this.worldPosToRef(lower, this.pE)
    this.worldPosToRef(wrist, this.pW)
    this.sG.copyFrom(u).scaleInPlace(d).addInPlace(S) // sG = T′（模型）
    Vector3.TransformCoordinatesToRef(this.sG, this.poseMat, this.sH) // sH = T′（世界）
    this.sH.subtractToRef(this.pT, this.sG) // sG = T′_world − elbowWorld
    if (this.sG.lengthSquared() < 1e-10) return { elbow: elbowModel, side }
    this.sG.normalize()
    this.pW.subtractToRef(this.pE, this.sC) // sC = 当前前臂方向（世界）
    if (this.sC.lengthSquared() < 1e-10) return { elbow: elbowModel, side }
    this.sC.normalize()
    this.applyArmRotation(lower, this.sC, this.sG)
    return { elbow: elbowModel, side }
  }

  /** 把骨骼世界朝向沿 arc(from→to) 旋转后写回局部四元数（带平滑）。 */
  private applyArmRotation (bone: Bone, from: Vector3, to: Vector3): void {
    const parent = bone.getParent()
    this.worldQuatToRef(parent ?? bone, this.qB) // 父世界四元数（无父则用自身）
    this.worldQuatToRef(bone, this.qC) // 当前世界朝向
    this.shortestArcToRef(from, to, this.qD)
    // qWorldNew = qD * qC（最短弧叠加在当前朝向上，保留扭转）
    this.qE.copyFrom(this.qD).multiplyInPlace(this.qC)
    // 局部 = qB⁻¹ * qWorldNew
    this.qF.copyFrom(this.qB).invertInPlace()
    this.qF.multiplyInPlace(this.qE)
    if (this.smoothing < 1) {
      // 当前局部旋转 → 解：slerp（qD 已用完，可作暂存）
      bone.getRotationQuaternionToRef(Space.LOCAL, undefined, this.qD)
      Quaternion.SlerpToRef(this.qD, this.qF, this.smoothing, this.qF)
    }
    bone.setRotationQuaternion(this.qF)
  }

  private worldPosToRef (bone: Bone, out: Vector3): void {
    bone.computeWorldMatrix(true)
    out.copyFrom(bone.getWorldMatrix().getTranslation())
  }

  /** 世界坐标 → 姿态空间（模型空间）：poseMat 无缩放，逆 = 共轭旋转 + 平移回退。 */
  private worldToPoseRef (world: Vector3, out: Vector3): void {
    this.sG.copyFrom(world).subtractInPlace(this.vTrans)
    this.qB.set(-this.poseQuat.x, -this.poseQuat.y, -this.poseQuat.z, this.poseQuat.w)
    this.sG.rotateByQuaternionToRef(this.qB, out)
  }

  private worldPos (bone: Bone): number[] {
    this.worldPosToRef(bone, this.sA)
    return [Number(this.sA.x.toFixed(2)), Number(this.sA.y.toFixed(2)), Number(this.sA.z.toFixed(2))]
  }

  private worldQuatToRef (bone: Bone, out: Quaternion): void {
    bone.computeWorldMatrix(true)
    bone.getWorldMatrix().decompose(this.wScale, out, this.wTrans)
  }

  private elbowAngleDeg (arm: ArmChain): number {
    this.worldPosToRef(arm.lower, this.sA)
    this.worldPosToRef(arm.upper, this.sB)
    this.worldPosToRef(arm.wrist, this.sC)
    this.sB.subtractToRef(this.sA, this.sD)
    this.sC.subtractToRef(this.sA, this.sE)
    const l1 = this.sD.length()
    const l2 = this.sE.length()
    if (l1 < 1e-4 || l2 < 1e-4) return 0
    const dot = Math.max(-1, Math.min(1, Vector3.Dot(this.sD, this.sE) / (l1 * l2)))
    return Number((Math.acos(dot) * 180 / Math.PI).toFixed(1))
  }

  /** 最短弧四元数：把 from 方向旋到 to 方向（半角公式，无分配）。 */
  private shortestArcToRef (from: Vector3, to: Vector3, out: Quaternion): void {
    Vector3.CrossToRef(from, to, this.sF)
    const lenSq = this.sF.lengthSquared()
    const w = Math.max(-1, Math.min(1, Vector3.Dot(from, to)))
    if (lenSq > 1e-10) {
      this.sF.normalize()
      // 半角公式：q = (sin(θ/2)·axis, cos(θ/2))
      const sinHalf = Math.sqrt(0.5 * (1 - w))
      const cosHalf = Math.sqrt(0.5 * (1 + w))
      out.x = this.sF.x * sinHalf
      out.y = this.sF.y * sinHalf
      out.z = this.sF.z * sinHalf
      out.w = cosHalf
    } else if (w < -0.999) {
      // 180°：绕任意垂直于 from 的轴
      this.sF.set(1, 0, 0)
      if (Math.abs(from.x) > 0.9) this.sF.set(0, 1, 0)
      Vector3.CrossToRef(from, this.sF, this.sC)
      this.sC.normalize()
      Quaternion.RotationAxisToRef(this.sC, Math.PI, out)
    } else {
      out.set(0, 0, 0, 1)
    }
  }
}
