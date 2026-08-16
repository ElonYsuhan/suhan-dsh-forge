import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_STYLE_ID,
  normalizeVoiceStyle,
  resolveSpeechConfig,
  VOICE_STYLES,
  type SpeechSynthesisVoiceLike,
  type VoiceStyleId
} from '../client/voice.ts'

const voices: SpeechSynthesisVoiceLike[] = [
  { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN', default: true, localService: true, voiceURI: 'huihui' },
  { name: 'Microsoft Kangkang - Chinese (Simplified, PRC)', lang: 'zh-CN', default: false, localService: true, voiceURI: 'kangkang' },
  { name: 'Microsoft Yaoyao - Chinese (Simplified, PRC)', lang: 'zh-CN', default: false, localService: true, voiceURI: 'yaoyao' },
  { name: 'Google US English', lang: 'en-US', default: false, localService: false, voiceURI: 'google-us' }
]

describe('voice style catalog', () => {
  it('exposes the required switchable styles', () => {
    const ids = VOICE_STYLES.map(style => style.id)
    expect(ids).toEqual(expect.arrayContaining(['natural', 'cool', 'loli', 'mature']))
  })

  it('keeps every style label and tuning value usable', () => {
    for (const style of VOICE_STYLES) {
      expect(style.label.trim().length).toBeGreaterThan(0)
      expect(style.pitch).toBeGreaterThan(0)
      expect(style.rate).toBeGreaterThan(0)
    }
  })
})

describe('normalizeVoiceStyle', () => {
  it('accepts known ids and falls back on invalid or missing values', () => {
    expect(normalizeVoiceStyle('loli')).toBe('loli')
    expect(normalizeVoiceStyle(undefined)).toBe(DEFAULT_VOICE_STYLE_ID)
    expect(normalizeVoiceStyle('robotic')).toBe(DEFAULT_VOICE_STYLE_ID)
    expect(normalizeVoiceStyle({})).toBe(DEFAULT_VOICE_STYLE_ID)
  })
})

describe('resolveSpeechConfig', () => {
  it('prefers a matching Chinese female voice for 萝莉 and raises pitch', () => {
    const config = resolveSpeechConfig('loli', voices)
    expect(config.voice?.name).toContain('Huihui')
    expect(config.lang).toBe('zh-CN')
    expect(config.pitch).toBeGreaterThan(1)
    expect(config.rate).toBeGreaterThan(1)
  })

  it('prefers a matching Chinese male voice for 高冷 and lowers pitch/rate', () => {
    const config = resolveSpeechConfig('cool', voices)
    expect(config.voice?.name).toContain('Kangkang')
    expect(config.pitch).toBeLessThan(1)
    expect(config.rate).toBeLessThan(1)
  })

  it('still applies style tuning when no local voices are available', () => {
    const config = resolveSpeechConfig('deep', [])
    expect(config.voice).toBeNull()
    expect(config.lang).toBe('zh-CN')
    expect(config.pitch).toBeLessThan(0.7)
    expect(config.rate).toBeLessThan(1)
  })

  it('falls back to the default style for unknown ids', () => {
    const config = resolveSpeechConfig('unknown' as VoiceStyleId, voices)
    expect(config.pitch).toBe(1)
    expect(config.rate).toBe(1)
  })
})
