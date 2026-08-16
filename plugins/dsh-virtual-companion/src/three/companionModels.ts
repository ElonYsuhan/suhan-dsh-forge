/**
 * Procedural 3D companion models built from Three.js primitives.
 * The virtual companion keeps exactly one model: a refined cartoon fairy girl.
 *
 * Meshes that the scene animates carry a `userData.role` tag:
 *   mouth / eyeL / eyeR / wingL / wingR
 */
import * as THREE from 'three'
import {
  DEFAULT_SKIN_ID,
  getSkinPreset,
  type SkinId,
  type SkinPreset
} from '../shared/settings.ts'

export type CompanionModelKind = 'human'

export const COMPANION_MODELS: readonly { id: CompanionModelKind; label: string }[] = [
  { id: 'human', label: '卡通仙女' }
]

const SKIN_TONE = 0xffe0cd
const SKIN_ROUGH = 0.5
const HAIR_TONE = 0x53334a
const HAIR_ROUGH = 0.45
const IRIS_TONE = 0x7b5aa6
const PUPIL_TONE = 0x241a2e
const MOUTH_TONE = 0xd66a7a
const BOOT_TONE = 0xf5f2ee

function addMesh (
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  role?: string
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(x, y, z)
  if (role !== undefined) mesh.userData.role = role
  parent.add(mesh)
  return mesh
}

function scale (mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh {
  mesh.scale.set(x, y, z)
  return mesh
}

function sphere (radius: number, width = 16, height = 12): THREE.SphereGeometry {
  return new THREE.SphereGeometry(radius, width, height)
}

/** 一侧的眼睛：白色扁球 + 虹膜 + 瞳孔 + 高光，`role` 供眨眼动画缩放。 */
function eye (parent: THREE.Group, x: number, y: number, z: number, role: string): void {
  const white = addMesh(parent, sphere(0.045, 20, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 }), x, y, z, role)
  scale(white, 1, 0.78, 0.38)
  const iris = addMesh(parent, sphere(0.028, 14, 10), new THREE.MeshStandardMaterial({ color: IRIS_TONE, roughness: 0.3 }), x, y, z + 0.012)
  const pupil = addMesh(parent, sphere(0.015, 10, 8), new THREE.MeshStandardMaterial({ color: PUPIL_TONE, roughness: 0.2 }), x, y, z + 0.024)
  addMesh(parent, sphere(0.007, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, emissive: 0xffffff, emissiveIntensity: 0.4 }), x + 0.011, y + 0.013, z + 0.034)
  scale(iris, 1, 0.85, 0.5)
  scale(pupil, 1, 0.9, 0.5)
}

function eyebrow (parent: THREE.Group, x: number, y: number, z: number, tilt: number): void {
  const brow = addMesh(parent, new THREE.BoxGeometry(0.085, 0.013, 0.012), new THREE.MeshStandardMaterial({ color: HAIR_TONE, roughness: 0.5 }), x, y, z)
  brow.rotation.z = tilt
}

function blush (parent: THREE.Group, x: number, y: number, z: number): void {
  const cheek = addMesh(parent, sphere(0.032, 10, 8), new THREE.MeshStandardMaterial({ color: 0xff9e9e, roughness: 0.7, transparent: true, opacity: 0.5 }), x, y, z)
  scale(cheek, 1.25, 0.7, 0.4)
}

/** 一条手臂：上臂 + 袖口 + 小手，整体绕肩部倾斜。 */
function arm (parent: THREE.Group, side: 1 | -1, dressColor: number): void {
  const limb = new THREE.Group()
  limb.position.set(0.185 * side, 0.47, 0)
  limb.rotation.z = -0.32 * side
  const skin = new THREE.MeshStandardMaterial({ color: SKIN_TONE, roughness: SKIN_ROUGH })
  addMesh(limb, new THREE.CylinderGeometry(0.04, 0.048, 0.17, 12), skin, 0, -0.06, 0)
  addMesh(limb, new THREE.CylinderGeometry(0.03, 0.036, 0.15, 10), skin, 0, -0.2, 0)
  addMesh(limb, sphere(0.034, 10, 8), skin, 0, -0.29, 0)
  const sleeve = addMesh(limb, new THREE.CylinderGeometry(0.05, 0.052, 0.07, 12), new THREE.MeshStandardMaterial({ color: dressColor, roughness: 0.6 }), 0, 0.0, 0)
  scale(sleeve, 1, 1.1, 1)
  parent.add(limb)
}

