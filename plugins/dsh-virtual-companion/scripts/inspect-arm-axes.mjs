/**
 * 开发辅助：用 three 的数学精确模拟 MMD 手臂骨骼旋转——
 * 静止四元数为恒等（局部轴=世界轴）、位置为父级相对，
 * 与 MMDLoader 运行时一致。输出「哪个旋转方向把手腕拉向身体」。
 * 用法：node scripts/inspect-arm-axes.mjs [model-id]
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import * as THREE from 'three'
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js'

const modelId = process.argv[2] ?? 'ganyu'
const buf = readFileSync(`${process.env.HOME}/.dsh/storages/dsh-virtual-companion/models/${modelId}/model.pmx`)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const pmx = new MMDParser.Parser().parsePmx(ab, true)

const bones = pmx.bones
const byName = new Map(bones.map((b, i) => [b.name, i]))

const makeBone = (index) => {
  const data = bones[index]
  const bone = new THREE.Bone()
  bone.name = data.name
  // 父级相对位置（与 MMDLoader 一致）
  const parentPos = data.parentIndex >= 0 ? bones[data.parentIndex].position : [0, 0, 0]
  bone.position.set(
    data.position[0] - parentPos[0],
    data.position[1] - parentPos[1],
    data.position[2] - parentPos[2]
  )
  return bone
}
const built = new Map(bones.map((_, i) => [i, makeBone(i)]))
for (const [i, bone] of built) {
  const parent = bones[i].parentIndex >= 0 ? built.get(bones[i].parentIndex) : undefined
  if (parent !== undefined) parent.add(bone)
}
const worldPos = (b) => { b.updateWorldMatrix(true, false); const v = new THREE.Vector3(); b.getWorldPosition(v); return v }

for (const label of ['左腕', '右腕', '左ひじ', '右ひじ']) {
  const bIdx = byName.get(label)
  const wristName = label.includes('左') ? '左手首' : '右手首'
  const wristIdx = byName.get(wristName)
  if (bIdx === undefined || wristIdx === undefined) { console.log(label, '缺骨骼'); continue }
  const bone = built.get(bIdx)
  const wrist = built.get(wristIdx)
  const base = worldPos(wrist)
  bone.rotation.z = 0.2; const plusZ = worldPos(wrist); bone.rotation.z = 0
  bone.rotation.z = -0.2; const minusZ = worldPos(wrist); bone.rotation.z = 0
  bone.rotation.x = 0.2; const plusX = worldPos(wrist); bone.rotation.x = 0
  console.log(label, '| 手首 基准:', base.x.toFixed(2) + ',' + base.y.toFixed(2) + ',' + base.z.toFixed(2),
    '| +z→x:', plusZ.x.toFixed(2), '| -z→x:', minusZ.x.toFixed(2), '| +x→z:', plusX.z.toFixed(2))
}
