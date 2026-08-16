/**
 * Virtual companion wire contract shared by the Host chat service and the
 * browser companion UI. Only serializable data crosses the Host/Client edge.
 */

/** Maximum length of a single chat message accepted from the client. */
export const CHAT_TEXT_MAX_LENGTH = 2_000

/** Maximum number of chat messages retained in Host memory. */
export const CHAT_HISTORY_LIMIT = 20

/** System prompt used to keep the companion personality stable across calls. */
export const COMPANION_SYSTEM_PROMPT = [
  '你是运行在 DeepSeek Harness Web 中的 3D 虚拟伙伴。',
  '你亲切、简洁、有活力，会配合 3D 形象进行友好聊天。',
  '回答控制在 2-4 句以内，适合语音朗读。'
].join(' ')

/** Internal prompt used when the user clicks the companion to start a voice session. */
export const OPENING_REQUEST = '用户刚刚单击了你，请主动向用户问好，并自然地问一个简短的中文问题来开启语音聊天。'

/** Client -> Host chat request body. */
export interface ChatRequest {
  text: string
  /** Character role id; missing values fall back to the default role. */
  role?: string
  /** User-defined background/scene info; normalized on the Host. */
  background?: string
}

/** Client -> Host proactive opening request body. */
export interface OpeningRequest {
  role?: string
  /** User-defined background/scene info; normalized on the Host. */
  background?: string
}

/** Host -> Client chat response body. */
export interface ChatResponse {
  reply: string
}

/** One SSE frame emitted by the streaming chat endpoint. */
export interface ChatStreamEvent {
  /** Raw token delta for immediate on-screen text while the LLM is generating. */
  delta?: string
  /** A complete sentence ready for sentence-level TTS playback. */
  sentence?: string
  done?: boolean
  error?: string
}
