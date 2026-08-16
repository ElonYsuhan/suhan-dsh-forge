/**
 * Virtual companion voice contract shared by Host TTS and Client UI.
 *
 * This module is intentionally browser/Node agnostic. It only describes
 * switchable voice styles and the Edge TTS profile used to synthesize them,
 * so both the Host route and the Client panel can validate the same wire enum.
 */

export type VoiceStyleId = 'sweet' | 'gentle' | 'cute' | 'mature' | 'elegant' | 'lively'

export interface VoiceStyle {
  id: VoiceStyleId
  label: string
  description: string
  /** Microsoft Edge neural TTS short name (zh-CN female voices). */
  edgeVoice: string
  /** msedge-tts ProsodyOptions.rate value. */
  edgeRate: number
  /** msedge-tts ProsodyOptions.pitch value. */
  edgePitch: string
}

export const DEFAULT_VOICE_STYLE_ID: VoiceStyleId = 'gentle'

export const VOICE_STYLES: readonly VoiceStyle[] = [
  {
    id: 'sweet',
    label: '甜美',
    description: '清甜明亮、音调偏高',
    edgeVoice: 'zh-CN-XiaoyiNeural',
    edgeRate: 1.08,
    edgePitch: '+12Hz'
  },
  {
    id: 'gentle',
    label: '温柔',
    description: '柔和平缓、亲近自然',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    edgeRate: 0.96,
    edgePitch: '+2Hz'
  },
  {
    id: 'cute',
    label: '可爱',
    description: '活泼俏皮、少女感强',
    edgeVoice: 'zh-CN-XiaobeiNeural',
    edgeRate: 1.12,
    edgePitch: '+16Hz'
  },
  {
    id: 'mature',
    label: '御姐',
    description: '成熟自信、气场沉稳',
    edgeVoice: 'zh-CN-YunxiaNeural',
    edgeRate: 0.94,
    edgePitch: '-4Hz'
  },
  {
    id: 'elegant',
    label: '知性',
    description: '温和知性、表达清晰',
    edgeVoice: 'zh-CN-YunxiNeural',
    edgeRate: 0.98,
    edgePitch: '+0Hz'
  },
  {
    id: 'lively',
    label: '元气',
    description: '元气满满、活力十足',
    edgeVoice: 'zh-CN-XiaoxuanNeural',
    edgeRate: 1.12,
    edgePitch: '+8Hz'
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
