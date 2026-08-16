/**
 * 虚拟伙伴插件，Host 半：
 * - 提供本地 REST 路由 `/virtual-companion`
 * - 复用 DSH 当前默认模型，通过 `ctx.llm.stream` 生成语音聊天回复
 * - 对话历史仅保存在内存，最多 20 条
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { appendTurn, ChatInputError, ChatReplyError, collectReply, collectReplySentences, normalizeChatText } from './shared/chat.ts'
import { getRoleSystemPrompt } from './shared/settings.ts'
import { CHAT_HISTORY_LIMIT, OPENING_REQUEST } from './shared/types.ts'
import { normalizeVoiceStyle } from './shared/voice.ts'
import { EdgeTtsSpeechSynth, TtsError, type SpeechSynth } from './tts.ts'
import { HttpError, readJsonBody, safeDiagnostic, sendJson, sendSseEvent } from './http.ts'

/** Required Host services. */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Optional Host dependencies for deterministic tests. */
export interface VirtualCompanionHostOptions {
  speechSynth?: SpeechSynth
}

/** Minimal shape of the DSH default model selection service. */
interface AgentDefaultModelLike {
  currentSelection: () => { provider: string; model: string }
}

/** Read the DSH web profile's currently selected provider/model. */
function currentModelSelection (ctx: Context): { provider: string; model: string } {
  const service = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  if (service === undefined) throw new Error('agentDefaultModel service is unavailable')
  const selection = service.currentSelection()
  if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') {
    throw new Error('agentDefaultModel returned an invalid model selection')
  }
  return { provider: selection.provider, model: selection.model }
}

/**
 * 虚拟伙伴插件 body，host 半。
 * @param ctx - host context（webServer / llm / agentDefaultModel）。
 * @param options - optional dependencies; production callers can omit them.
 */
export function apply (ctx: Context, options: VirtualCompanionHostOptions = {}): void {
  const speechSynth = options.speechSynth ?? new EdgeTtsSpeechSynth()
  let history: Message[] = []

  ctx.effect(() => async () => {
    history = []
  }, 'virtual-companion: memory')

  ctx.effect(() => () => {
    speechSynth.dispose()
  }, 'virtual-companion: tts')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/virtual-companion',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const parts = url.pathname.split('/').filter(Boolean)
        const method = req.method ?? 'GET'

        if (parts[0] === 'virtual-companion' && parts[1] === 'health' && parts.length === 2 && method === 'GET') {
          sendJson(res, 200, { ok: true })
          return
        }

        if (parts[0] === 'virtual-companion' && parts[1] === 'opening' && parts.length === 2 && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown> | null
          const selection = currentModelSelection(ctx)
          const openingMessage = createUserMessage({
            content: [{ type: 'text', text: OPENING_REQUEST }],
            source: { kind: 'user' }
          })
          const reply = await collectReply(ctx.llm.stream({
            provider: selection.provider,
            model: selection.model,
            messages: [...history.slice(-(CHAT_HISTORY_LIMIT - 1)), openingMessage],
            system: getRoleSystemPrompt(body?.role),
            signal: AbortSignal.timeout(30_000)
          }))
          history = appendTurn(history, OPENING_REQUEST, reply, selection.provider, selection.model)
          sendJson(res, 200, { reply })
          return
        }

        if (parts[0] === 'virtual-companion' && parts[1] === 'chat' && parts.length === 2 && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown> | null
          const text = normalizeChatText(body?.text)
          const selection = currentModelSelection(ctx)
          const userMessage = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' }
          })
          const reply = await collectReply(ctx.llm.stream({
            provider: selection.provider,
            model: selection.model,
            messages: [...history.slice(-(CHAT_HISTORY_LIMIT - 1)), userMessage],
            system: getRoleSystemPrompt(body?.role),
            signal: AbortSignal.timeout(30_000)
          }))
          history = appendTurn(history, text, reply, selection.provider, selection.model)
          sendJson(res, 200, { reply })
          return
        }

        if (parts[0] === 'virtual-companion' && parts[1] === 'chat' && parts[2] === 'stream' && parts.length === 3 && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown> | null
          const text = normalizeChatText(body?.text)
          const selection = currentModelSelection(ctx)
          const userMessage = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' }
          })
          const messages = [...history.slice(-(CHAT_HISTORY_LIMIT - 1)), userMessage]
          const system = getRoleSystemPrompt(body?.role)
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          })
          let fullReply = ''
          try {
            for await (const sentence of collectReplySentences(ctx.llm.stream({
              provider: selection.provider,
              model: selection.model,
              messages,
              system,
              signal: AbortSignal.timeout(30_000)
            }))) {
              fullReply += sentence
              sendSseEvent(res, { sentence })
            }
            if (fullReply.trim().length === 0) throw new ChatReplyError('模型没有返回可朗读文本')
            history = appendTurn(history, text, fullReply.trim(), selection.provider, selection.model)
            sendSseEvent(res, { done: true })
            res.end()
          } catch (error) {
            if (!res.writableEnded) {
              if (error instanceof ChatReplyError) {
                sendSseEvent(res, { error: '虚拟伙伴暂时无法回复，请稍后再试' })
              } else {
                sendSseEvent(res, { error: 'virtual companion stream failed' })
              }
              res.end()
            }
          }
          return
        }

        if (parts[0] === 'virtual-companion' && parts[1] === 'tts' && parts.length === 2 && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown> | null
          const text = normalizeChatText(body?.text)
          const voice = normalizeVoiceStyle(body?.voice)
          const audio = await speechSynth.synthesize(text, voice)
          res.writeHead(200, {
            'Content-Type': audio.contentType,
            'Content-Length': audio.buffer.length,
            'Cache-Control': 'no-store'
          })
          res.end(audio.buffer)
          return
        }

        sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message })
          return
        }
        if (error instanceof ChatInputError) {
          sendJson(res, 400, { error: error.message })
          return
        }
        if (error instanceof ChatReplyError) {
          sendJson(res, 502, { error: '虚拟伙伴暂时无法回复，请稍后再试' })
          return
        }
        if (error instanceof TtsError) {
          sendJson(res, 502, { error: '语音合成暂时不可用，请稍后再试' })
          return
        }
        process.stderr.write(`[dsh-virtual-companion] request failed: ${safeDiagnostic(error)}\n`)
        sendJson(res, 500, { error: 'virtual companion request failed' })
      }
    }
  }), 'virtual-companion: routes')
}
