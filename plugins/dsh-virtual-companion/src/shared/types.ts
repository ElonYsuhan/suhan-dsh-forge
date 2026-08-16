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

/** Client -> Host chat request body. */
export interface ChatRequest {
  text: string
}

/** Host -> Client chat response body. */
export interface ChatResponse {
  reply: string
}
