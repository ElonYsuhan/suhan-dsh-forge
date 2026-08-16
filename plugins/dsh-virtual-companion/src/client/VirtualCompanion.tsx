/**
 * 虚拟人物浮层组件：
 * - 注册在 `shell.overlay`，可拖拽到页面任意位置
 * - 只保留“人物”一个 3D 模型，不再提供模型/语音/聊天操作面板
 * - 单击人物开始或停止语音聊天；模型会主动提问，用户用语音回答
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanionModelKind } from '../three/companionModels.ts'
import { CompanionScene } from '../three/companionScene.ts'
import { DEFAULT_VOICE_STYLE_ID } from '../shared/voice.ts'
import css from './VirtualCompanion.module.css'

export type VirtualCompanionProps = ComposedProps<'shell.overlay', 'virtual-companion', never, undefined, object>

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
const DRAG_THRESHOLD = 5
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
  const dragMovedRef = useRef(false)
  const interactingRef = useRef(false)
  const onSpeechEndRef = useRef<(() => void) | null>(null)
  const sendAnswerRef = useRef<(text: string) => void>(() => {})
  const beginListeningRef = useRef<() => void>(() => {})

  const [position, setPosition] = useState(readPosition)
  const [hovered, setHovered] = useState(false)
  const [interacting, setInteracting] = useState(false)
  const [listening, setListening] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [bubbleText, setBubbleText] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const scene = new CompanionScene(canvas, 'human' satisfies CompanionModelKind)
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

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
    interactingRef.current = false
    onSpeechEndRef.current = null
    recognitionRef.current?.abort()
    recognitionRef.current = null
    stopCurrentAudio()
  }, [stopCurrentAudio])

  const speak = useCallback(async (text: string, onDone?: () => void): Promise<void> => {
    if (typeof window === 'undefined') return
    try {
      const response = await fetch('/virtual-companion/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: DEFAULT_VOICE_STYLE_ID })
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
      if (!interactingRef.current) return
      stopCurrentAudio()
      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      onSpeechEndRef.current = onDone ?? null
      audio.onended = () => {
        if (audioRef.current === audio) {
          const done = onSpeechEndRef.current
          onSpeechEndRef.current = null
          stopCurrentAudio()
          done?.()
        }
      }
      audio.onerror = () => {
        if (audioRef.current === audio) {
          const done = onSpeechEndRef.current
          onSpeechEndRef.current = null
          setSpeechError('语音播放失败，请稍后重试')
          stopCurrentAudio()
          done?.()
        }
      }
      try {
        await audio.play()
      } catch (error) {
        if (audioRef.current === audio) {
          const done = onSpeechEndRef.current
          onSpeechEndRef.current = null
          stopCurrentAudio()
          done?.()
        }
        throw error
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSpeechError(`语音合成失败：${message}`)
      setBubbleText('语音合成失败，点击重新开始')
      interactingRef.current = false
      setInteracting(false)
      setListening(false)
      setThinking(false)
    }
  }, [stopCurrentAudio])

  const stopVoiceSession = useCallback((): void => {
    interactingRef.current = false
    setInteracting(false)
    setListening(false)
    setThinking(false)
    setBubbleText(null)
    onSpeechEndRef.current = null
    recognitionRef.current?.abort()
    recognitionRef.current = null
    stopCurrentAudio()
  }, [stopCurrentAudio])

  const sendAnswer = useCallback(async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (text === '' || !interactingRef.current) return
    setThinking(true)
    setListening(false)
    setSpeechError(null)
    setBubbleText('正在思考…')
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
      if (reply === '') throw new Error('模型返回空回复')
      setThinking(false)
      setBubbleText(null)
      if (interactingRef.current) {
        void speak(reply, () => {
          if (interactingRef.current) beginListeningRef.current()
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setThinking(false)
      setSpeechError(`聊天失败：${message}`)
      setBubbleText('聊天失败，点击重新开始')
      stopVoiceSession()
    }
  }, [speak, stopVoiceSession])

  const beginListening = useCallback((): void => {
    if (!interactingRef.current) return
    const SpeechRecognitionCtor = getSpeechRecognition()
    if (SpeechRecognitionCtor === undefined) {
      setSpeechError('当前浏览器不支持语音识别')
      setBubbleText('当前浏览器不支持语音识别')
      stopVoiceSession()
      return
    }
    setSpeechError(null)
    setBubbleText('我在听，请回答…')
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'zh-CN'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onresult = (event): void => {
      const results: SpeechRecognitionResultLike[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        const item = event.results[index]
        if (item !== undefined) results.push(item)
      }
      const finalResult = results.find(result => result.isFinal)
      const transcript = finalResult?.[0]?.transcript ?? ''
      if (transcript.trim() !== '') {
        recognition.stop()
        recognitionRef.current = null
        setListening(false)
        sendAnswerRef.current(transcript.trim())
      }
    }
    recognition.onerror = (event): void => {
      setListening(false)
      setSpeechError(event.error ?? '语音识别失败')
      setBubbleText('语音识别失败，点击重新开始')
      recognition.abort()
      if (interactingRef.current) stopVoiceSession()
    }
    recognition.onend = (): void => {
      setListening(false)
    }
    recognitionRef.current = recognition
    setListening(true)
    try {
      recognition.start()
    } catch {
      setListening(false)
      setSpeechError('语音识别启动失败')
      setBubbleText('语音识别启动失败，点击重新开始')
      stopVoiceSession()
    }
  }, [stopVoiceSession])

  sendAnswerRef.current = sendAnswer
  beginListeningRef.current = beginListening

  const startVoiceSession = useCallback((): void => {
    if (interactingRef.current) return
    if (getSpeechRecognition() === undefined) {
      setSpeechError('当前浏览器不支持语音识别')
      setBubbleText('当前浏览器不支持语音识别')
      return
    }
    interactingRef.current = true
    setInteracting(true)
    setListening(false)
    setThinking(true)
    setSpeechError(null)
    setBubbleText('正在开启语音聊天…')
    void (async () => {
      try {
        const response = await fetch('/virtual-companion/opening', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
        const data = await response.json() as { reply?: unknown; error?: unknown }
        if (!response.ok) {
          const message = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
          throw new Error(message)
        }
        const reply = typeof data.reply === 'string' ? data.reply : ''
        if (reply === '') throw new Error('模型没有返回开场白')
        setThinking(false)
        setBubbleText(null)
        if (interactingRef.current) {
          void speak(reply, () => {
            if (interactingRef.current) beginListeningRef.current()
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setThinking(false)
        setSpeechError(`无法开启语音聊天：${message}`)
        setBubbleText('无法开启语音聊天，点击重试')
        stopVoiceSession()
      }
    })()
  }, [speak, stopVoiceSession])

  const toggleVoiceSession = useCallback((): void => {
    if (interactingRef.current) {
      stopVoiceSession()
      setBubbleText('已停止语音聊天')
    } else {
      startVoiceSession()
    }
  }, [startVoiceSession, stopVoiceSession])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y
    }
    dragMovedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [position])

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragStateRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    const deltaX = event.clientX - state.startX
    const deltaY = event.clientY - state.startY
    if (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD) {
      dragMovedRef.current = true
    }
    setPosition({
      x: Math.max(0, state.originX + deltaX),
      y: Math.max(0, state.originY + deltaY)
    })
  }, [])

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragStateRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    dragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!dragMovedRef.current) {
      toggleVoiceSession()
    }
  }, [toggleVoiceSession])

  const statusText = speechError ?? bubbleText ?? (hovered ? '单击开始语音聊天' : null)

  return (
    <div
      className={css.companion}
      style={{ left: position.x, top: position.y }}
      data-testid='virtual-companion'
    >
      <div
        className={css.stage}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <canvas ref={canvasRef} className={css.canvas} aria-label='3D 虚拟人物' />
        {statusText !== null && <div className={css.bubble} role='status'>{statusText}</div>}
        {(listening || thinking || interacting) && (
          <div className={css.indicator} role='status'>
            {listening ? '🎤' : thinking ? '…' : interacting ? '●' : ''}
          </div>
        )}
      </div>
    </div>
  )
}
