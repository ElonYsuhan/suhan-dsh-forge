/**
 * Virtual companion voice contract shared by Host TTS and Client UI.
 *
 * This module is intentionally browser/Node agnostic. It only describes
 * switchable voice styles and the Edge TTS profile used to synthesize them,
 * so both the Host route and the Client panel can validate the same wire enum.
 */

export type VoiceStyleId = 'natural' | 'cool' | 'loli' | 'mature' | 'young' | 'deep'

export interface VoiceStyle {
  id: VoiceStyleId
  label: string
  description: string
  /** Microsoft Edge neural TTS short name (zh-CN voices). */
  edgeVoice: string
  /** msedge-tts ProsodyOptions.rate value. */
  edgeRate: number
  /** msedge-tts ProsodyOptions.pitch value. */
  edgePitch: string
}

export const DEFAULT_VOICE_STYLE_ID: VoiceStyleId = 'natural'

export const VOICE_STYLES: readonly VoiceStyle[] = [
  {
    id: 'natural',
    label: '自然',
    description: '默认清晰自然',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    edgeRate: 1,
    edgePitch: '+0Hz'
  },
  {
    id: 'cool',
    label: '高冷',
    description: '清冷低沉、语速略慢',
    edgeVoice: 'zh-CN-YunjianNeural',
    edgeRate: 0.9,
    edgePitch: '-8Hz'
  },
  {
    id: 'loli',
    label: '萝莉',
    description: '清脆甜美、音调偏高',
    edgeVoice: 'zh-CN-XiaoyiNeural',
    edgeRate: 1.08,
    edgePitch: '+12Hz'
  },
  {
    id: 'mature',
    label: '御姐',
    description: '成熟知性、稍低但保持清晰',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    edgeRate: 0.95,
    edgePitch: '-4Hz'
  },
  {
    id: 'young',
    label: '少年',
    description: '明亮有活力',
    edgeVoice: 'zh-CN-YunxiNeural',
    edgeRate: 1.05,
    edgePitch: '+4Hz'
  },
  {
    id: 'deep',
    label: '磁性',
    description: '低沉有磁性',
    edgeVoice: 'zh-CN-YunjianNeural',
    edgeRate: 0.85,
    edgePitch: '-14Hz'
  }
]

export const VOICE_STYLE_IDS: readonly VoiceStyleId[] = VOICE_STYLES.map(style => style.id)

const VOICE_STYLE_BY_ID: Readonly<Record<VoiceStyleId, VoiceStyle>> = Object.fromEntries(
  VOICE_STYLES.map(style => [style.id, style])
) as Readonly<Record<VoiceStyleId, VoiceStyle>>

/** Validate untrusted storage/UI/HTTP input and fall back to the default style. */
export function normalizeVoiceStyle (value: unknown): VoiceStyleId {
  if (typeof value === 'string' && VOICE_STYLE_IDS.includes(value as VoiceStyleId)) {
    return value as VoiceStyleId
  }
  return DEFAULT_VOICE_STYLE_ID
}

/** Look up a style by id; unknown ids fall back to the default profile. */
export function getVoiceStyle (value: unknown): VoiceStyle {
  const id = normalizeVoiceStyle(value)
  return VOICE_STYLE_BY_ID[id]
}
