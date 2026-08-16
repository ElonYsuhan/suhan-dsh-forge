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
  private mouth: THREE.Mesh | null = null
  private eyes: THREE.Mesh[] = []
  private wings: Array<{ mesh: THREE.Mesh; baseZ: number }> = []
  private nextBlinkAt = performance.now() + 2_000
  private blinkUntil = 0

  constructor (canvas: HTMLCanvasElement, initialModel: CompanionModelKind, initialSkin: SkinId = DEFAULT_SKIN_ID) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    this.camera.position.set(0, 0.26, 3.15)
    this.camera.lookAt(0, 0.1, 0)

    // 柔和三灯布光：天光 + 主光 + 背光勾边，减少平光带来的廉价感
    const ambient = new THREE.AmbientLight(0xffffff, 0.55)
    const hemisphere = new THREE.HemisphereLight(0xfff3e0, 0x9a7bb8, 0.85)
    const key = new THREE.DirectionalLight(0xffffff, 1.9)
    key.position.set(2.2, 2.8, 2.4)
    const rim = new THREE.DirectionalLight(0xffe9c8, 1.3)
    rim.position.set(-2.4, 1.6, -2.2)
    this.scene.add(ambient, hemisphere, key, rim)

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
    this.mouth = null
    this.eyes = []
    this.wings = []
    next.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return
      const role = child.userData.role as unknown
      if (role === 'mouth') this.mouth = child
      if (role === 'eyeL' || role === 'eyeR') this.eyes.push(child)
      if (role === 'wingL' || role === 'wingR') this.wings.push({ mesh: child, baseZ: child.scale.z })
    })
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
    const now = performance.now()
    const time = now / 1_000
    // 待机呼吸浮动 + 轻微侧摆；说话时整体放大、上下轻跃。
    const targetScale = this.speaking ? 1.2 : (this.hovered ? 1.08 : 1)
    this.currentScale += (targetScale - this.currentScale) * 0.08
    const breathe = this.speaking ? 0 : Math.sin(time * 1.6) * 0.012
    this.modelGroup.scale.setScalar(this.currentScale + breathe)
    this.modelGroup.rotation.y = 0
    this.modelGroup.rotation.z = this.speaking ? 0 : Math.sin(time * 1.1) * 0.018
    this.modelGroup.position.y = this.speaking
      ? Math.abs(Math.sin(time * 5)) * 0.08
      : Math.sin(time * 2) * 0.04

    // 眨眼：每 2.5-5 秒一次，约 90ms 快闭快开。
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 90
      this.nextBlinkAt = now + 2_500 + (now % 2_500)
    }
    const blinking = now < this.blinkUntil
    for (const eye of this.eyes) {
      const targetY = blinking ? 0.08 : 0.78
      eye.scale.y += (targetY - eye.scale.y) * 0.6
    }

    // 说话：嘴巴开合；翅膀随说话节奏加快扇动。
    if (this.mouth !== null) {
      const targetMouth = this.speaking ? 0.6 + Math.abs(Math.sin(time * 9)) * 1.1 : 0.55
      this.mouth.scale.y += (targetMouth - this.mouth.scale.y) * 0.5
    }
    const flutter = this.speaking ? Math.sin(time * 11) * 0.4 : Math.sin(time * 4) * 0.18
    for (const wing of this.wings) {
      wing.mesh.scale.z = wing.baseZ * (1 + flutter)
    }
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
