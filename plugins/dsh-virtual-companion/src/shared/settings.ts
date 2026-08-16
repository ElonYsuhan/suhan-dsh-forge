/**
 * Virtual companion user settings shared by the Host chat service and the
 * browser settings panel.
 *
 * This module is intentionally browser/Node agnostic. It only defines
 * serializable role/background presets and a validation helper, so both the
 * Client localStorage and Host HTTP routes can use the same wire enum.
 */
import {
  DEFAULT_VOICE_STYLE_ID,
  normalizeVoiceStyle,
  type VoiceStyleId
} from './voice.ts'

/** Character role presets that change the companion system prompt. */
export type RoleId = 'warm' | 'elegant' | 'energetic' | 'cool' | 'cute'

export interface RolePreset {
  id: RoleId
  label: string
  description: string
  /** Extra persona instructions merged into the base companion prompt. */
  systemPrompt: string
}

export const DEFAULT_ROLE_ID: RoleId = 'warm'

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'warm',
    label: '贴心伙伴',
    description: '温柔亲切，像熟悉的朋友',
    systemPrompt: '你是用户身边温柔贴心的伙伴，语气温暖自然，常主动关心用户。'
  },
  {
    id: 'elegant',
    label: '知性学姐',
    description: '成熟知性，表达有条理',
    systemPrompt: '你是知性成熟的学姐，表达简洁有条理，偶尔给出可靠建议。'
  },
  {
    id: 'energetic',
    label: '元气少女',
    description: '活泼开朗，充满活力',
    systemPrompt: '你是元气满满的少女，语气活泼热情，喜欢用感叹号和轻松的表达。'
  },
  {
    id: 'cool',
    label: '高冷男神',
    description: '冷静简洁，惜字如金',
    systemPrompt: '你是冷静高冷的男神，回答简短直接，不拖泥带水，但仍有礼貌。'
  },
  {
    id: 'cute',
    label: '软萌小猫',
    description: '可爱软萌，带一点俏皮',
    systemPrompt: '你是软萌俏皮的小猫伙伴，语气可爱，喜欢用叠词和拟声词。'
  }
]

export const ROLE_IDS: readonly RoleId[] = ROLE_PRESETS.map(role => role.id)

const ROLE_BY_ID: Readonly<Record<RoleId, RolePreset>> = Object.fromEntries(
  ROLE_PRESETS.map(role => [role.id, role])
) as Readonly<Record<RoleId, RolePreset>>

/** Validate untrusted storage/UI/HTTP input and fall back to the default role. */
export function normalizeRoleId (value: unknown): RoleId {
  if (typeof value === 'string' && ROLE_IDS.includes(value as RoleId)) {
    return value as RoleId
  }
  return DEFAULT_ROLE_ID
}

/** Look up a role preset by id; unknown ids fall back to the default. */
export function getRolePreset (value: unknown): RolePreset {
  const id = normalizeRoleId(value)
  return ROLE_BY_ID[id]
}

/** Build the full system prompt for a role id. */
export function getRoleSystemPrompt (value: unknown): string {
  const preset = getRolePreset(value)
  return [
    '你是运行在 DeepSeek Harness Web 中的 3D 虚拟伙伴。',
    preset.systemPrompt,
    '回答控制在 2-4 句以内，适合语音朗读。'
  ].join(' ')
}

/** Chat bubble/panel background presets. */
export type ChatBackgroundId = 'day' | 'sunset' | 'night' | 'forest' | 'transparent'

export interface ChatBackgroundPreset {
  id: ChatBackgroundId
  label: string
  /** CSS background value used by the client bubble and settings panel. */
  css: string
  /** CSS text color that remains readable on this background. */
  textColor: string
}

export const DEFAULT_CHAT_BACKGROUND_ID: ChatBackgroundId = 'day'

export const CHAT_BACKGROUNDS: readonly ChatBackgroundPreset[] = [
  {
    id: 'day',
    label: '晨光白',
    css: 'linear-gradient(135deg, rgba(255,255,255,.96), rgba(240,244,255,.94))',
    textColor: '#1a1a1a'
  },
  {
    id: 'sunset',
    label: '落日橙',
    css: 'linear-gradient(135deg, rgba(255,236,210,.97), rgba(255,214,165,.95))',
    textColor: '#4a2c0a'
  },
  {
    id: 'night',
    label: '夜幕蓝',
    css: 'linear-gradient(135deg, rgba(30,42,70,.97), rgba(15,23,42,.95))',
    textColor: '#e8edf5'
  },
  {
    id: 'forest',
    label: '森林绿',
    css: 'linear-gradient(135deg, rgba(220,245,230,.97), rgba(178,225,195,.95))',
    textColor: '#14331f'
  },
  {
    id: 'transparent',
    label: '透明',
    css: 'rgba(255,255,255,.72)',
    textColor: '#1a1a1a'
  }
]

export const CHAT_BACKGROUND_IDS: readonly ChatBackgroundId[] = CHAT_BACKGROUNDS.map(item => item.id)

const CHAT_BACKGROUND_BY_ID: Readonly<Record<ChatBackgroundId, ChatBackgroundPreset>> = Object.fromEntries(
  CHAT_BACKGROUNDS.map(item => [item.id, item])
) as Readonly<Record<ChatBackgroundId, ChatBackgroundPreset>>

/** Validate untrusted background ids and fall back to the default. */
export function normalizeChatBackgroundId (value: unknown): ChatBackgroundId {
  if (typeof value === 'string' && CHAT_BACKGROUND_IDS.includes(value as ChatBackgroundId)) {
    return value as ChatBackgroundId
  }
  return DEFAULT_CHAT_BACKGROUND_ID
}

/** Look up a background preset by id; unknown ids fall back to the default. */
export function getChatBackground (value: unknown): ChatBackgroundPreset {
  const id = normalizeChatBackgroundId(value)
  return CHAT_BACKGROUND_BY_ID[id]
}

/** Serializable companion settings persisted in the browser and used by HTTP calls. */
export interface CompanionSettings {
  roleId: RoleId
  voiceId: VoiceStyleId
  backgroundId: ChatBackgroundId
  /** When true, chat replies are streamed and spoken sentence-by-sentence. */
  realtime: boolean
}

export const DEFAULT_SETTINGS: CompanionSettings = {
  roleId: DEFAULT_ROLE_ID,
  voiceId: DEFAULT_VOICE_STYLE_ID,
  backgroundId: DEFAULT_CHAT_BACKGROUND_ID,
  realtime: true
}

/** Validate an unknown settings object and fill missing fields with defaults. */
export function normalizeSettings (value: unknown): CompanionSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    roleId: normalizeRoleId(source.roleId),
    voiceId: normalizeVoiceStyle(source.voiceId),
    backgroundId: normalizeChatBackgroundId(source.backgroundId),
    realtime: typeof source.realtime === 'boolean' ? source.realtime : DEFAULT_SETTINGS.realtime
  }
}
