import { describe, expect, it } from 'vitest'
import { COMPANION_MODELS, createCompanionModel } from '../three/companionModels.ts'
import { SKIN_IDS } from '../shared/settings.ts'

describe('companion procedural models', () => {
  it('keeps only the human fairy model in the companion list', () => {
    expect(COMPANION_MODELS.map(item => item.id)).toEqual(['human'])
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

  it('builds a fairy girl model for every skin preset', () => {
    for (const skinId of SKIN_IDS) {
      const group = createCompanionModel('human', skinId)
      expect(group.children.length, `${skinId} should have meshes`).toBeGreaterThan(0)
      let meshCount = 0
      group.traverse(child => {
        if ((child as { isMesh?: boolean }).isMesh === true) meshCount += 1
      })
      expect(meshCount, `${skinId} should contain at least one mesh`).toBeGreaterThan(0)
    }
  })
})
