import { describe, expect, it } from 'vitest'
import { COMPANION_MODELS, createCompanionModel } from '../three/companionModels.ts'

describe('companion procedural models', () => {
  it('provides all model kinds in the switchable list', () => {
    expect(COMPANION_MODELS.map(item => item.id)).toEqual(['human', 'cat', 'robot', 'blob'])
    for (const item of COMPANION_MODELS) {
      expect(item.label.trim().length).toBeGreaterThan(0)
    }
  })

  it('builds a non-empty mesh group for every declared model kind', () => {
    for (const item of COMPANION_MODELS) {
      const group = createCompanionModel(item.id)
      expect(group.children.length, `${item.id} should have meshes`).toBeGreaterThan(0)
      let meshCount = 0
      group.traverse(child => {
        if ((child as { isMesh?: boolean }).isMesh === true) meshCount += 1
      })
      expect(meshCount, `${item.id} should contain at least one mesh`).toBeGreaterThan(0)
    }
  })
})
