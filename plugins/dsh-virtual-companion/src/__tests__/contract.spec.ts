import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../index.ts'

interface RouteLike {
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

interface ResponseLike extends ServerResponse {
  status: number
  body: unknown
}

function request (method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    async * [Symbol.asyncIterator] () {
      yield * chunks
    }
  } as unknown as IncomingMessage
}

function requestRaw (method: string, url: string, raw: string): IncomingMessage {
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async * [Symbol.asyncIterator] () {
      yield Buffer.from(raw)
    }
  } as unknown as IncomingMessage
}

function response (): ResponseLike {
  const state: { status: number; body: unknown } = { status: 0, body: undefined }
  const res = {
    writeHead (status: number): void {
      state.status = status
    },
    end (body: string): void {
      state.body = JSON.parse(body)
    }
  } as unknown as ResponseLike
  Object.defineProperty(res, 'status', { get: () => state.status })
  Object.defineProperty(res, 'body', { get: () => state.body })
  return res
}

function createContext (streamImpl?: () => AsyncGenerator<StreamChunk>) {
  const routes: RouteLike[] = []
  const disposers: Array<() => void> = []
  const stream = vi.fn(streamImpl ?? (async function * () {
    yield { type: 'text-delta', index: 0, text: '你好呀' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  const ctx = {
    effect (factory: () => unknown, _label?: string): void {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    },
    get (name: string): unknown {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      return undefined
    },
    webServer: {
      register (route: RouteLike): () => void {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      }
    },
    llm: {
      stream
    }
  }
  return { ctx: ctx as unknown as Parameters<typeof apply>[0], routes, disposers, stream }
}

describe('virtual-companion host contract', () => {
  it('registers the /virtual-companion route and answers health', async () => {
    const { ctx, routes } = createContext()
    apply(ctx)
    expect(routes).toHaveLength(1)
    expect(routes[0]?.path).toBe('/virtual-companion')

    const res = response()
    await routes[0]!.handler(request('GET', '/virtual-companion/health'), res)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('chats through the DSH LLM stream and returns the collected reply', async () => {
    const { ctx, routes, stream } = createContext()
    apply(ctx)

    const res = response()
    await routes[0]!.handler(request('POST', '/virtual-companion/chat', { text: '你好' }), res)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ reply: '你好呀' })
  })

  it('rejects invalid chat input without calling the LLM', async () => {
    const { ctx, routes, stream } = createContext()
    apply(ctx)

    const res = response()
    await routes[0]!.handler(request('POST', '/virtual-companion/chat', { text: '   ' }), res)
    expect(stream).not.toHaveBeenCalled()
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown routes and unsupported methods', async () => {
    const { ctx, routes } = createContext()
    apply(ctx)

    const unknown = response()
    await routes[0]!.handler(request('GET', '/virtual-companion/nope'), unknown)
    expect(unknown.status).toBe(404)

    const wrongMethod = response()
    await routes[0]!.handler(request('POST', '/virtual-companion/health'), wrongMethod)
    expect(wrongMethod.status).toBe(404)
  })

  it('rejects malformed JSON with 400', async () => {
    const { ctx, routes, stream } = createContext()
    apply(ctx)

    const res = response()
    await routes[0]!.handler(requestRaw('POST', '/virtual-companion/chat', '{not-json'), res)
    expect(stream).not.toHaveBeenCalled()
    expect(res.status).toBe(400)
  })

  it('rejects oversized request bodies with 413', async () => {
    const { ctx, routes, stream } = createContext()
    apply(ctx)

    const res = response()
    const hugeText = 'a'.repeat(70 * 1024)
    await routes[0]!.handler(request('POST', '/virtual-companion/chat', { text: hugeText }), res)
    expect(stream).not.toHaveBeenCalled()
    expect(res.status).toBe(413)
  })

  it('returns 502 when the LLM stream fails', async () => {
    const { ctx, routes } = createContext(async function * () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'ERR_TEST' } } }
    })
    apply(ctx)

    const res = response()
    await routes[0]!.handler(request('POST', '/virtual-companion/chat', { text: '你好' }), res)
    expect(res.status).toBe(502)
  })

  it('keeps Host chat history bounded across repeated turns', async () => {
    const { ctx, routes, stream } = createContext(async function * () {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    apply(ctx)

    let lastMessageCount = 0
    for (let turn = 0; turn < 12; turn += 1) {
      const res = response()
      await routes[0]!.handler(request('POST', '/virtual-companion/chat', { text: `m${turn}` }), res)
      expect(res.status).toBe(200)
      const options = stream.mock.calls[stream.mock.calls.length - 1]?.[0] as { messages?: unknown[] } | undefined
      lastMessageCount = options?.messages?.length ?? 0
    }

    expect(lastMessageCount).toBe(20)
  })

  it('runs registered disposers without throwing and tolerates repeated calls', () => {
    const { ctx, disposers } = createContext()
    apply(ctx)
    expect(() => {
      for (let round = 0; round < 2; round += 1) {
        for (const disposer of disposers) disposer()
      }
    }).not.toThrow()
  })
})
