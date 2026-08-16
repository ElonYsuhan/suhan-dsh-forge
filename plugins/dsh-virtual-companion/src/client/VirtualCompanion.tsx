/**
 * 虚拟伙伴浮层组件：
 * - 注册在 `shell.overlay`，可拖拽到页面任意位置
 * - 使用 Three.js 渲染可切换的 3D 模型
 * - 支持鼠标悬浮互动、文字/语音聊天
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { COMPANION_MODELS, type CompanionModelKind } from '../three/companionModels.ts'
import { CompanionScene } from '../three/companionScene.ts'
import { DEFAULT_VOICE_STYLE_ID, normalizeVoiceStyle, VOICE_STYLES, type VoiceStyleId } from '../shared/voice.ts'
import css from './VirtualCompanion.module.css'

export type VirtualCompanionProps = ComposedProps<'shell.overlay', 'virtual-companion', never, undefined, object>

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

interface SpeechRecognitionAlternative {
  transcript: string
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: SpeechRecognitionAlternative
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>
}

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

interface SpeechRecognitionConstructorLike {
  new (): SpeechRecognitionLike
}

const POSITION_KEY = 'suhan-dsh-virtual-companion-position'
const MODEL_KEY = 'suhan-dsh-virtual-companion-model'
const VOICE_KEY = 'suhan-dsh-virtual-companion-voice'
const DEFAULT_POSITION = (): { x: number; y: number } => ({
  x: typeof window === 'undefined' ? 24 : Math.max(24, window.innerWidth - 280),
  y: 96
})

function readPosition (): { x: number; y: number } {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY)
    if (raw === null) return DEFAULT_POSITION()
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : DEFAULT_POSITION().x
    const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : DEFAULT_POSITION().y
    return { x, y }
  } catch {
    return DEFAULT_POSITION()
  }
}

function readModel (): CompanionModelKind {
  try {
    const stored = window.localStorage.getItem(MODEL_KEY)
    if (stored !== null && COMPANION_MODELS.some(entry => entry.id === stored)) {
      return stored as CompanionModelKind
    }
  } catch {
    // ignore storage failures and fall back to the default model
  }
  return 'human'
}

function readVoiceStyle (): VoiceStyleId {
  try {
    return normalizeVoiceStyle(window.localStorage.getItem(VOICE_KEY))
  } catch {
    // ignore storage failures and fall back to the default voice style
  }
  return DEFAULT_VOICE_STYLE_ID
}

function getSpeechRecognition (): SpeechRecognitionConstructorLike | undefined {
  const globalObject = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructorLike
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike
  }
  return globalObject.SpeechRecognition ?? globalObject.webkitSpeechRecognition
}

/**
 * Render the draggable companion overlay.
 * @param _props - composed slot props (this entry has no inject face).
 */
