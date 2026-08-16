import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_STYLE_ID,
  getVoiceStyle,
  normalizeVoiceStyle,
  VOICE_STYLES,
  type VoiceStyleId
} from '../shared/voice.ts'

describe('voice style catalog', () => {
  it('exposes the required switchable styles', () => {
    const ids = VOICE_STYLES.map(style => style.id)
    expect(ids).toEqual(expect.arrayContaining(['sweet', 'gentle', 'cute', 'mature', 'elegant', 'lively']))
  })

  it('keeps every style label and Edge TTS tuning usable', () => {
    for (const style of VOICE_STYLES) {
      expect(style.label.trim().length).toBeGreaterThan(0)
      expect(style.edgeVoice).toMatch(/^zh-CN-[A-Za-z]+Neural$/)
      expect(style.edgeRate).toBeGreaterThan(0)
      expect(style.edgePitch).toMatch(/^[+-]\d+Hz$/)
    }
  })
})

describe('normalizeVoiceStyle', () => {
  it('accepts known ids and falls back on invalid or missing values', () => {
    expect(normalizeVoiceStyle('sweet')).toBe('sweet')
    expect(normalizeVoiceStyle(undefined)).toBe(DEFAULT_VOICE_STYLE_ID)
    expect(normalizeVoiceStyle('robotic')).toBe(DEFAULT_VOICE_STYLE_ID)
    expect(normalizeVoiceStyle({})).toBe(DEFAULT_VOICE_STYLE_ID)
  })
})

describe('getVoiceStyle', () => {
  it('returns the matching Edge TTS profile for every known style', () => {
    for (const style of VOICE_STYLES) {
      expect(getVoiceStyle(style.id)).toEqual(style)
    }
  })

  it('falls back to the default profile for unknown ids', () => {
    expect(getVoiceStyle('unknown' as VoiceStyleId)).toBe(getVoiceStyle(DEFAULT_VOICE_STYLE_ID))
  })
})
