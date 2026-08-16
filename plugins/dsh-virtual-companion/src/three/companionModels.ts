/**
 * Procedural 3D companion models built from Three.js primitives.
 * No external model files are loaded.
 */
import * as THREE from 'three'

export type CompanionModelKind = 'human' | 'cat' | 'robot' | 'blob'

export const COMPANION_MODELS: readonly { id: CompanionModelKind; label: string }[] = [
  { id: 'human', label: '人物' },
  { id: 'cat', label: '猫咪' },
  { id: 'robot', label: '机器人' },
  { id: 'blob', label: '方块精灵' }
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

function eyes (parent: THREE.Group, y: number, z: number, color = 0x101418): void {
  const eyeMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.4 })
  const eyeGeometry = new THREE.SphereGeometry(0.05, 12, 12)
  const left = new THREE.Mesh(eyeGeometry, eyeMaterial)
  left.position.set(-0.09, y, z)
  const right = new THREE.Mesh(eyeGeometry, eyeMaterial)
  right.position.set(0.09, y, z)
  parent.add(left, right)
}

function human (): THREE.Group {
  const group = new THREE.Group()
  const skin = new THREE.MeshStandardMaterial({ color: 0xffd5b8, roughness: 0.6 })
  const cloth = new THREE.MeshStandardMaterial({ color: 0x3d7eff, roughness: 0.7 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x26303b, roughness: 0.5 })

  const body = addMesh(group, new THREE.CylinderGeometry(0.22, 0.26, 0.55, 16), cloth, 0, -0.05)
  body.position.y = -0.05
  const head = addMesh(group, new THREE.SphereGeometry(0.22, 20, 20), skin, 0, 0.42)
  head.position.y = 0.42
  eyes(group, 0.46, 0.17)
  addMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.05), dark, -0.07, 0.38, 0.2)
  addMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.05), dark, 0.07, 0.38, 0.2)

  const leftArm = addMesh(group, new THREE.BoxGeometry(0.09, 0.4, 0.09), cloth, -0.32, 0.05)
  leftArm.position.set(-0.32, 0.05, 0)
  const rightArm = addMesh(group, new THREE.BoxGeometry(0.09, 0.4, 0.09), cloth, 0.32, 0.05, 0)
  rightArm.position.set(0.32, 0.05, 0)
  const leftLeg = addMesh(group, new THREE.BoxGeometry(0.12, 0.34, 0.12), dark, -0.11, -0.44)
  leftLeg.position.set(-0.11, -0.44, 0)
  const rightLeg = addMesh(group, new THREE.BoxGeometry(0.12, 0.34, 0.12), dark, 0.11, -0.44, 0)
  rightLeg.position.set(0.11, -0.44, 0)

  group.scale.setScalar(0.9)
  return group
}

function cat (): THREE.Group {
  const group = new THREE.Group()
  const fur = new THREE.MeshStandardMaterial({ color: 0xffa94d, roughness: 0.8 })
  const inner = new THREE.MeshStandardMaterial({ color: 0xffd5b8, roughness: 0.6 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x26303b, roughness: 0.5 })

  const body = addMesh(group, new THREE.SphereGeometry(0.32, 20, 20), fur, 0, -0.08)
  body.scale.set(1.1, 0.85, 0.9)
  const head = addMesh(group, new THREE.SphereGeometry(0.24, 20, 20), fur, 0, 0.28)
  head.position.y = 0.28
  const earLeft = addMesh(group, new THREE.ConeGeometry(0.1, 0.16, 12), fur, -0.16, 0.5)
  earLeft.position.set(-0.16, 0.5, 0)
  const earRight = addMesh(group, new THREE.ConeGeometry(0.1, 0.16, 12), fur, 0.16, 0.5, 0)
  earRight.position.set(0.16, 0.5, 0)
  const earInnerLeft = addMesh(group, new THREE.ConeGeometry(0.05, 0.08, 10), inner, -0.16, 0.48)
  earInnerLeft.position.set(-0.16, 0.48, 0)
  const earInnerRight = addMesh(group, new THREE.ConeGeometry(0.05, 0.08, 10), inner, 0.16, 0.48, 0)
  earInnerRight.position.set(0.16, 0.48, 0)
  eyes(group, 0.3, 0.21)
  addMesh(group, new THREE.SphereGeometry(0.04, 10, 10), dark, 0, 0.22, 0.22)
  const tail = addMesh(group, new THREE.CylinderGeometry(0.04, 0.07, 0.5, 10), fur, 0.4, 0.05, 0)
  tail.rotation.z = -Math.PI / 2.6
  tail.position.set(0.4, 0.05, 0)

  group.scale.setScalar(0.95)
  return group
}

