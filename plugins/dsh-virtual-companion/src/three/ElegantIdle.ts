/**
 * ElegantIdle —— 角色默认站姿状态（聊天时启用）。
 *
 * 目标姿态（古风女性端庄站立 / 敛手而立）：
 * - 肩放松下沉，大臂自然贴近身体向下，不抬高、不外展、不后伸
 * - 肘轻微弯曲（≈120～140°），位于身体两侧稍前
 * - 前臂自两侧向前、向内收拢，双手在小腹正前方（肚脐下方）轻叠
 * - 右手轻搭左手，高低错位 2～5cm，不机械对称
 * - 手腕自然；手指轻微弯曲（宿主 NaturalHandPose）
 * - 保留轻微呼吸/摆动
 *
 * 结构：Idle 动画 + IK 姿态修正 + Additive 微动作。
 * 本模块用自研 TwoBoneIK（余弦定理闭合解 + 极点约束）每帧求解并写入
 * 腕/ひじ 旋转。不用 Babylon BoneIKController：MMD 骨骼链常含 捩（twist）
 * 骨骼（左腕→左腕捩→左ひじ→左手捩→左手首），控制器以 lower 的父骨骼为
 * 上臂，会取到零长度的捩骨骼，导致手臂塌缩成一点。
 * IK 目标按「姿态空间」矩阵（根骨骼世界矩阵去掉归一化缩放）变换，
 * 目标以归一化模型单位（身高 20、脚底 y=0）表达，跨模型可移植；
 * 模型原地旋转时手臂跟随，不穿模。
 */
import { Bone, Matrix, Mesh, Quaternion, Vector3 } from '@babylonjs/core'

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

export class ElegantIdle {
  /**
   * 手部目标（归一化模型空间：身高 20、脚底 y=0、正面 −z）：
   * 肚脐（≈11.3）下方小腹前，双手轻叠——右手略高略前搭在左手上，
   * 高低错位 ≈2.5cm（0.3 单位），不机械对称。
   * 注：ganyu 上臂 2.67 + 前臂 2.28 ≈ 4.95 单位，此目标肘角 ≈125～135°，
   * 为「手低于肚脐且离体 8cm+」约束下的自然微屈解。
   */
  leftHand = new Vector3(-0.4, 11.1, -1.2)
  rightHand = new Vector3(0.5, 11.4, -1.45)
  /**
   * 肘部极点偏移（世界空间，相对肩部）：x 为「外侧」幅度（符号由肩的
   * 世界 x 自动决定，兼容任意模型的左右约定），y 向下，z 向前
   * （模型正面 +z，正值 = 身体前侧）。
   * 作用：肘落在身体两侧、略向前，大臂自然下垂不后伸。
   */
  poleOffset = new Vector3(2.5, -2.5, 0.5)
  /** 瞬态手势对右手的偏移（wave 等），无手势时为零向量。 */
  rightArmOffset = Vector3.Zero()

  private mesh: Mesh | null = null
  private left: ArmChain | null = null
  private right: ArmChain | null = null
  private rootMat: Matrix | null = null

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
  private readonly vScale = Vector3.Zero()
  private readonly vTrans = Vector3.Zero()
  /** 姿态空间矩阵（= 根世界矩阵去掉归一化缩放）与组成分量。 */
  private readonly poseMat = new Matrix()
  private readonly poseQuat = new Quaternion()
  private readonly oneScale = new Vector3(1, 1, 1)

  get active (): boolean {
    return this.mesh !== null && this.left !== null && this.right !== null
  }

  /** 绑定 IK 链：upper = 腕（肩关节），lower = ひじ，末端 = 手首。 */
  attach (mesh: Mesh, upperLeft: Bone, lowerLeft: Bone, wristLeft: Bone, upperRight: Bone, lowerRight: Bone, wristRight: Bone): void {
    this.mesh = mesh
    this.left = { upper: upperLeft, lower: lowerLeft, wrist: wristLeft }
    this.right = { upper: upperRight, lower: lowerRight, wrist: wristRight }
  }

  detach (): void {
    this.left = null
    this.right = null
    this.rootMat = null
    this.mesh = null
    this.rightArmOffset.set(0, 0, 0)
  }

