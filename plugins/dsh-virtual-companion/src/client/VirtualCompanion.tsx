/**
 * 虚拟人物浮层组件：
 * - 注册在 `shell.overlay`，可拖拽到页面任意位置
 * - 单击人物开始或停止语音聊天；双击打开设置面板
 * - 人物形象为打包进插件的立绘 PNG（/virtual-companion/portrait），
 *   说话时以浮动缩放表达「在说话」；设置面板支持角色、背景、音色与流式回复
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BACKGROUND_TEXT_MAX_LENGTH,
  DEFAULT_SETTINGS,
  getChatBackground,
  getRolePreset,
  normalizeSettings,
  ROLE_PRESETS,
  type RoleId
} from '../shared/settings.ts'
import {
  VOICE_STYLES,
  type VoiceStyleId
} from '../shared/voice.ts'
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
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

interface SpeechRecognitionConstructorLike {
  new (): SpeechRecognitionLike
}

const POSITION_KEY = 'suhan-dsh-virtual-companion-position'
const SETTINGS_KEY = 'suhan-dsh-virtual-companion-settings'
const DRAG_THRESHOLD = 5
const SINGLE_CLICK_DELAY_MS = 260
/** 短于该长度的句子走流式接口（边合成边播放，首音延迟低）。 */
const TTS_STREAM_TEXT_MAX_LENGTH = 500

function buildTtsStreamUrl (text: string, voiceId: VoiceStyleId): string {
  const params = new URLSearchParams({ text, voice: voiceId })
  return `/virtual-companion/tts/stream?${params.toString()}`
}
/** 0.1s 静音 WAV：在用户手势中播放一次以解锁 Audio 元素的自动播放限制。 */
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='
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

