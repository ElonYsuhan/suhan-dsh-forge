/**
 * Three.js scene lifecycle for the virtual companion.
 * Owns the renderer, animation loop, resize observer, and model disposal.
 */
import * as THREE from 'three'
import { DEFAULT_SKIN_ID, type SkinId } from '../shared/settings.ts'
import { createCompanionModel, type CompanionModelKind } from './companionModels.ts'

/** Managed Three.js scene for one floating companion canvas. */
export class CompanionScene {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly modelGroup: THREE.Group
  private currentModel: THREE.Group | null = null
  private currentSkinId: SkinId = DEFAULT_SKIN_ID
  private resizeObserver: ResizeObserver | null = null
  private rafId = 0
  private lastTime = performance.now()
  private hovered = false
  private speaking = false
  private currentScale = 1
  private disposed = false

  constructor (canvas: HTMLCanvasElement, initialModel: CompanionModelKind, initialSkin: SkinId = DEFAULT_SKIN_ID) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this.camera.position.set(0, 0.2, 3)
    this.camera.lookAt(0, 0, 0)

    const ambient = new THREE.AmbientLight(0xffffff, 1.4)
    const directional = new THREE.DirectionalLight(0xffffff, 2.2)
    directional.position.set(1.5, 2, 2)
    this.scene.add(ambient, directional)

    this.modelGroup = new THREE.Group()
    this.scene.add(this.modelGroup)
    this.setModel(initialModel, initialSkin)
    this.resize()

    const parent = canvas.parentElement
    if (parent !== null) {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(parent)
    }

    this.rafId = requestAnimationFrame(this.tick)
  }

  /** Replace the current model, disposing the previous model resources. */
  setModel (kind: CompanionModelKind, skinId: SkinId = DEFAULT_SKIN_ID): void {
    if (this.currentModel !== null && this.currentSkinId === skinId) return
    if (this.currentModel !== null) {
      this.disposeObject(this.currentModel)
      this.modelGroup.remove(this.currentModel)
    }
    const next = createCompanionModel(kind, skinId)
    this.currentModel = next
    this.currentSkinId = skinId
    this.modelGroup.add(next)
  }

  /** Update hover state used by the animation loop. */
  setHovered (hovered: boolean): void {
    this.hovered = hovered
  }

  /** Update speaking state; the character scales up 1.2x while talking. */
  setSpeaking (speaking: boolean): void {
    this.speaking = speaking
  }

  /** Stop the loop and release GPU resources. Safe to call repeatedly. */
  dispose (): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.currentModel !== null) {
      this.disposeObject(this.currentModel)
      this.currentModel = null
    }
    this.renderer.dispose()
  }

  private readonly tick = (): void => {
    if (this.disposed) return
    const now = performance.now()
    const delta = Math.min(0.05, (now - this.lastTime) / 1_000)
    this.lastTime = now
    this.update(delta)
    this.renderer.render(this.scene, this.camera)
    this.rafId = requestAnimationFrame(this.tick)
  }

  private update (_delta: number): void {
    const time = performance.now() / 1_000
    // Do not keep spinning the character; scale up only while speaking.
    const targetScale = this.speaking ? 1.2 : (this.hovered ? 1.08 : 1)
    this.currentScale += (targetScale - this.currentScale) * 0.08
    this.modelGroup.scale.setScalar(this.currentScale)
    this.modelGroup.rotation.y = 0
    this.modelGroup.position.y = this.speaking
      ? Math.abs(Math.sin(time * 5)) * 0.08
      : Math.sin(time * 2) * 0.04
  }

  private resize (): void {
    const parent = this.canvas.parentElement
    const width = Math.max(1, parent?.clientWidth ?? this.canvas.clientWidth)
    const height = Math.max(1, parent?.clientHeight ?? this.canvas.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private disposeObject (root: THREE.Object3D): void {
    root.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        const material = child.material
        if (Array.isArray(material)) material.forEach(item => item.dispose())
        else material.dispose()
      }
    })
    root.clear()
  }
}