function robot (): THREE.Group {
  const group = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a9bb0, roughness: 0.35, metalness: 0.6 })
  const accent = new THREE.MeshStandardMaterial({ color: 0x2dd4bf, roughness: 0.4, emissive: 0x06211d })
  const dark = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.4 })

  const body = addMesh(group, new THREE.BoxGeometry(0.44, 0.5, 0.28), metal, 0, -0.05)
  body.position.y = -0.05
  const head = addMesh(group, new THREE.BoxGeometry(0.32, 0.3, 0.28), metal, 0, 0.36)
  head.position.y = 0.36
  const eyeLeft = addMesh(group, new THREE.SphereGeometry(0.05, 12, 12), accent, -0.08, 0.39, 0.15)
  eyeLeft.position.set(-0.08, 0.39, 0.15)
  const eyeRight = addMesh(group, new THREE.SphereGeometry(0.05, 12, 12), accent, 0.08, 0.39, 0.15)
  eyeRight.position.set(0.08, 0.39, 0.15)
  const antenna = addMesh(group, new THREE.CylinderGeometry(0.025, 0.025, 0.18, 8), metal, 0, 0.58)
  antenna.position.y = 0.58
  const antennaTip = addMesh(group, new THREE.SphereGeometry(0.05, 10, 10), accent, 0, 0.68)
  antennaTip.position.y = 0.68
  addMesh(group, new THREE.BoxGeometry(0.1, 0.38, 0.1), metal, -0.3, 0.02, 0)
  addMesh(group, new THREE.BoxGeometry(0.1, 0.38, 0.1), metal, 0.3, 0.02, 0)
  addMesh(group, new THREE.BoxGeometry(0.14, 0.28, 0.14), dark, -0.12, -0.42, 0)
  addMesh(group, new THREE.BoxGeometry(0.14, 0.28, 0.14), dark, 0.12, -0.42, 0)

  group.scale.setScalar(0.9)
  return group
}

function blob (): THREE.Group {
  const group = new THREE.Group()
  const goo = new THREE.MeshStandardMaterial({ color: 0x7c6cff, roughness: 0.3, metalness: 0.1 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.4 })

  const body = addMesh(group, new THREE.SphereGeometry(0.34, 24, 24), goo, 0, 0, 0)
  body.scale.set(1, 0.9, 1)
  eyes(group, 0.12, 0.27)
  addMesh(group, new THREE.TorusGeometry(0.06, 0.025, 8, 16), dark, 0, -0.05, 0.3)
  addMesh(group, new THREE.SphereGeometry(0.07, 10, 10), goo, -0.28, -0.2, 0)
  addMesh(group, new THREE.SphereGeometry(0.07, 10, 10), goo, 0.28, -0.2, 0)

  group.scale.setScalar(0.95)
  return group
}

/** Build a fresh model group for the requested companion kind. */
export function createCompanionModel (kind: CompanionModelKind): THREE.Group {
  switch (kind) {
    case 'human':
      return human()
    case 'cat':
      return cat()
    case 'robot':
      return robot()
    case 'blob':
      return blob()
  }
}
