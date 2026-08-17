/**
 * 虚拟伙伴插件，Host 半：
 * - 提供本地 REST 路由 `/virtual-companion`
 * - 复用 DSH 当前默认模型，通过 `ctx.llm.stream` 生成语音聊天回复
 * - 对话历史仅保存在内存，最多 20 条
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { appendTurn, ChatInputError, ChatReplyError, collectReply, normalizeChatText, streamReplyEvents } from './shared/chat.ts'
import { getRoleSystemPrompt, normalizeBackgroundText } from './shared/settings.ts'
import { CHAT_HISTORY_LIMIT, OPENING_REQUEST } from './shared/types.ts'
import { DEFAULT_VOICE_STYLE_ID, normalizeVoiceStyle } from './shared/voice.ts'
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

/**
 * 人物模型根目录：用户本地数据（默认 $DSH_HOME/storages/dsh-virtual-companion/
 * models）。模型版权规则禁止二次配布，因此不随 npm 包与 git 分发；
 * 用户自行放置 PMX/纹理后即可被客户端加载。
 */
function modelRoot (): string {
  const override = process.env.DSH_VIRTUAL_COMPANION_MODELS?.trim()
  if (override !== undefined && override !== '') return resolve(override)
  return resolve(resolveDshHome(undefined, process.env), 'storages', 'dsh-virtual-companion', 'models')
}

/** 模型展示名（目录 id → 中文名）。 */
const MODEL_LABELS: Record<string, string> = {
  ganyu: '甘雨',
  changye: '王昭君·长夜焕生',
  alice: '爱丽丝',
  qianxiao: '千咲',
  jialuo: '伽罗·最初的交响'
}

/** 模型静态资产内容类型（按扩展名）。 */
function modelContentType (path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.tga')) return 'image/x-tga'
  return 'application/octet-stream'
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

  // 连接预热：启动时静默合成一次，把 Edge 握手（约 0.8s）提前付掉，
  // 用户第一句话的首音延迟与后续一致。
  if (options.speechSynth === undefined) {
    void speechSynth.synthesize('…', DEFAULT_VOICE_STYLE_ID).catch(() => {
      // 预热失败不影响运行，首次合成时按需重建连接
    })
  }

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

        // 立绘资源：客户端 <img> 直接引用本包内打包的肖像图。
        if (parts[0] === 'virtual-companion' && parts[1] === 'portrait' && parts.length === 2 && method === 'GET') {
          const assetPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'portrait.png')
          try {
            const image = await readFile(assetPath)
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=86400',
              'Content-Length': image.length
            })
            res.end(image)
          } catch {
            sendJson(res, 404, { error: 'portrait asset missing' })
          }
          return
        }

        // 可用人物模型列表（含 model.pmx 的子目录）。
        if (parts[0] === 'virtual-companion' && parts[1] === 'models' && parts.length === 2 && method === 'GET') {
          try {
            const root = modelRoot()
            const entries = await readdir(root, { withFileTypes: true })
            const models: Array<{ id: string; label: string }> = []
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.name === 'motions') continue
              try {
                const info = await stat(resolve(root, entry.name, 'model.pmx'))
                if (info.isFile()) models.push({ id: entry.name, label: MODEL_LABELS[entry.name] ?? entry.name })
              } catch {
                // 没有 model.pmx 的目录不是模型
              }
            }
            models.sort((left, right) => left.id.localeCompare(right.id))
            sendJson(res, 200, { models })
          } catch {
            sendJson(res, 200, { models: [] })
          }
          return
        }

        // 人物模型资产（PMX/VMD/纹理）：从本地数据目录按相对路径提供。
        if (parts[0] === 'virtual-companion' && parts[1] === 'model' && parts.length >= 3 && method === 'GET') {
          let relativePath: string
          try {
            // URL.pathname 不会解码百分号编码，必须逐段 decodeURIComponent
            relativePath = parts.slice(2).map(segment => decodeURIComponent(segment)).join('/')
          } catch {
            sendJson(res, 400, { error: 'invalid model path' })
            return
          }
          const root = modelRoot()
          const target = resolve(root, relativePath)
          if (target !== root && !target.startsWith(root + sep)) {
            sendJson(res, 400, { error: 'invalid model path' })
            return
          }
          try {
            const data = await readFile(target)
            res.writeHead(200, {
              'Content-Type': modelContentType(target),
              'Cache-Control': 'public, max-age=86400',
              'Content-Length': data.length
            })
            res.end(data)
          } catch {
            sendJson(res, 404, { error: 'model asset not found' })
          }
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
            system: getRoleSystemPrompt(body?.role, normalizeBackgroundText(body?.background)),
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
            system: getRoleSystemPrompt(body?.role, normalizeBackgroundText(body?.background)),
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
          const system = getRoleSystemPrompt(body?.role, normalizeBackgroundText(body?.background))
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          })
          let fullReply = ''
          try {
            for await (const event of streamReplyEvents(ctx.llm.stream({
              provider: selection.provider,
              model: selection.model,
              messages,
              system,
              signal: AbortSignal.timeout(30_000)
            }))) {
              if (event.delta !== undefined) {
                fullReply += event.delta
                sendSseEvent(res, { delta: event.delta })
              }
              if (event.sentence !== undefined) {
                sendSseEvent(res, { sentence: event.sentence })
              }
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

        if (parts[0] === 'virtual-companion' && parts[1] === 'tts' && parts[2] === 'stream' && parts.length === 3 && method === 'GET') {
          const text = normalizeChatText(url.searchParams.get('text'))
          const voice = normalizeVoiceStyle(url.searchParams.get('voice'))
          if (speechSynth.stream === undefined) {
            sendJson(res, 501, { error: 'streaming TTS unavailable' })
            return
          }
          const audio = await speechSynth.stream(text, voice)
          res.writeHead(200, {
            'Content-Type': audio.contentType,
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no'
          })
          audio.stream.on('error', () => {
            if (!res.writableEnded) res.destroy()
          })
          res.on('close', () => {
            audio.stream.destroy()
          })
          audio.stream.pipe(res)
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
          process.stderr.write(`[dsh-virtual-companion] tts failed: ${safeDiagnostic(error)}\n`)
          sendJson(res, 502, { error: '语音合成暂时不可用，请稍后再试' })
          return
        }
        process.stderr.write(`[dsh-virtual-companion] request failed: ${safeDiagnostic(error)}\n`)
        sendJson(res, 500, { error: 'virtual companion request failed' })
      }
    }
  }), 'virtual-companion: routes')
}
