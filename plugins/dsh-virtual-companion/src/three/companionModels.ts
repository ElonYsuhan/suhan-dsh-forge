/**
 * Procedural 3D companion models built from Three.js primitives.
 * The virtual companion keeps exactly one model: a cartoon fairy girl.
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

function addMesh (
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(x, y, z)
  parent.add(mesh)
  return mesh
}

function eyes (parent: THREE.Group, y: number, z: number, color = 0x2a1e17): void {
  const eyeMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.4 })
  const eyeGeometry = new THREE.SphereGeometry(0.045, 12, 12)
  const left = new THREE.Mesh(eyeGeometry, eyeMaterial)
  left.position.set(-0.08, y, z)
  const right = new THREE.Mesh(eyeGeometry, eyeMaterial)
  right.position.set(0.08, y, z)
  parent.add(left, right)
}

function cheeks (parent: THREE.Group, y: number, z: number): void {
  const cheekMaterial = new THREE.MeshStandardMaterial({
    color: 0xff9e9e,
    roughness: 0.7,
    transparent: true,
    opacity: 0.45
  })
  const cheekGeometry = new THREE.SphereGeometry(0.035, 10, 10)
  const left = new THREE.Mesh(cheekGeometry, cheekMaterial)
  left.position.set(-0.13, y, z)
  const right = new THREE.Mesh(cheekGeometry, cheekMaterial)
  right.position.set(0.13, y, z)
  parent.add(left, right)
}

function fairyGirl (skin: SkinPreset): THREE.Group {
  const group = new THREE.Group()
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xffdcc4, roughness: 0.6 })
  const hairMaterial = new THREE.MeshStandardMaterial({ color: 0x5b3a4a, roughness: 0.6 })
  const dressMaterial = new THREE.MeshStandardMaterial({
    color: skin.dressColor,
    roughness: 0.65,
    side: THREE.DoubleSide
  })
  const ribbonMaterial = new THREE.MeshStandardMaterial({
    color: skin.accentColor,
    roughness: 0.5,
    side: THREE.DoubleSide
  })
  const wingMaterial = new THREE.MeshStandardMaterial({
    color: skin.wingColor,
    roughness: 0.35,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide
  })
  const shoeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })

  // Head and hair
  addMesh(group, new THREE.SphereGeometry(0.2, 24, 24), skinMaterial, 0, 0.58, 0)
  const hairBack = addMesh(group, new THREE.SphereGeometry(0.205, 24, 20), hairMaterial, 0, 0.59, -0.045)
  hairBack.scale.set(1, 1.02, 0.78)
  addMesh(group, new THREE.SphereGeometry(0.07, 12, 10), hairMaterial, -0.14, 0.74, 0.03)
  addMesh(group, new THREE.SphereGeometry(0.07, 12, 10), hairMaterial, 0.14, 0.74, 0.03)
  eyes(group, 0.61, 0.165)
  cheeks(group, 0.57, 0.16)

  // Fairy dress (cone-shaped skirt and fitted top)
  const skirt = addMesh(group, new THREE.ConeGeometry(0.3, 0.52, 20), dressMaterial, 0, 0.05, 0)
  skirt.scale.set(1.15, 1, 0.95)
  addMesh(group, new THREE.CylinderGeometry(0.13, 0.17, 0.22, 16), dressMaterial, 0, 0.38, 0)
  addMesh(group, new THREE.TorusGeometry(0.15, 0.025, 8, 20), ribbonMaterial, 0, 0.25, 0.06)
  addMesh(group, new THREE.SphereGeometry(0.03, 8, 8), ribbonMaterial, 0, 0.25, 0.09)

  // Arms
  const leftArm = addMesh(group, new THREE.CylinderGeometry(0.045, 0.055, 0.36, 10), skinMaterial, -0.21, 0.36, 0)
  leftArm.rotation.z = 0.22
  const rightArm = addMesh(group, new THREE.CylinderGeometry(0.045, 0.055, 0.36, 10), skinMaterial, 0.21, 0.36, 0)
  rightArm.rotation.z = -0.22

  // Legs and shoes
  addMesh(group, new THREE.CylinderGeometry(0.055, 0.05, 0.28, 10), skinMaterial, -0.1, -0.22, 0)
  addMesh(group, new THREE.CylinderGeometry(0.055, 0.05, 0.28, 10), skinMaterial, 0.1, -0.22, 0)
  addMesh(group, new THREE.SphereGeometry(0.065, 10, 10), shoeMaterial, -0.11, -0.36, 0.04)
  addMesh(group, new THREE.SphereGeometry(0.065, 10, 10), shoeMaterial, 0.11, -0.36, 0.04)

  // Fairy wings
  const leftWing = addMesh(group, new THREE.SphereGeometry(0.14, 12, 10), wingMaterial, -0.31, 0.45, -0.02)
  leftWing.scale.set(1.1, 0.62, 0.12)
  const rightWing = addMesh(group, new THREE.SphereGeometry(0.14, 12, 10), wingMaterial, 0.31, 0.45, -0.02)
  rightWing.scale.set(1.1, 0.62, 0.12)

  // Sparkle accent
  const sparkleMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff4d6,
    emissive: 0xffe9a8,
    emissiveIntensity: 0.8,
    roughness: 0.2
  })
  addMesh(group, new THREE.OctahedronGeometry(0.045), sparkleMaterial, -0.18, 0.86, 0.16)
  addMesh(group, new THREE.OctahedronGeometry(0.035), sparkleMaterial, 0.22, 0.78, -0.08)

  group.scale.setScalar(0.95)
  return group
}

/** Build a fresh model group for the requested companion kind and skin. */
export function createCompanionModel (kind: CompanionModelKind, skinId: SkinId = DEFAULT_SKIN_ID): THREE.Group {
  if (kind === 'human') return fairyGirl(getSkinPreset(skinId))
  return fairyGirl(getSkinPreset(skinId))
}
