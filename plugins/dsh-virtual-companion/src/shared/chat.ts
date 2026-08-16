/**
 * Pure chat helpers shared by Host logic and unit tests. No DOM or Node APIs.
 */
import { createAssistantMessage, createUserMessage, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CHAT_HISTORY_LIMIT, CHAT_TEXT_MAX_LENGTH } from './types.ts'

/** Error for invalid client chat input. */
export class ChatInputError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ChatInputError'
  }
}

/** Error when the LLM stream produces no usable reply or ends with failure. */
export class ChatReplyError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ChatReplyError'
  }
}

/** Validate and normalize a chat text value coming from HTTP/JSON. */
export function normalizeChatText (input: unknown): string {
  if (typeof input !== 'string') throw new ChatInputError('text must be a string')
  const text = input.trim()
  if (text.length === 0) throw new ChatInputError('text must not be empty')
  if (text.length > CHAT_TEXT_MAX_LENGTH) {
    throw new ChatInputError(`text must not exceed ${CHAT_TEXT_MAX_LENGTH} characters`)
  }
  return text
}

/** Append one user/assistant turn and keep the in-memory history bounded. */
export function appendTurn (
  history: readonly Message[],
  userText: string,
  assistantText: string,
  provider: string,
  model: string
): Message[] {
  const next: Message[] = [
    ...history,
    createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' }
    }),
    createAssistantMessage({
      content: [{ type: 'text', text: assistantText }],
      source: { provider, model }
    })
  ]
  return next.length > CHAT_HISTORY_LIMIT ? next.slice(-CHAT_HISTORY_LIMIT) : next
}

/** Split a reply into sentence-sized chunks suitable for progressive TTS. */
export function splitReplySentences (text: string): string[] {
  return text.match(/[^。！？!?；;]+(?:[。！？!?；;]+|$)/g)?.map(item => item.trim()).filter(Boolean) ?? []
}

/** Collect visible text from an LLM chunk stream and fail on error/abort finish. */
export async function collectReply (stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      const failure = chunk.reason.failure
      throw new ChatReplyError(failure?.message ?? `LLM stream ended with ${chunk.reason.kind}`)
    }
  }
  const reply = text.trim()
  if (reply.length === 0) throw new ChatReplyError('模型没有返回可朗读文本')
  return reply
}

/**
 * Stream a reply as complete sentences become available. This lets the
 * client display and speak the first sentence before the full LLM response
 * has finished, improving perceived chat latency.
 */
export async function * collectReplySentences (stream: AsyncIterable<StreamChunk>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') buffer += chunk.text
    if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      const failure = chunk.reason.failure
      throw new ChatReplyError(failure?.message ?? `LLM stream ended with ${chunk.reason.kind}`)
    }
    while (true) {
      const match = buffer.match(/^[\s\S]*?[。！？!?；;]/)
      if (match === null || match[0] === undefined) break
      const sentence = match[0].trim()
      buffer = buffer.slice(match[0].length)
      if (sentence.length > 0) yield sentence
    }
  }
  const tail = buffer.trim()
  if (tail.length > 0) yield tail
}