  /** 每帧求解：目标（含微动作/手势偏移）经姿态空间矩阵变换到世界，IK 写入 腕/ひじ。 */
  update (time: number): void {
    if (!this.active) return
    const left = this.left as ArmChain
    const right = this.right as ArmChain
    const rootBone = this.armRoot()
    this.rootMat = rootBone.getWorldMatrix()
    // 姿态空间：目标以归一化模型单位表达，而根骨骼带「身高归一化」缩放
    // （骨架Scale = 20/原始身高，jialuo 仅 0.60）——直接乘根矩阵会把手位
    // 目标按比例错放；去掉缩放，只保留旋转与平移。
    this.rootMat.decompose(this.vScale, this.poseQuat, this.vTrans)
    Matrix.ComposeToRef(this.oneScale, this.poseQuat, this.vTrans, this.poseMat)
    const breathe = Math.sin(time * 1.6) * 0.012
    const sway = Math.sin(time * 0.7) * 0.01

    // 左臂
    this.sA.copyFrom(this.leftHand)
    this.sA.y += breathe
    this.sA.x += sway
    this.solveArm(left, this.sA)

    // 右臂（叠加瞬态手势偏移）
    this.sB.copyFrom(this.rightHand)
    this.sB.addInPlace(this.rightArmOffset)
    this.sB.y += breathe
    this.sB.x -= sway
    this.solveArm(right, this.sB)
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

  /**
   * 解析 TwoBoneIK（肘圆法 + 极点直接定位，单帧闭合解）：
   * 1) 目标方向 + 距离钳制（上限满臂长：手必须到达目标，超限才防过度伸展）
   * 2) 肘位于「以 S、T 为焦点的椭圆轨道」上：轴距 a、圆半径 h
   * 3) 极点：肘取圆上最靠近极点方向的点（直接定位，无 180° 翻转歧义）
   * 4) 以「最短弧 × 当前世界朝向」写回 腕/ひじ 局部四元数（保留扭转）
   */
  private solveArm (arm: ArmChain, targetLocal: Vector3): void {
    const { upper, lower, wrist } = arm
    this.worldPosToRef(upper, this.pS)
    this.worldPosToRef(lower, this.pE)
    this.worldPosToRef(wrist, this.pW)
    const S = this.pS
    const E = this.pE
    const W = this.pW

    if (this.rootMat === null) return
    Vector3.TransformCoordinatesToRef(targetLocal, this.poseMat, this.pT)
    const T = this.pT
    // 极点：相对肩部（世界空间）——外侧（符号取肩的世界 x）、略向下、略向前。
    // 与模型的左右轴约定无关，保证肘落在身体两侧而非身后。
    const side = S.x >= 0 ? 1 : -1
    this.pP.set(S.x + side * this.poleOffset.x, S.y + this.poleOffset.y, S.z + this.poleOffset.z)
    const P = this.pP

    const l1 = Vector3.Distance(S, E)
    const l2 = Vector3.Distance(E, W)
    if (l1 < 1e-3 || l2 < 1e-3) return

    // 1) 目标方向 u 与钳制距离。
    // 上限满臂长：手位目标本身决定肘角（本姿态 ≈125～135° 自然微屈），
    // 只有目标确实超出臂长时才钳制；下限防折叠反关节。
    T.subtractToRef(S, this.sA)
    let d = this.sA.length()
    const maxD = l1 + l2 - 1e-4
    const minD = Math.abs(l1 - l2) + 1e-4
    if (d < minD) d = minD
    else if (d > maxD) d = maxD
    if (d < 1e-4) return
    this.sA.normalize()
    const u = this.sA

    // 2) 肘圆：E0 = S + u·a（肘在轴上的投影点），h = 圆半径（垂距）
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    this.sG.copyFrom(u).scaleInPlace(a).addInPlace(S) // sG = E0
    const h2 = l1 * l1 - a * a
    const h = h2 > 1e-6 ? Math.sqrt(h2) : 0

    // 3) 极点定位：肘 = E0 + h · normalize(P−E0 在 ⊥u 平面的投影)
    P.subtractToRef(S, this.sD)
    const pDot = Vector3.Dot(this.sD, u)
    this.sD.x -= u.x * pDot
    this.sD.y -= u.y * pDot
    this.sD.z -= u.z * pDot
    if (h > 1e-4 && this.sD.lengthSquared() > 1e-8) {
      this.sD.normalize()
      this.sE.copyFrom(this.sD).scaleInPlace(h).addInPlace(this.sG) // 肘
    } else {
      this.sE.copyFrom(this.sG) // 目标与轴共线：肘在轴上
    }
    const elbow = this.sE

    // 4) 肩：最短弧(当前上臂方向 → elbow−S)
    E.subtractToRef(S, this.sB)
    this.sB.normalize()
    elbow.subtractToRef(S, this.sC)
    this.sC.normalize()
    this.applyArmRotation(upper, this.sB, this.sC)

    // 5) 肘：最短弧(当前前臂方向 → T′−elbow)，T′ = S + u·d（钳制后目标点）
    this.sG.copyFrom(u).scaleInPlace(d).addInPlace(S) // sG = T′
    this.sG.subtractToRef(elbow, this.sH)
    if (this.sH.lengthSquared() < 1e-10) return
    this.sH.normalize()
    W.subtractToRef(E, this.sC)
    if (this.sC.lengthSquared() < 1e-10) return
    this.sC.normalize()
    this.applyArmRotation(lower, this.sC, this.sH)
  }

  /** 把骨骼世界朝向沿 arc(from→to) 旋转后写回局部四元数。 */
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
    bone.setRotationQuaternion(this.qF)
  }

  private worldPosToRef (bone: Bone, out: Vector3): void {
    bone.computeWorldMatrix(true)
    out.copyFrom(bone.getWorldMatrix().getTranslation())
  }

  private worldPos (bone: Bone): number[] {
    this.worldPosToRef(bone, this.sA)
    return [Number(this.sA.x.toFixed(2)), Number(this.sA.y.toFixed(2)), Number(this.sA.z.toFixed(2))]
  }

  private worldQuatToRef (bone: Bone, out: Quaternion): void {
    bone.computeWorldMatrix(true)
    bone.getWorldMatrix().decompose(this.vScale, out, this.vTrans)
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