export function VirtualCompanion (_props: VirtualCompanionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<CompanionScene | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  const [position, setPosition] = useState(readPosition)
  const [model, setModel] = useState<CompanionModelKind>(readModel)
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyleId>(readVoiceStyle)
  const [hovered, setHovered] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [listening, setListening] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const scene = new CompanionScene(canvas, model)
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
    // The scene is created once; model changes are applied through setModel below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    sceneRef.current?.setModel(model)
  }, [model])

  useEffect(() => {
    sceneRef.current?.setHovered(hovered)
  }, [hovered])

  useEffect(() => {
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    } catch {
      // storage may be unavailable; drag still works for this session
    }
  }, [position])

  useEffect(() => {
    try {
      window.localStorage.setItem(MODEL_KEY, model)
    } catch {
      // storage may be unavailable; model still switches for this session
    }
  }, [model])

  useEffect(() => {
    try {
      window.localStorage.setItem(VOICE_KEY, voiceStyle)
    } catch {
      // storage may be unavailable; voice still switches for this session
    }
  }, [voiceStyle])

  const stopCurrentAudio = useCallback((): void => {
    const audio = audioRef.current
    if (audio !== null) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
    }
    if (audioUrlRef.current !== null) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
  }, [])

  useEffect(() => () => {
    recognitionRef.current?.abort()
    recognitionRef.current = null
    stopCurrentAudio()
  }, [stopCurrentAudio])

  const speak = useCallback(async (text: string): Promise<void> => {
    if (typeof window === 'undefined') return
    try {
      const response = await fetch('/virtual-companion/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceStyle })
      })
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const data = await response.json() as { error?: unknown }
          if (typeof data.error === 'string') message = data.error
        } catch {
          // keep the HTTP fallback message when the error body is not JSON
        }
        throw new Error(message)
      }
      const blob = await response.blob()
      if (blob.size === 0) throw new Error('语音合成返回空音频')
      stopCurrentAudio()
      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        if (audioRef.current === audio) {
          stopCurrentAudio()
        }
      }
      audio.onerror = () => {
        if (audioRef.current === audio) {
          setSpeechError('语音播放失败，请稍后重试')
          stopCurrentAudio()
        }
      }
      try {
        await audio.play()
      } catch (error) {
        if (audioRef.current === audio) {
          stopCurrentAudio()
        }
        throw error
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSpeechError(`语音合成失败：${message}`)
    }
  }, [stopCurrentAudio, voiceStyle])

  const sendText = useCallback(async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (text === '' || sending) return
    setMessages(previous => [...previous, { role: 'user', text }])
    setInput('')
    setSending(true)
    setSpeechError(null)
    try {
      const response = await fetch('/virtual-companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
      const data = await response.json() as { reply?: unknown; error?: unknown }
      if (!response.ok) {
        const message = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      const reply = typeof data.reply === 'string' ? data.reply : ''
      if (reply !== '') {
        setMessages(previous => [...previous, { role: 'assistant', text: reply }])
        void speak(reply)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMessages(previous => [...previous, { role: 'assistant', text: `（无法连接虚拟伙伴：${message}）` }])
    } finally {
      setSending(false)
    }
  }, [sending, speak])

  const startListening = useCallback((): void => {
    const SpeechRecognitionCtor = getSpeechRecognition()
    if (SpeechRecognitionCtor === undefined) {
      setSpeechError('当前浏览器不支持语音识别，请使用文字输入')
      return
    }
    setSpeechError(null)
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event): void => {
      const results: SpeechRecognitionResultLike[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        const item = event.results[index]
        if (item !== undefined) results.push(item)
      }
      const finalResult = results.find(result => result.isFinal)
      const transcript = finalResult?.[0]?.transcript ?? ''
      if (transcript !== '') {
        setInput(transcript)
        void sendText(transcript)
      }
    }
    recognition.onerror = (event): void => {
      setListening(false)
      setSpeechError(event.error ?? '语音识别失败')
      recognition.abort()
    }
    recognition.onend = (): void => {
      setListening(false)
    }
    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }, [sendText])

  const stopListening = useCallback((): void => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setListening(false)
  }, [])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [position])

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragStateRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    setPosition({
      x: Math.max(0, state.originX + event.clientX - state.startX),
      y: Math.max(0, state.originY + event.clientY - state.startY)
    })
  }, [])

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragStateRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    dragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleHeaderPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target
    if (target instanceof Element && target.closest('button, select, input') !== null) return
    startDrag(event)
  }, [startDrag])

  return (
    <div
      className={css.companion}
      style={{ left: position.x, top: position.y }}
      data-testid='virtual-companion'
    >
      <div
        className={css.header}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className={css.title}>虚拟伙伴</span>
        <select
          className={css.modelSelect}
          value={model}
          onChange={event => setModel(event.target.value as CompanionModelKind)}
          aria-label='切换模型'
          title='切换模型'
        >
          {COMPANION_MODELS.map(item => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <button
          type='button'
          className={css.chatToggle}
          onClick={() => setChatOpen(open => !open)}
          aria-expanded={chatOpen}
        >
          {chatOpen ? '收起' : '聊天'}
        </button>
      </div>

      <div
        className={css.stage}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <canvas ref={canvasRef} className={css.canvas} aria-label='3D 虚拟伙伴' />
        {hovered && <div className={css.bubble} role='status'>你好，我是你的虚拟伙伴！</div>}
      </div>

      {chatOpen && (
        <div className={css.chatPanel}>
          <div className={css.messages}>
            {messages.length === 0 && (
              <div className={css.empty}>点击麦克风或输入文字和我聊天吧</div>
            )}
            {messages.map((message, index) => (
              <div
                key={index}
                className={message.role === 'user' ? css.userMsg : css.assistantMsg}
              >
                {message.text}
              </div>
            ))}
          </div>
          <div className={css.voiceRow}>
            <label className={css.voiceLabel} htmlFor='virtual-companion-voice'>语音</label>
            <select
              id='virtual-companion-voice'
              className={css.voiceSelect}
              value={voiceStyle}
              onChange={event => setVoiceStyle(event.target.value as VoiceStyleId)}
              aria-label='切换语音'
              title='切换语音'
            >
              {VOICE_STYLES.map(style => (
                <option key={style.id} value={style.id} title={style.description}>{style.label}</option>
              ))}
            </select>
            <span className={css.voiceHint}>
              {VOICE_STYLES.find(style => style.id === voiceStyle)?.description ?? ''}
            </span>
          </div>
          {speechError !== null && <div className={css.error} role='alert'>{speechError}</div>}
          <div className={css.inputRow}>
            <input
              className={css.input}
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void sendText(input)
                }
              }}
              placeholder='输入消息…'
              disabled={sending}
              aria-label='聊天输入'
            />
            <button
              type='button'
              className={css.sendBtn}
              onClick={() => { void sendText(input) }}
              disabled={sending || input.trim() === ''}
            >
              {sending ? '…' : '发送'}
            </button>
            <button
              type='button'
              className={`${css.micBtn} ${listening ? css.micActive : ''}`}
              onClick={listening ? stopListening : () => { void startListening() }}
              disabled={sending}
              aria-label={listening ? '停止语音输入' : '开始语音输入'}
            >
              {listening ? '■' : '🎤'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
