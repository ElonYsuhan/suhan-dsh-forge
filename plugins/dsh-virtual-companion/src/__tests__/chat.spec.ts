import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  appendTurn,
  ChatInputError,
  ChatReplyError,
  collectReply,
  collectReplySentences,
  normalizeChatText,
  splitReplySentences
} from '../shared/chat.ts'
import { CHAT_HISTORY_LIMIT, CHAT_TEXT_MAX_LENGTH } from '../shared/types.ts'

describe('normalizeChatText', () => {
  it('accepts trimmed non-empty text', () => {
    expect(normalizeChatText('  你好  ')).toBe('你好')
  })

  it('rejects non-string, empty and over-long text', () => {
    expect(() => normalizeChatText(42)).toThrow(ChatInputError)
    expect(() => normalizeChatText('   ')).toThrow(ChatInputError)
    expect(() => normalizeChatText('a'.repeat(CHAT_TEXT_MAX_LENGTH + 1))).toThrow(ChatInputError)
  })
})

describe('appendTurn', () => {
  it('appends a user/assistant turn with immutable history input', () => {
    const history = appendTurn([], '你好', '你好呀', 'test-provider', 'test-model')
    expect(history).toHaveLength(2)
    expect(history[0]?.role).toBe('user')
    expect(history[1]?.role).toBe('assistant')
    expect(history[1]?.content[0]?.type).toBe('text')
  })

  it('caps history at the configured limit', () => {
    let history = appendTurn([], '0', 'r0', 'p', 'm')
    for (let i = 1; i < 30; i += 1) {
      history = appendTurn(history, String(i), `r${i}`, 'p', 'm')
    }
    expect(history.length).toBe(CHAT_HISTORY_LIMIT)
    expect(history[0]?.content[0]?.type).toBe('text')
  })
})

describe('collectReply', () => {
  it('collects visible text deltas and ignores finish stop', async () => {
    async function * stream (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '你' }
      yield { type: 'text-delta', index: 0, text: '好' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    await expect(collectReply(stream())).resolves.toBe('你好')
  })

  it('fails on error finish', async () => {
    async function * stream (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'ERR_TEST' } } }
    }

    await expect(collectReply(stream())).rejects.toThrow(ChatReplyError)
  })

  it('fails when the stream has no visible text', async () => {
    async function * stream (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    await expect(collectReply(stream())).rejects.toThrow(ChatReplyError)
  })
})

describe('splitReplySentences', () => {
  it('splits Chinese and English punctuation into trimmed sentences', () => {
    expect(splitReplySentences('你好！今天好吗？我很好。')).toEqual(['你好！', '今天好吗？', '我很好。'])
    expect(splitReplySentences('Hi! Bye.')).toEqual(['Hi!', 'Bye.'])
  })

  it('returns a single trailing sentence without punctuation', () => {
    expect(splitReplySentences('没有标点的一句话')).toEqual(['没有标点的一句话'])
    expect(splitReplySentences('')).toEqual([])
  })
})

describe('collectReplySentences', () => {
  it('yields complete sentences as soon as punctuation arrives and flushes the tail', async () => {
    async function * stream (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '你好！' }
      yield { type: 'text-delta', index: 0, text: '今天' }
      yield { type: 'text-delta', index: 0, text: '好吗？' }
      yield { type: 'text-delta', index: 0, text: '再见' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    const sentences: string[] = []
    for await (const sentence of collectReplySentences(stream())) {
      sentences.push(sentence)
    }
    expect(sentences).toEqual(['你好！', '今天好吗？', '再见'])
  })

  it('fails on error finish before flushing incomplete text', async () => {
    async function * stream (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '部分' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'ERR_TEST' } } }
    }

    await expect(async () => {
      for await (const _sentence of collectReplySentences(stream())) {
        // consume
      }
    }).rejects.toThrow(ChatReplyError)
  })
})