function readSettings (): ReturnType<typeof normalizeSettings> {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (raw === null) return normalizeSettings(DEFAULT_SETTINGS)
    return normalizeSettings(JSON.parse(raw) as unknown)
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
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
  const stageRef = useRef<HTMLDivElement | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUnlockedRef = useRef(false)
  const audioUrlRef = useRef<string | null>(null)
  const noSpeechRetriesRef = useRef(0)
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
  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentenceQueueRef = useRef<string[]>([])
  const playingSentenceRef = useRef(false)
  const streamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const streamActiveRef = useRef(false)
  const playNextSentenceRef = useRef<() => void>(() => {})

  const [position, setPosition] = useState(readPosition)
  const [settings, setSettings] = useState(readSettings)
  const [panelOpen, setPanelOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [interacting, setInteracting] = useState(false)
  const [listening, setListening] = useState(false)
  const [speechDetected, setSpeechDetected] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [bubbleText, setBubbleText] = useState<string | null>(null)

  // 唯一的 Audio 元素：浏览器要求媒体播放由用户手势解锁，元素在挂载时
  // 创建、在首次指针交互时播放一次静音片段完成解锁，之后复用播放所有句子。
  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (audioRef.current === audio) audioRef.current = null
    }
  }, [])

  const unlockAudio = useCallback((): void => {
    const audio = audioRef.current
    if (audio === null || audioUnlockedRef.current) return
    void (async () => {
      try {
        audio.src = SILENT_WAV
        await audio.play()
        audioUnlockedRef.current = true
      } catch {
        // 静音解锁失败不阻断交互；正式播放失败会走现有错误提示
      }
    })()
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    } catch {
      // storage may be unavailable; drag still works for this session
    }
  }, [position])

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // storage may be unavailable; settings still apply for this session
    }
  }, [settings])

  const stopCurrentAudio = useCallback((): void => {
    setSpeaking(false)
    const audio = audioRef.current
    if (audio !== null) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    if (audioUrlRef.current !== null) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
  }, [])

  useEffect(() => () => {
    if (singleClickTimerRef.current !== null) {
      clearTimeout(singleClickTimerRef.current)
      singleClickTimerRef.current = null
    }
    streamReaderRef.current?.cancel().catch(() => {})
    streamReaderRef.current = null
    streamActiveRef.current = false
    interactingRef.current = false
    onSpeechEndRef.current = null
    recognitionRef.current?.abort()
    recognitionRef.current = null
    sentenceQueueRef.current = []
    playingSentenceRef.current = false
    stopCurrentAudio()
  }, [stopCurrentAudio])

  const speak = useCallback(async (text: string, onDone?: () => void): Promise<void> => {
    if (typeof window === 'undefined') return
    try {
      if (!interactingRef.current) return
      stopCurrentAudio()
      const audio = audioRef.current
      if (audio === null) throw new Error('音频播放器未就绪')
      // 短句走流式接口：Edge 边合成边播放，首音延迟低、体验流畅；
      // 长句走缓冲 POST，避免超长 URL。
      if (text.length <= TTS_STREAM_TEXT_MAX_LENGTH) {
        audio.src = buildTtsStreamUrl(text, settings.voiceId)
        audioUrlRef.current = null
      } else {
        const response = await fetch('/virtual-companion/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: settings.voiceId })
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
        audio.src = url
      }
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
        setSpeaking(true)
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
      streamReaderRef.current?.cancel().catch(() => {})
      streamReaderRef.current = null
      streamActiveRef.current = false
      sentenceQueueRef.current = []
      playingSentenceRef.current = false
      interactingRef.current = false
      setInteracting(false)
      setListening(false)
      setThinking(false)
    }
  }, [settings.voiceId, stopCurrentAudio])

  const stopVoiceSession = useCallback((): void => {
    if (singleClickTimerRef.current !== null) {
      clearTimeout(singleClickTimerRef.current)
      singleClickTimerRef.current = null
    }
    streamReaderRef.current?.cancel().catch(() => {})
    streamReaderRef.current = null
    streamActiveRef.current = false
    sentenceQueueRef.current = []
    playingSentenceRef.current = false
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

  const playNextSentence = useCallback((): void => {
    if (playingSentenceRef.current) return
    const sentence = sentenceQueueRef.current.shift()
    if (sentence === undefined) {
      if (interactingRef.current && !streamActiveRef.current) beginListeningRef.current()
      return
    }
    playingSentenceRef.current = true
    void speak(sentence, () => {
      playingSentenceRef.current = false
      if (interactingRef.current) playNextSentenceRef.current()
    })
  }, [speak])

  playNextSentenceRef.current = playNextSentence

  const sendAnswer = useCallback(async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (text === '' || !interactingRef.current) return
    setThinking(true)
    setListening(false)
    setSpeechError(null)
    setBubbleText(null)
    sentenceQueueRef.current = []
    playingSentenceRef.current = false
    try {
      if (settings.realtime) {
        const response = await fetch('/virtual-companion/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, role: settings.roleId, background: settings.backgroundText })
        })
        if (!response.ok) {
          const data = await response.json() as { error?: unknown }
          const message = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
          throw new Error(message)
        }
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error('当前浏览器不支持流式响应')
        streamReaderRef.current = reader
        streamActiveRef.current = true
        const decoder = new TextDecoder()
        let buffer = ''
        let streamed = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let newlineIndex = buffer.indexOf('\n')
            while (newlineIndex >= 0) {
              const line = buffer.slice(0, newlineIndex).trim()
              buffer = buffer.slice(newlineIndex + 1)
              if (line.startsWith('data: ')) {
                const data = JSON.parse(line.slice(6)) as { delta?: unknown; sentence?: unknown; done?: unknown; error?: unknown }
                if (typeof data.error === 'string') throw new Error(data.error)
                if (typeof data.delta === 'string' && data.delta.length > 0) {
                  streamed += data.delta
                }
                if (typeof data.sentence === 'string' && data.sentence.length > 0) {
                  sentenceQueueRef.current.push(data.sentence)
                  playNextSentenceRef.current()
                }
                if (data.done === true) {
                  streamReaderRef.current = null
                  break
                }
              }
              newlineIndex = buffer.indexOf('\n')
            }
            if (streamReaderRef.current === null) break
          }
        } finally {
          streamReaderRef.current = null
          streamActiveRef.current = false
        }
        if (streamed.trim() === '') throw new Error('模型返回空回复')
        setThinking(false)
        if (interactingRef.current && sentenceQueueRef.current.length === 0 && !playingSentenceRef.current) {
          beginListeningRef.current()
        }
      } else {
        const response = await fetch('/virtual-companion/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, role: settings.roleId, background: settings.backgroundText })
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
      }
    } catch (error) {
      if (!interactingRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setThinking(false)
      setSpeechError(`聊天失败：${message}`)
      setBubbleText('聊天失败，点击重新开始')
      stopVoiceSession()
    }
  }, [settings.realtime, settings.roleId, settings.backgroundText, speak, stopVoiceSession])

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
    setBubbleText(null)
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'zh-CN'
    recognition.interimResults = false
    recognition.continuous = false
    let resultReceived = false
    let handledByError = false
    recognition.onresult = (event): void => {
      const results: SpeechRecognitionResultLike[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        const item = event.results[index]
        if (item !== undefined) results.push(item)
      }
      const finalResult = results.find(result => result.isFinal)
      const transcript = finalResult?.[0]?.transcript ?? ''
      if (transcript.trim() !== '') {
        resultReceived = true
        noSpeechRetriesRef.current = 0
        recognition.stop()
        recognitionRef.current = null
        setListening(false)
        sendAnswerRef.current(transcript.trim())
      }
    }
    recognition.onerror = (event): void => {
      const error = event.error ?? 'unknown'
      handledByError = true
      setSpeechDetected(false)
      recognition.abort()
      // 我们自己调用的 abort 会产生 aborted 错误，忽略不计
      if (error === 'aborted') return
      // no-speech：窗口期内没听到说话。先友好重听两次，仍无声才结束
      if (error === 'no-speech') {
        const retries = noSpeechRetriesRef.current
        if (retries < 2) {
          noSpeechRetriesRef.current = retries + 1
          setListening(false)
          setBubbleText('没听清，请再说一次～')
          window.setTimeout(() => {
            if (interactingRef.current) beginListeningRef.current()
          }, 400)
          return
        }
        setSpeechError('一直没有听到声音')
        setBubbleText('没有听到声音，先结束聊天啦；点我重新开始')
        if (interactingRef.current) stopVoiceSession()
        return
      }
      const message = error === 'not-allowed'
        ? '麦克风权限未开启，请在浏览器设置中允许麦克风访问'
        : error === 'network'
          ? '语音识别服务不可用，请稍后重试'
          : `语音识别失败：${error}`
      setListening(false)
      setSpeechError(message)
      setBubbleText(message)
      if (interactingRef.current) stopVoiceSession()
    }
    recognition.onspeechstart = (): void => {
      setSpeechDetected(true)
    }
    recognition.onspeechend = (): void => {
      setSpeechDetected(false)
    }
    recognition.onend = (): void => {
      setListening(false)
      setSpeechDetected(false)
      if (handledByError || resultReceived) return
      // 说话停顿导致的自然结束（非出错、非识别到内容）：
      // 继续监听，用户停顿后还能接着说。
      if (interactingRef.current && recognitionRef.current === recognition) {
        window.setTimeout(() => {
          if (interactingRef.current && recognitionRef.current === recognition) {
            beginListeningRef.current()
          }
        }, 250)
      }
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
    noSpeechRetriesRef.current = 0
    setInteracting(true)
    setListening(false)
    setThinking(true)
    setSpeechError(null)
    setBubbleText(null)
    void (async () => {
      try {
        const response = await fetch('/virtual-companion/opening', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: settings.roleId, background: settings.backgroundText })
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
  }, [settings.roleId, settings.backgroundText, speak, stopVoiceSession])

  const toggleVoiceSession = useCallback((): void => {
    if (interactingRef.current) {
      stopVoiceSession()
      setBubbleText('已停止语音聊天')
    } else {
      startVoiceSession()
    }
  }, [startVoiceSession, stopVoiceSession])

  const openSettings = useCallback((): void => {
    setPanelOpen(true)
    setBubbleText(null)
  }, [])

  const closeSettings = useCallback((): void => {
    setPanelOpen(false)
  }, [])

  const handleStageClick = useCallback((): void => {
    if (panelOpen) {
      closeSettings()
      return
    }
    if (singleClickTimerRef.current !== null) {
      clearTimeout(singleClickTimerRef.current)
      singleClickTimerRef.current = null
      openSettings()
      return
    }
    singleClickTimerRef.current = setTimeout(() => {
      singleClickTimerRef.current = null
      toggleVoiceSession()
    }, SINGLE_CLICK_DELAY_MS)
  }, [closeSettings, openSettings, panelOpen, toggleVoiceSession])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    unlockAudio()
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y
    }
    dragMovedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [position, unlockAudio])

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragStateRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    const deltaX = event.clientX - state.startX
    const deltaY = event.clientY - state.startY
    if (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD) {
      dragMovedRef.current = true
    }
    // 钳制在视口内：四周留 8px 余量，防止人物被拖出屏幕外
    const bounds = stageRef.current?.getBoundingClientRect()
    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - (bounds?.width ?? 150) - margin)
    const maxY = Math.max(margin, window.innerHeight - (bounds?.height ?? 268) - margin)
    setPosition({
      x: Math.min(maxX, Math.max(margin, state.originX + deltaX)),
      y: Math.min(maxY, Math.max(margin, state.originY + deltaY))
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
      handleStageClick()
    }
  }, [handleStageClick])

  const activeChat = interacting || listening || thinking
  const statusText = speechError ?? bubbleText ?? (hovered && !activeChat ? '单击语音，双击设置' : null)
  const activeBackground = getChatBackground(settings.backgroundId)
  const activeRole = getRolePreset(settings.roleId)

  return (
    <div
      className={css.companion}
      style={{ left: position.x, top: position.y }}
      data-testid='virtual-companion'
    >
      <div
        ref={stageRef}
        className={`${css.stage} ${speaking ? css.speaking : ''} ${hovered ? css.hovered : ''}`}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <img
          className={css.portrait}
          src='/virtual-companion/portrait'
          alt='虚拟伙伴立绘'
          draggable={false}
        />
        {statusText !== null && (
          <div className={css.bubble} style={{ background: activeBackground.css, color: activeBackground.textColor }} role='status'>{statusText}</div>
        )}
        {(listening || thinking) && (
          <div className={`${css.indicator} ${listening ? (speechDetected ? css.hearing : css.listening) : ''}`} role='status'>🤔</div>
        )}
      </div>
      {panelOpen && (
        <div
          className={css.panel}
          style={{ background: activeBackground.css, color: activeBackground.textColor }}
          role='dialog'
          aria-label='虚拟人物设置'
        >
          <div className={css.panelHeader}>
            <span>虚拟人物设置</span>
            <button className={css.closeButton} type='button' onClick={closeSettings} aria-label='关闭设置'>×</button>
          </div>
          <label className={css.field}>
            <span>人物角色：{activeRole.label}</span>
            <select
              value={settings.roleId}
              onChange={(event) => setSettings({ ...settings, roleId: event.target.value as RoleId })}
            >
              {ROLE_PRESETS.map(role => (
                <option key={role.id} value={role.id}>{role.label} - {role.description}</option>
              ))}
            </select>
          </label>
          <label className={css.field}>
            <span>音色</span>
            <select
              value={settings.voiceId}
              onChange={(event) => setSettings({ ...settings, voiceId: event.target.value as VoiceStyleId })}
            >
              {VOICE_STYLES.map(voice => (
                <option key={voice.id} value={voice.id}>{voice.label} - {voice.description}</option>
              ))}
            </select>
          </label>
          <label className={css.field}>
            <span>背景信息（自己设置）</span>
            <textarea
              value={settings.backgroundText}
              maxLength={BACKGROUND_TEXT_MAX_LENGTH}
              rows={3}
              placeholder='例如：我们在一个洒满星光的森林里聊天……'
              onChange={(event) => setSettings({ ...settings, backgroundText: event.target.value })}
            />
          </label>
          <label className={css.field}>
            <span>流式实时回复</span>
            <input
              type='checkbox'
              checked={settings.realtime}
              onChange={(event) => setSettings({ ...settings, realtime: event.target.checked })}
            />
          </label>
          <div className={css.panelHint}>双击人物打开此面板，单击开始/停止语音聊天</div>
        </div>
      )}
    </div>
  )
}
