/**
 * Procedural 3D companion models built from Three.js primitives.
 * The virtual companion keeps exactly one model: a human character.
 */
import * as THREE from 'three'

export type CompanionModelKind = 'human'

export const COMPANION_MODELS: readonly { id: CompanionModelKind; label: string }[] = [
  { id: 'human', label: '人物' }
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

  addMesh(group, new THREE.CylinderGeometry(0.22, 0.26, 0.55, 16), cloth, 0, -0.05)
  const head = addMesh(group, new THREE.SphereGeometry(0.22, 20, 20), skin, 0, 0.42)
  head.position.y = 0.42
  eyes(group, 0.46, 0.17)
  addMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.05), dark, -0.07, 0.38, 0.2)
  addMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.05), dark, 0.07, 0.38, 0.2)

  addMesh(group, new THREE.BoxGeometry(0.09, 0.4, 0.09), cloth, -0.32, 0.05, 0)
  addMesh(group, new THREE.BoxGeometry(0.09, 0.4, 0.09), cloth, 0.32, 0.05, 0)
  addMesh(group, new THREE.BoxGeometry(0.12, 0.34, 0.12), dark, -0.11, -0.44, 0)
  addMesh(group, new THREE.BoxGeometry(0.12, 0.34, 0.12), dark, 0.11, -0.44, 0)

  group.scale.setScalar(0.9)
  return group
}

/** Build a fresh model group for the requested companion kind. */
export function createCompanionModel (kind: CompanionModelKind): THREE.Group {
  if (kind === 'human') return human()
  return human()
}
