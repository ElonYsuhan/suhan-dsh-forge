/**
 * VPD（Vocaloid Pose Data）姿势解析。
 *
 * VPD 是 MMD 的姿势文件：每根骨骼存「位置 + 局部旋转四元数（相对父骨骼）」，
 * 与 babylon-mmd 骨骼的局部旋转语义一致，可直接应用。
 * 文件为 Shift-JIS 文本（骨骼名含日文），须按字节解码。
 *
 * 来源：本插件用 Blender mmd_tools 把「放松站姿」导出为 VPD（models/motions/
 * 放松站姿-<id>.vpd），加载模型后应用，实现手臂自然下垂收拢的默认站姿。
 */
import { Quaternion, Vector3 } from '@babylonjs/core'

/** 解析 VPD 字节 → 骨骼名 → 局部旋转四元数。未知骨骼名（如变形名）忽略。 */
export function parseVpdPose (buffer: ArrayBuffer): Map<string, Quaternion> {
  const text = new TextDecoder('shift-jis').decode(buffer)
  // 每骨骼块：BoneN{名字 / trans; / quat;（值为逗号分隔，行尾带 \r\n，
  // 数值 ; 后还有制表符注释 `// trans x,y,z`，须跳过到行尾）
  const block = /Bone\d+\{([^}\r\n]+)\r?\n\s*([^;\n]*);[^\r\n]*\r?\n\s*([^;\n]*);/g
  const bones = new Map<string, Quaternion>()
  let match: RegExpExecArray | null
  while ((match = block.exec(text)) !== null) {
    const name = match[1]?.replace(/\r/g, '').trim() ?? ''
    if (name.length === 0) continue
    const values = (match[3] ?? '').split(',').map(v => Number(v.trim()))
    if (values.length !== 4 || values.some(v => !Number.isFinite(v))) continue
    bones.set(name, new Quaternion(values[0], values[1], values[2], values[3]))
  }
  return bones
}

/**
 * 四元数 → XYZ 顺序欧拉（与 babylon 骨骼 setRotation / FromEulerAngles 同序）。
 * 不能用 Quaternion.toEulerAngles()：那是 ZXY（yaw/pitch/roll）约定，
 * 直接喂给 setRotation 会让手臂整体错转（实测 90° 横摆）。
 */
export function quatToEulerXYZ (q: Quaternion): Vector3 {
  const x = q.x
  const y = q.y
  const z = q.z
  const w = q.w
  return new Vector3(
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  )
}
