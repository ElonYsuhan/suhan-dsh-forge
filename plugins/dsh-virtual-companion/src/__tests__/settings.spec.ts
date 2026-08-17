import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_TEXT_MAX_LENGTH,
  CHAT_BACKGROUNDS,
  CHAT_BACKGROUND_IDS,
  DEFAULT_BRIGHTNESS,
  DEFAULT_CHAT_BACKGROUND_ID,
  DEFAULT_MODEL_ID,
  DEFAULT_ROLE_ID,
  DEFAULT_SETTINGS,
  DEFAULT_SKIN_ID,
  getChatBackground,
  getRolePreset,
  getRoleSystemPrompt,
  getSkinPreset,
  normalizeBackgroundText,
  normalizeChatBackgroundId,
  normalizeRoleId,
  normalizeSettings,
  normalizeSkinId,
  ROLE_IDS,
  ROLE_PRESETS,
  SKIN_IDS,
  SKIN_PRESETS
} from '../shared/settings.ts'
import { DEFAULT_VOICE_STYLE_ID, VOICE_STYLE_IDS } from '../shared/voice.ts'

describe('character role presets', () => {
  it('exposes switchable role presets with readable labels and prompts', () => {
    expect(ROLE_IDS).toEqual(expect.arrayContaining(['warm', 'elegant', 'energetic', 'cool', 'cute']))
    for (const role of ROLE_PRESETS) {
      expect(role.label.trim().length).toBeGreaterThan(0)
      expect(role.systemPrompt.trim().length).toBeGreaterThan(0)
    }
  })

  it('normalizes unknown roles to the default and resolves prompts', () => {
    expect(normalizeRoleId('cool')).toBe('cool')
    expect(normalizeRoleId('alien')).toBe(DEFAULT_ROLE_ID)
    expect(getRolePreset('elegant').id).toBe('elegant')
    expect(getRoleSystemPrompt('cool')).toContain('高冷')
    expect(getRoleSystemPrompt(undefined)).toContain('贴心')
    expect(getRoleSystemPrompt('warm', '  星光森林  ')).toContain('星光森林')
  })
})

describe('fairy skin presets', () => {
  it('exposes switchable fairy skins with colors and descriptions', () => {
    expect(SKIN_IDS).toEqual(['fairyPink', 'fairyBlue', 'fairyPurple', 'fairyGreen'])
    for (const skin of SKIN_PRESETS) {
      expect(skin.label.trim().length).toBeGreaterThan(0)
      expect(skin.description.trim().length).toBeGreaterThan(0)
      expect(skin.dressColor).toBeGreaterThan(0)
      expect(skin.wingColor).toBeGreaterThan(0)
    }
  })

  it('normalizes unknown skins to the default and resolves presets', () => {
    expect(normalizeSkinId('fairyBlue')).toBe('fairyBlue')
    expect(normalizeSkinId('robot')).toBe(DEFAULT_SKIN_ID)
    expect(getSkinPreset('fairyPurple').id).toBe('fairyPurple')
    expect(getSkinPreset(undefined)).toEqual(getSkinPreset(DEFAULT_SKIN_ID))
  })
})

describe('chat background presets', () => {
  it('exposes every background id and a usable CSS value', () => {
    expect(CHAT_BACKGROUND_IDS).toEqual(['day', 'sunset', 'night', 'forest', 'transparent'])
    for (const item of CHAT_BACKGROUNDS) {
      expect(item.css.length).toBeGreaterThan(0)
      expect(item.textColor).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('falls back to the default background for unknown ids', () => {
    expect(normalizeChatBackgroundId('night')).toBe('night')
    expect(normalizeChatBackgroundId('mosaic')).toBe(DEFAULT_CHAT_BACKGROUND_ID)
    expect(getChatBackground('unknown')).toEqual(getChatBackground(DEFAULT_CHAT_BACKGROUND_ID))
  })
})

describe('companion settings', () => {
  it('normalizes partial or invalid settings to safe defaults', () => {
    const settings = normalizeSettings({
      roleId: 'cool',
      voiceId: 'sweet',
      skinId: 'fairyBlue',
      backgroundText: '  森林   ',
      backgroundId: 'night',
      realtime: false
    })
    expect(settings).toEqual({
      roleId: 'cool',
      voiceId: 'sweet',
      skinId: 'fairyBlue',
      modelId: DEFAULT_MODEL_ID,
      brightness: DEFAULT_BRIGHTNESS,
      backgroundText: '森林',
      backgroundId: 'night',
      realtime: false
    })
  })

  it('fills missing and invalid fields with defaults', () => {
    const settings = normalizeSettings({ roleId: 'alien', realtime: 'yes' })
    expect(settings.roleId).toBe(DEFAULT_ROLE_ID)
    expect(settings.voiceId).toBe(DEFAULT_VOICE_STYLE_ID)
    expect(settings.skinId).toBe(DEFAULT_SKIN_ID)
    expect(settings.backgroundText).toBe('')
    expect(settings.backgroundId).toBe(DEFAULT_CHAT_BACKGROUND_ID)
    expect(settings.realtime).toBe(true)
  })

  it('normalizes and caps user-provided background text', () => {
    expect(normalizeBackgroundText(undefined)).toBe('')
    expect(normalizeBackgroundText('  你好  ')).toBe('你好')
    expect(normalizeBackgroundText('a'.repeat(BACKGROUND_TEXT_MAX_LENGTH + 20)).length).toBe(BACKGROUND_TEXT_MAX_LENGTH)
  })

  it('keeps the default settings in sync with the voice/skin catalogs', () => {
    expect(VOICE_STYLE_IDS).toContain(DEFAULT_SETTINGS.voiceId)
    expect(ROLE_IDS).toContain(DEFAULT_SETTINGS.roleId)
    expect(SKIN_IDS).toContain(DEFAULT_SETTINGS.skinId)
    expect(CHAT_BACKGROUND_IDS).toContain(DEFAULT_SETTINGS.backgroundId)
  })
})
