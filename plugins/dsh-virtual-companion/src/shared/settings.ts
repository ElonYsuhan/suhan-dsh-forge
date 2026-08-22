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
    label: '高冷御姐',
    description: '冷静优雅，御姐气场',
    systemPrompt: '你是冷静优雅的高冷御姐，回答简短直接，不拖泥带水，但仍有礼貌。'
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

/** Maximum length for user-provided background/scene information. */
export const BACKGROUND_TEXT_MAX_LENGTH = 500

/** Normalize an untrusted background text value from storage or HTTP. */
export function normalizeBackgroundText (value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, BACKGROUND_TEXT_MAX_LENGTH)
}

/** Build the full system prompt for a role id, optionally including user-defined background info. */
export function getRoleSystemPrompt (value: unknown, backgroundText = ''): string {
  const preset = getRolePreset(value)
  const parts = [
    '你是运行在 DeepSeek Harness Web 中的 3D 虚拟伙伴。',
    preset.systemPrompt,
    '回答控制在 2-4 句以内，适合语音朗读。',
    '表情约定：当你需要表达情绪时，在该句开头加一个方括号情绪标签（微笑/开心/惊讶/难过/思考/害羞/认真），例如：【微笑】你好呀。没有明显情绪时不要加标签。'
  ]
  const background = normalizeBackgroundText(backgroundText)
  if (background.length > 0) {
    parts.push(`当前场景背景信息：${background}`)
  }
  return parts.join(' ')
}

/** Fairy girl skin presets that change the 3D character's outfit and wings. */
export type SkinId = 'fairyPink' | 'fairyBlue' | 'fairyPurple' | 'fairyGreen'

export interface SkinPreset {
  id: SkinId
  label: string
  description: string
  /** Main dress color. */
  dressColor: number
  /** Hair accent/ribbon color. */
  accentColor: number
  /** Fairy wing color. */
  wingColor: number
}

export const DEFAULT_SKIN_ID: SkinId = 'fairyPink'

export const SKIN_PRESETS: readonly SkinPreset[] = [
  {
    id: 'fairyPink',
    label: '仙粉',
    description: '粉色仙女裙，甜美梦幻',
    dressColor: 0xf7a8c4,
    accentColor: 0xffd1e8,
    wingColor: 0xf5d0e8
  },
  {
    id: 'fairyBlue',
    label: '仙蓝',
    description: '淡蓝仙女裙，清冷优雅',
    dressColor: 0x7ec8e3,
    accentColor: 0xd6f0ff,
    wingColor: 0xcdeaff
  },
  {
    id: 'fairyPurple',
    label: '仙紫',
    description: '紫罗兰仙女裙，神秘高贵',
    dressColor: 0xb79ced,
    accentColor: 0xe3d6ff,
    wingColor: 0xd9c8ff
  },
  {
    id: 'fairyGreen',
    label: '仙绿',
    description: '清新绿仙女裙，自然灵动',
    dressColor: 0x8fd6a8,
    accentColor: 0xd9ffe8,
    wingColor: 0xd0f2d8
  }
]

export const SKIN_IDS: readonly SkinId[] = SKIN_PRESETS.map(skin => skin.id)

const SKIN_BY_ID: Readonly<Record<SkinId, SkinPreset>> = Object.fromEntries(
  SKIN_PRESETS.map(skin => [skin.id, skin])
) as Readonly<Record<SkinId, SkinPreset>>

/** Validate untrusted skin ids and fall back to the default. */
export function normalizeSkinId (value: unknown): SkinId {
  if (typeof value === 'string' && SKIN_IDS.includes(value as SkinId)) {
    return value as SkinId
  }
  return DEFAULT_SKIN_ID
}

/** Look up a skin preset by id; unknown ids fall back to the default. */
export function getSkinPreset (value: unknown): SkinPreset {
  const id = normalizeSkinId(value)
  return SKIN_BY_ID[id]
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
  skinId: SkinId
  /** 本地模型目录里的模型 id（对应 /virtual-companion/models 列表）。 */
  modelId: string
  /** 模型亮度（色调映射曝光，0.4-2.5）。 */
  brightness: number
  /** 面部直射光强度（0-2）。 */
  faceLight: number
  /** User-defined background/scene info sent to the LLM as context. */
  backgroundText: string
  /** Kept for backwards-compatible storage; the UI no longer offers color selection. */
  backgroundId: ChatBackgroundId
  /** When true, chat replies are streamed and spoken sentence-by-sentence. */
  realtime: boolean
}

export const DEFAULT_MODEL_ID = 'hongqiangwei-short'
export const DEFAULT_BRIGHTNESS = 0.85
export const BRIGHTNESS_MIN = 0.4
export const BRIGHTNESS_MAX = 2.5
export const DEFAULT_FACE_LIGHT = 0.85
export const FACE_LIGHT_MIN = 0
export const FACE_LIGHT_MAX = 2

export const DEFAULT_SETTINGS: CompanionSettings = {
  roleId: DEFAULT_ROLE_ID,
  voiceId: DEFAULT_VOICE_STYLE_ID,
  skinId: DEFAULT_SKIN_ID,
  modelId: DEFAULT_MODEL_ID,
  brightness: DEFAULT_BRIGHTNESS,
  faceLight: DEFAULT_FACE_LIGHT,
  backgroundText: '',
  backgroundId: DEFAULT_CHAT_BACKGROUND_ID,
  realtime: true
}

/** Validate an unknown settings object and fill missing fields with defaults. */
export function normalizeSettings (value: unknown): CompanionSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    roleId: normalizeRoleId(source.roleId),
    voiceId: normalizeVoiceStyle(source.voiceId),
    skinId: normalizeSkinId(source.skinId),
    modelId: typeof source.modelId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(source.modelId)
      ? source.modelId
      : DEFAULT_MODEL_ID,
    brightness: typeof source.brightness === 'number' && Number.isFinite(source.brightness)
      ? Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, source.brightness))
      : DEFAULT_BRIGHTNESS,
    faceLight: typeof source.faceLight === 'number' && Number.isFinite(source.faceLight)
      ? Math.min(FACE_LIGHT_MAX, Math.max(FACE_LIGHT_MIN, source.faceLight))
      : DEFAULT_FACE_LIGHT,
    backgroundText: normalizeBackgroundText(source.backgroundText),
    backgroundId: normalizeChatBackgroundId(source.backgroundId),
    realtime: typeof source.realtime === 'boolean' ? source.realtime : DEFAULT_SETTINGS.realtime
  }
}