/** 叶形翅膀（ExtrudeGeometry 贝塞尔轮廓），`role` 供扇动动画缩放。 */
function leafWing (parent: THREE.Group, side: 1 | -1, material: THREE.Material): void {
  const shape = new THREE.Shape()
  shape.moveTo(0, 0)
  shape.bezierCurveTo(0.07, 0.10, 0.15, 0.17, 0.22, 0.17)
  shape.bezierCurveTo(0.27, 0.08, 0.17, -0.12, 0, -0.02)
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false })
  const wing = addMesh(parent, geometry, material, 0.24 * side, 0.52, -0.08, side === 1 ? 'wingL' : 'wingR')
  wing.rotation.y = -0.55 * side
  wing.rotation.z = 0.25 * side
  wing.scale.setScalar(1.35)
}

/** 头顶小花发饰：五片花瓣 + 花心。 */
function flowerClip (parent: THREE.Group, accentColor: number): void {
  const petal = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.4 })
  const petals = 5
  for (let index = 0; index < petals; index++) {
    const angle = (index / petals) * Math.PI * 2
    const petalMesh = addMesh(parent, sphere(0.024, 8, 6), petal, -0.13 + Math.cos(angle) * 0.035, 0.79 + Math.sin(angle) * 0.03, 0.12)
    scale(petalMesh, 1.4, 0.6, 0.6)
  }
  addMesh(parent, sphere(0.02, 8, 6), new THREE.MeshStandardMaterial({ color: 0xfff2c8, roughness: 0.35 }), -0.13, 0.79, 0.125)
}

