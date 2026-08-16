/**
 * Speech synthesis voice style helpers.
 *
 * These helpers are pure browser-side utilities. They only read a minimal
 * structural view of SpeechSynthesisVoice and return serializable style ids /
 * utterance tuning values, so they can be unit tested without a real speech
 * backend.
 */

export type VoiceStyleId = 'natural' | 'cool' | 'loli' | 'mature' | 'young' | 'deep'

export interface VoiceStyle {
  id: VoiceStyleId
  label: string
  description: string
  pitch: number
  rate: number
  /** Preferred voice-name keyword hints, lower-cased before matching. */
  keywords: readonly string[]
  /** Preferred speaker gender when the local voice name exposes it. */
  gender?: 'female' | 'male'
}

export const DEFAULT_VOICE_STYLE_ID: VoiceStyleId = 'natural'

export const VOICE_STYLES: readonly VoiceStyle[] = [
  {
    id: 'natural',
    label: '自然',
    description: '默认清晰自然',
    pitch: 1,
    rate: 1,
    keywords: []
  },
  {
    id: 'cool',
    label: '高冷',
    description: '清冷低沉、语速略慢',
    pitch: 0.76,
    rate: 0.88,
    keywords: ['kangkang', 'yunjian', 'yunyang', 'yunxi', 'daniel', 'george', 'male'],
    gender: 'male'
  },
  {
    id: 'loli',
    label: '萝莉',
    description: '清脆甜美、音调偏高',
    pitch: 1.65,
    rate: 1.12,
    keywords: ['huihui', 'xiaoxiao', 'xiaoyi', 'yaoyao', 'meijia', 'tingting', 'sinji', 'lili', 'female'],
    gender: 'female'
  },
  {
    id: 'mature',
    label: '御姐',
    description: '成熟知性、稍低但保持清晰',
    pitch: 0.92,
    rate: 0.96,
    keywords: ['yaoyao', 'tingting', 'meijia', 'sinji', 'mei', 'lili', 'female'],
    gender: 'female'
  },
  {
    id: 'young',
    label: '少年',
    description: '明亮有活力',
    pitch: 1.22,
    rate: 1.04,
    keywords: ['kangkang', 'yunxi', 'yunjian', 'daniel', 'male'],
    gender: 'male'
  },
  {
    id: 'deep',
    label: '磁性',
    description: '低沉有磁性',
    pitch: 0.62,
    rate: 0.84,
    keywords: ['kangkang', 'yunjian', 'yunyang', 'yunfeng', 'daniel', 'george', 'male'],
    gender: 'male'
  }
]

export const VOICE_STYLE_IDS: readonly VoiceStyleId[] = VOICE_STYLES.map(style => style.id)

const VOICE_STYLE_BY_ID: Readonly<Record<VoiceStyleId, VoiceStyle>> = Object.fromEntries(
  VOICE_STYLES.map(style => [style.id, style])
) as Readonly<Record<VoiceStyleId, VoiceStyle>>

/** Validate untrusted storage/UI input and fall back to the default style. */
export function normalizeVoiceStyle (value: unknown): VoiceStyleId {
  if (typeof value === 'string' && VOICE_STYLE_IDS.includes(value as VoiceStyleId)) {
    return value as VoiceStyleId
  }
  return DEFAULT_VOICE_STYLE_ID
}

/** Minimal structural view of SpeechSynthesisVoice used by the pure picker. */
export interface SpeechSynthesisVoiceLike {
  readonly name: string
  readonly lang: string
  readonly default: boolean
  readonly localService: boolean
  readonly voiceURI: string
}

export interface SpeechConfig {
  voice: SpeechSynthesisVoiceLike | null
  lang: string
  pitch: number
  rate: number
}

const FEMALE_HINTS = new Set([
  'huihui', 'xiaoxiao', 'xiaoyi', 'yaoyao', 'meijia', 'tingting', 'sinji',
  'xiaochen', 'hanhan', 'shuang', 'xi', 'lihua', 'mei', 'lili', 'sisi',
  'huan', 'zhiyu', 'ying', 'female'
])

const MALE_HINTS = new Set([
  'kangkang', 'yunjian', 'yunyang', 'yunxi', 'yunfeng', 'daniel', 'george',
  'male'
])

function isChineseVoice (voice: SpeechSynthesisVoiceLike): boolean {
  return voice.lang.toLowerCase().startsWith('zh')
}

function isFemaleVoice (voice: SpeechSynthesisVoiceLike): boolean {
  const name = voice.name.toLowerCase()
  return [...FEMALE_HINTS].some(hint => name.includes(hint))
}

function isMaleVoice (voice: SpeechSynthesisVoiceLike): boolean {
  const name = voice.name.toLowerCase()
  return [...MALE_HINTS].some(hint => name.includes(hint))
}

function scoreVoice (voice: SpeechSynthesisVoiceLike, style: VoiceStyle): number {
  const name = voice.name.toLowerCase()
  const lang = voice.lang.toLowerCase()
  let score = 0

  if (isChineseVoice(voice)) score += 100
  if (lang.includes('cn') || lang.includes('hans')) score += 10
  if (voice.default) score += 5
  if (style.gender === 'female' && isFemaleVoice(voice)) score += 50
  if (style.gender === 'male' && isMaleVoice(voice)) score += 50

  for (const keyword of style.keywords) {
    if (name.includes(keyword.toLowerCase())) score += 20
  }

  return score
}

/**
 * Pick the closest local voice for a style and return utterance tuning values.
 * The style is applied even when no matching voice is available, so the TTS
 * switch remains visible in browsers that only expose a single voice.
 */
export function resolveSpeechConfig (
  styleId: VoiceStyleId,
  voices: readonly SpeechSynthesisVoiceLike[]
): SpeechConfig {
  const style = VOICE_STYLE_BY_ID[styleId] ?? VOICE_STYLE_BY_ID[DEFAULT_VOICE_STYLE_ID]
  let best: SpeechSynthesisVoiceLike | null = null
  let bestScore = -1

  for (const voice of voices) {
    const score = scoreVoice(voice, style)
    if (score > bestScore) {
      bestScore = score
      best = voice
    }
  }

  return {
    voice: best,
    lang: best?.lang ?? 'zh-CN',
    pitch: style.pitch,
    rate: style.rate
  }
}
