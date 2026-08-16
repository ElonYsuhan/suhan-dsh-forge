import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_STYLE_ID,
  getVoiceStyle,
  normalizeVoiceStyle,
  VOICE_STYLES,
  type VoiceStyleId
} from '../shared/voice.ts'

// 2026-08-16 对 Edge TTS 端点逐名实测可用的 zh-CN 女声；
// 未验证的音色名会导致合成流被服务端关闭（no turn.end），
// 表现为 502 / ERR_EMPTY_RESPONSE。新增音色必须先实测加入此名单。
const VERIFIED_EDGE_VOICES = new Set([
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-XiaobeiNeural',
  'zh-CN-XiaoniNeural',
  'zh-CN-XiaoxuanNeural',
  'zh-CN-YunxiaNeural',
  'zh-CN-YunxiNeural'
])

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

  it('only maps to Edge voices verified against the live endpoint', () => {
    for (const style of VOICE_STYLES) {
      expect(VERIFIED_EDGE_VOICES.has(style.edgeVoice), `${style.id} -> ${style.edgeVoice} 未经实测验证`).toBe(true)
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