function fairyGirl (skin: SkinPreset): THREE.Group {
  const group = new THREE.Group()
  const skinMaterial = new THREE.MeshStandardMaterial({ color: SKIN_TONE, roughness: SKIN_ROUGH })
  const hairMaterial = new THREE.MeshStandardMaterial({ color: HAIR_TONE, roughness: HAIR_ROUGH })
  const dressMaterial = new THREE.MeshStandardMaterial({
    color: skin.dressColor,
    roughness: 0.6,
    side: THREE.DoubleSide
  })
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: skin.accentColor,
    roughness: 0.45,
    side: THREE.DoubleSide
  })
  const wingMaterial = new THREE.MeshStandardMaterial({
    color: skin.wingColor,
    roughness: 0.3,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide
  })
  const bootMaterial = new THREE.MeshStandardMaterial({ color: BOOT_TONE, roughness: 0.45 })

  // ── 头部：脸、耳 ──────────────────────────────────────────────
  scale(addMesh(group, sphere(0.2, 30, 26), skinMaterial, 0, 0.62, 0), 1, 1.06, 0.92)
  addMesh(group, sphere(0.034, 10, 8), skinMaterial, -0.19, 0.63, 0)
  addMesh(group, sphere(0.034, 10, 8), skinMaterial, 0.19, 0.63, 0)

  // ── 发型：后发 + 长发束 + 鬓发 + 刘海 ──────────────────────────
  scale(addMesh(group, sphere(0.208, 28, 20), hairMaterial, 0, 0.63, -0.05), 1, 1.16, 0.78)
  scale(addMesh(group, sphere(0.19, 24, 16), hairMaterial, 0, 0.28, -0.2), 0.82, 1.5, 0.45)
  const leftLock = addMesh(group, new THREE.CapsuleGeometry(0.034, 0.22, 6, 10), hairMaterial, -0.2, 0.44, 0.04)
  leftLock.rotation.z = 0.32
  const rightLock = addMesh(group, new THREE.CapsuleGeometry(0.034, 0.22, 6, 10), hairMaterial, 0.2, 0.44, 0.04)
  rightLock.rotation.z = -0.32
  for (let index = 0; index < 5; index++) {
    const x = -0.155 + index * 0.078
    const fringe = addMesh(group, sphere(0.052, 12, 8), hairMaterial, x, 0.735, 0.115)
    scale(fringe, 1, 0.62, 0.45)
  }

  // ── 五官 ──────────────────────────────────────────────────────
  eye(group, -0.075, 0.655, 0.172, 'eyeL')
  eye(group, 0.075, 0.655, 0.172, 'eyeR')
  eyebrow(group, -0.075, 0.7, 0.185, 0.12)
  eyebrow(group, 0.075, 0.7, 0.185, -0.12)
  addMesh(group, sphere(0.012, 8, 6), new THREE.MeshStandardMaterial({ color: 0xf5c9b8, roughness: 0.6 }), 0, 0.612, 0.2)
  scale(addMesh(group, sphere(0.022, 12, 8), new THREE.MeshStandardMaterial({ color: MOUTH_TONE, roughness: 0.45 }), 0, 0.568, 0.19, 'mouth'), 1.35, 0.55, 0.4)
  blush(group, -0.135, 0.595, 0.135)
  blush(group, 0.135, 0.595, 0.135)

  // ── 颈与收腰躯干（Lathe 曲线）──────────────────────────────────
  addMesh(group, new THREE.CylinderGeometry(0.042, 0.05, 0.09, 12), skinMaterial, 0, 0.535, 0)
  const bodicePoints = [
    new THREE.Vector2(0.09, 0.52),
    new THREE.Vector2(0.135, 0.46),
    new THREE.Vector2(0.148, 0.42),
    new THREE.Vector2(0.108, 0.375),
    new THREE.Vector2(0.128, 0.32),
    new THREE.Vector2(0.12, 0.26)
  ]
  addMesh(group, new THREE.LatheGeometry(bodicePoints, 26), dressMaterial, 0, 0, 0)

  // ── 手臂 ──────────────────────────────────────────────────────
  arm(group, 1, skin.dressColor)
  arm(group, -1, skin.dressColor)

  // ── 裙装：内裙 + 外裙 + 荷叶边 + 腰带蝴蝶结 ───────────────────
  scale(addMesh(group, new THREE.ConeGeometry(0.3, 0.44, 30), dressMaterial, 0, 0.11, 0), 1.06, 1, 0.95)
  scale(addMesh(group, new THREE.ConeGeometry(0.25, 0.32, 26), accentMaterial, 0, 0.3, 0), 1.12, 1, 0.9)
  const hem = addMesh(group, new THREE.TorusGeometry(0.305, 0.018, 8, 32), accentMaterial, 0, -0.1, 0)
  hem.rotation.x = Math.PI / 2
  const sash = addMesh(group, new THREE.TorusGeometry(0.115, 0.018, 8, 26), accentMaterial, 0, 0.355, 0.02)
  sash.rotation.x = Math.PI / 2
  addMesh(group, sphere(0.034, 8, 6), accentMaterial, -0.09, 0.355, 0.14)
  addMesh(group, sphere(0.034, 8, 6), accentMaterial, 0.09, 0.355, 0.14)
  addMesh(group, sphere(0.026, 8, 6), accentMaterial, 0, 0.355, 0.15)

  // ── 腿与靴 ────────────────────────────────────────────────────
  addMesh(group, new THREE.CylinderGeometry(0.038, 0.032, 0.2, 10), skinMaterial, -0.09, 0.05, 0)
  addMesh(group, new THREE.CylinderGeometry(0.038, 0.032, 0.2, 10), skinMaterial, 0.09, 0.05, 0)
  addMesh(group, new THREE.CylinderGeometry(0.042, 0.046, 0.09, 10), bootMaterial, -0.09, -0.08, 0)
  addMesh(group, new THREE.CylinderGeometry(0.042, 0.046, 0.09, 10), bootMaterial, 0.09, -0.08, 0)
  scale(addMesh(group, sphere(0.05, 10, 8), bootMaterial, -0.13, -0.13, 0.035), 1, 0.7, 1.4)
  scale(addMesh(group, sphere(0.05, 10, 8), bootMaterial, 0.13, -0.13, 0.035), 1, 0.7, 1.4)

  // ── 翅膀与发饰 ────────────────────────────────────────────────
  leafWing(group, 1, wingMaterial)
  leafWing(group, -1, wingMaterial)
  flowerClip(group, skin.accentColor)

  // ── 星光点缀 ──────────────────────────────────────────────────
  const sparkleMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff4d6,
    emissive: 0xffe9a8,
    emissiveIntensity: 0.8,
    roughness: 0.2
  })
  addMesh(group, new THREE.OctahedronGeometry(0.04), sparkleMaterial, -0.3, 0.9, 0.14)
  addMesh(group, new THREE.OctahedronGeometry(0.03), sparkleMaterial, 0.3, 0.82, -0.06)
  addMesh(group, new THREE.OctahedronGeometry(0.026), sparkleMaterial, 0.24, 1.0, 0.12)

  group.scale.setScalar(0.95)
  return group
}

/** Build a fresh model group for the requested companion kind and skin. */
export function createCompanionModel (kind: CompanionModelKind, skinId: SkinId = DEFAULT_SKIN_ID): THREE.Group {
  if (kind === 'human') return fairyGirl(getSkinPreset(skinId))
  return fairyGirl(getSkinPreset(skinId))
}
