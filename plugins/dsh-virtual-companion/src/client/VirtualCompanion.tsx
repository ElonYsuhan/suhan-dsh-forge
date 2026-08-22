/**
 * 虚拟人物浮层组件：
 * - 注册在 `shell.overlay`，可拖拽到页面任意位置
 * - 单击人物开始或停止语音聊天；双击打开设置面板
 * - 人物形象为打包进插件的立绘 PNG（/virtual-companion/portrait），
 *   说话时以浮动缩放表达「在说话」；设置面板支持角色、背景、音色与流式回复
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
// Reka UI 系组件（Radix 同源）：Select 原生支持上下键/首字母选择，
// 每次选择立即触发 onValueChange，模型下拉实现逐项实时切换。
import * as Select from '@radix-ui/react-select'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BACKGROUND_TEXT_MAX_LENGTH,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DEFAULT_SETTINGS,
  FACE_LIGHT_MAX,
  FACE_LIGHT_MIN,
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
import { MMDCompanion, type GestureName } from '../three/MMDCompanion.ts'
import css from './VirtualCompanion.module.css'

/** 本地行为规则：关键词 → 手势，毫秒级触发，不等待 LLM。 */
const BEHAVIOR_RULES: Array<{ pattern: RegExp; gesture: GestureName }> = [
  { pattern: /你好|您好|嗨|哈喽|早上好|晚上好|hello|hi/i, gesture: 'wave' },
  { pattern: /谢谢|感谢|辛苦/i, gesture: 'nod' },
  { pattern: /不知道|不清楚/i, gesture: 'shake' },
  { pattern: /为什么|怎么|什么|吗[？?]/i, gesture: 'tilt' },
  { pattern: /开心|高兴|太好了|真棒|厉害/i, gesture: 'smile' },
  { pattern: /再见|拜拜|晚安/i, gesture: 'wave' },
  { pattern: /对不起|抱歉|致歉/i, gesture: 'bow' }
]

function gestureFor (text: string): GestureName | undefined {
  for (const rule of BEHAVIOR_RULES) {
    if (rule.pattern.test(text)) return rule.gesture
  }
  return undefined
}

/** LLM 情绪标签 → 手势（复杂语义动作由模型标注，本地映射）。 */
const EMOTION_GESTURES: Record<string, GestureName> = {
  微笑: 'smile',
  开心: 'smile',
  害羞: 'smile',
  惊讶: 'shake',
  难过: 'bow',
  思考: 'tilt',
  认真: 'nod'
}

/** 拆解句子开头的【情绪】标签；返回情绪手势与清洗后的朗读文本。 */
function extractEmotion (text: string): { emotion: GestureName | undefined; clean: string } {
  const match = /^【([^】]{1,6})】/.exec(text)
  const label = match?.[1]
  if (match === null || label === undefined) return { emotion: undefined, clean: text }
  const emotion = EMOTION_GESTURES[label]
  return { emotion, clean: text.slice(match[0].length).trimStart() }
}

interface PanelSelectProps {
  value: string
  onValueChange: (value: string) => void
  ariaLabel: string
  items: Array<{ value: string; label: string }>
  disabled?: boolean
  testId?: string
}

/**
 * 设置面板统一下拉（Reka UI / Radix Select）：
 * 触发器聚焦后 ↑/↓ 键即可逐项切换，每次变化立即回调 onValueChange
 * （模型下拉借此实现上下键逐项实时换模）。
 */
function PanelSelect ({ value, onValueChange, ariaLabel, items, disabled, testId }: PanelSelectProps) {
  return (
    <Select.Root value={value} onValueChange={onValueChange} {...(disabled === true ? { disabled: true } : {})}>
      <Select.Trigger className={css.selectTrigger} aria-label={ariaLabel} data-testid={testId}>
        <Select.Value />
        <Select.Icon className={css.selectIcon}>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={css.selectContent} position='popper' sideOffset={4}>
          <Select.Viewport className={css.selectViewport}>
            {items.map(item => (
              <Select.Item key={item.value} value={item.value} className={css.selectItem}>
                <Select.ItemText>{item.label}</Select.ItemText>
                <Select.ItemIndicator className={css.selectItemIndicator}>✓</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

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
/** 画布基准尺寸；滚轮缩放即放大画布 DOM，模型随之同步放大。 */
const BASE_STAGE_WIDTH = 260
const BASE_STAGE_HEIGHT = 440

/** 去掉空白与标点，便于回声文本比对。 */
function normalizeForMatch (value: string): string {
  return value.replace(/[\s，。！？、,.!?~～…"“”'‘’：:；;（）()]/g, '')
}

/** 字符二元组 Dice 相似度：判断识别结果是否疑似她自己朗读的回声。 */
function similarity (left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return 0
  const grams = (value: string): Set<string> => {
    const set = new Set<string>()
    for (let index = 0; index < value.length - 1; index++) {
      set.add(value.slice(index, index + 2))
    }
    return set
  }
  const leftGrams = grams(left)
  const rightGrams = grams(right)
  let hits = 0
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) hits += 1
  }
  return (2 * hits) / (leftGrams.size + rightGrams.size)
}
/** 0.1s 静音 WAV：在用户手势中播放一次以解锁 Audio 元素的自动播放限制。 */
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='
const DEFAULT_POSITION = (): { x: number; y: number } => ({
  x: typeof window === 'undefined' ? 24 : Math.max(24, window.innerWidth - 360),
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const mmdRef = useRef<MMDCompanion | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUnlockedRef = useRef(false)
  const audioUrlRef = useRef<string | null>(null)
  const noSpeechRetriesRef = useRef(0)
  const backgroundRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const lastSpokenTextsRef = useRef<string[]>([])
  const ttsCacheRef = useRef(new Map<string, Blob>())
  const prefetchInFlightRef = useRef(new Set<string>())
  const lastGestureAtRef = useRef(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    mode: 'move' | 'rotate'
    lastX: number
    lastY: number
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
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const [motionReady, setMotionReady] = useState(false)
  const [motionStatus, setMotionStatus] = useState<'stopped' | 'playing' | 'paused'>('stopped')
  const [selectedMotion, setSelectedMotion] = useState('stand')
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [ikDiag, setIkDiag] = useState<string>('')
  const [bubbleText, setBubbleText] = useState<string | null>(null)
  // 人物朝向（度，0 = 正面），面板滑块与右键拖拽共用
  const [yawDeg, setYawDeg] = useState(0)

  // MMD 人物模型场景：挂载时创建，模型切换时重新加载；
  // 加载期间立绘占位，失败时保持立绘不受影响。
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    let disposed = false
    const mmd = new MMDCompanion(canvas, {
      onStatus: (status) => {
        if (disposed) return
        setModelReady(status === 'ready')
      }
    })
    mmdRef.current = mmd
    mmd.start()
    return () => {
      disposed = true
      mmdRef.current = null
      mmd.dispose()
    }
  }, [])

  useEffect(() => {
    const mmd = mmdRef.current
    if (mmd === null) return
    setModelReady(false)
    setMotionReady(false)
    setMotionStatus('stopped')
    void (async () => {
      try {
        await mmd.loadModel(
          `/virtual-companion/model/${encodeURIComponent(settings.modelId)}/model.pmx`,
          `/virtual-companion/model/${encodeURIComponent('motions')}/${encodeURIComponent('表情.vmd')}`
        )
        // 默认站姿由模型加载阶段写入稳定骨骼偏移；动作只在用户选择后加载。
        setSelectedMotion('stand')
        setMotionStatus('stopped')
        setMotionReady(true)
      } catch (error) {
        // 模型缺失/损坏时退回立绘展示；动作缺失时模型仍可使用默认待机。
        console.warn('[virtual-companion] 模型或本地动作加载失败：', error)
      }
    })()
  }, [settings.modelId])

  // 说话状态同步给模型（口型）
  useEffect(() => {
    mmdRef.current?.setSpeaking(speaking)
  }, [speaking])

  // 单次动作播完后播放器会自行停止；同步按钮与状态文案。
  useEffect(() => {
    if (!motionReady) return
    const id = window.setInterval(() => {
      setMotionStatus(mmdRef.current?.getMotionStatus() ?? 'stopped')
    }, 200)
    return () => window.clearInterval(id)
  }, [motionReady])

  // 姿态诊断读数：手/肘世界位置 + 近 90 帧最大帧位移（排查抖动用）
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = mmdRef.current?.getIkDiagnostics()
      if (d === null || d === undefined) {
        setIkDiag('')
        return
      }
      const fmt = (v: number[]) => v.map(x => x.toFixed(2)).join(', ')
      setIkDiag(`手 L(${fmt(d.leftHand)}) R(${fmt(d.rightHand)}) 肘 L(${fmt(d.leftElbow)}) R(${fmt(d.rightElbow)}) 肘角 ${d.leftAngleDeg}°/${d.rightAngleDeg}° 帧位移 手${d.maxHandStep} 肘${d.maxElbowStep}（${d.samples} 帧窗口）`)
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  // 亮度设置同步给模型
  useEffect(() => {
    mmdRef.current?.setBrightness(settings.brightness)
  }, [settings.brightness])

  // 面部光强度同步给模型
  useEffect(() => {
    mmdRef.current?.setFaceLight(settings.faceLight)
  }, [settings.faceLight])

  // 聆听状态同步给模型（思考表情）
  useEffect(() => {
    mmdRef.current?.setThinking(listening)
  }, [listening])

  // 全局视线跟随：监听整个窗口的指针移动，按「指针相对人物中心的
  // 方向」计算头部朝向，指针越远偏转越大（在模型侧饱和）
  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const stage = stageRef.current
      if (stage === null) return
      const rect = stage.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const nx = (event.clientX - centerX) / Math.max(1, window.innerWidth / 2)
      const ny = (event.clientY - centerY) / Math.max(1, window.innerHeight / 2)
      mmdRef.current?.setLookTarget(nx, ny)
    }
    window.addEventListener('pointermove', onPointerMove)
    return () => window.removeEventListener('pointermove', onPointerMove)
  }, [])

  // 滚轮缩放：画布 DOM 与模型同步放大，最大高度=整个网页高度
  const [zoomLevel, setZoomLevel] = useState(1)
  const maxStageHeight = typeof window === 'undefined' ? BASE_STAGE_HEIGHT : window.innerHeight - 16
  const stageHeight = Math.min(Math.round(BASE_STAGE_HEIGHT * zoomLevel), maxStageHeight)
  const stageWidth = Math.round(BASE_STAGE_WIDTH * (stageHeight / BASE_STAGE_HEIGHT))

  const changeZoom = useCallback((factor: number): void => {
    setZoomLevel(level => Math.min(Math.max(level * factor, 0.3), Math.max(0.3, maxStageHeight / BASE_STAGE_HEIGHT)))
  }, [maxStageHeight])

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      changeZoom(event.deltaY > 0 ? 1 / 1.1 : 1.1)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [changeZoom])

  // 画布尺寸变化：重设渲染尺寸，并把位置钳回视口内
  useEffect(() => {
    mmdRef.current?.resize()
    const margin = 8
    const maxX = Math.max(margin, window.innerWidth - stageWidth - margin)
    const maxY = Math.max(margin, window.innerHeight - stageHeight - margin)
    setPosition(current => ({
      x: Math.min(Math.max(current.x, margin), maxX),
      y: Math.min(Math.max(current.y, margin), maxY)
    }))
  }, [stageWidth, stageHeight])

  // 设置面板：默认在画布外侧（右侧放不下翻到左侧）；拖拽后变为
  // 全屏自由浮动（绝对坐标，钳制在视口内）
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [panelPosition, setPanelPosition] = useState<{ x: number; y: number } | null>(null)
  const panelDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const PANEL_WIDTH = 280
  const PANEL_GAP = 12
  const panelOnLeft = position.x + stageWidth + PANEL_WIDTH + PANEL_GAP > window.innerWidth
  const panelDefaultLeft = panelOnLeft ? -PANEL_WIDTH - PANEL_GAP : stageWidth + PANEL_GAP
  const panelLeft = panelPosition?.x ?? panelDefaultLeft
  const panelTop = panelPosition?.y ?? 0

  const startPanelDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const rect = panelRef.current?.getBoundingClientRect()
    // 面板定位是相对 .companion 的，拖拽原点需换算回相对坐标
    panelDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: (rect?.left ?? 0) - position.x,
      originY: (rect?.top ?? 0) - position.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [position])

  const movePanelDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = panelDragRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    const width = panelRef.current?.offsetWidth ?? PANEL_WIDTH
    const height = panelRef.current?.offsetHeight ?? 260
    // 相对坐标下的视口钳制（companion 位置补偿）
    const minX = 8 - position.x
    const minY = 8 - position.y
    const maxX = window.innerWidth - width - 8 - position.x
    const maxY = window.innerHeight - height - 8 - position.y
    setPanelPosition({
      x: Math.min(Math.max(state.originX + (event.clientX - state.startX), minX), maxX),
      y: Math.min(Math.max(state.originY + (event.clientY - state.startY), minY), maxY)
    })
  }, [position])

  const endPanelDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = panelDragRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    panelDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  // 可用模型列表（设置面板选择器）
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; label: string }>>([])
  const [motionOptions, setMotionOptions] = useState<Array<{ id: string; label: string; url: string }>>([])
  useEffect(() => {
    void fetch('/virtual-companion/models')
      .then(async response => response.json())
      .then((data: { models?: Array<{ id: string; label: string }> }) => {
        setModelOptions(data.models ?? [])
      })
      .catch(() => {
        // 列表获取失败时选择器退回显示当前模型 id
      })
  }, [])

  useEffect(() => {
    void fetch('/virtual-companion/motions')
      .then(async response => response.json())
      .then((data: { motions?: Array<{ id: string; label: string; url: string }> }) => {
        setMotionOptions(data.motions ?? [])
      })
      .catch(() => {
        // 本地动作目录缺失时保留默认站姿
      })
  }, [])

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
        // 建立 WebAudio 分析链（元素只能接一次），供音量 LipSync
        if (audioCtxRef.current === null) {
          const ctx = new AudioContext()
          const source = ctx.createMediaElementSource(audio)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          source.connect(analyser)
          analyser.connect(ctx.destination)
          void ctx.resume()
          audioCtxRef.current = ctx
          analyserRef.current = analyser
          analyserDataRef.current = new Uint8Array(analyser.fftSize)
        }
      } catch {
        // 静音解锁失败不阻断交互；正式播放失败会走现有错误提示
      }
    })()
  }, [])

  // 音量包络循环：说话时把 RMS 同步给模型驱动口型张合
  useEffect(() => {
    let rafId = 0
    const tick = (): void => {
      rafId = requestAnimationFrame(tick)
      const analyser = analyserRef.current
      const data = analyserDataRef.current
      if (analyser === null || data === null) return
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let index = 0; index < data.length; index++) {
        const value = ((data[index] ?? 128) - 128) / 128
        sum += value * value
      }
      const rms = Math.sqrt(sum / data.length)
      mmdRef.current?.setSpeechLevel(Math.min(1, rms * 4))
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  /** 行为规则触发手势：900ms 节流，本地毫秒级生效。 */
  const triggerGesture = useCallback((text: string): void => {
    const gesture = gestureFor(text)
    if (gesture === undefined) return
    const now = Date.now()
    if (now - lastGestureAtRef.current < 900) return
    lastGestureAtRef.current = now
    mmdRef.current?.playGesture(gesture)
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

  /** 停止她说话期间的后台聆听。 */
  const stopBackgroundListening = useCallback((): void => {
    const recognition = backgroundRecognitionRef.current
    if (recognition !== null) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.abort()
      backgroundRecognitionRef.current = null
    }
  }, [])

  /** 她说话期间的后台聆听：检测到你的声音立即打断她并接管对话。 */
  const startBackgroundListening = useCallback((): void => {
    if (!interactingRef.current) return
    stopBackgroundListening()
    const SpeechRecognitionCtor = getSpeechRecognition()
    if (SpeechRecognitionCtor === undefined) return
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
      if (transcript.trim() === '') return
      // 防回声：识别结果与她最近朗读过的句子高度相似时视为回声忽略。
      // 回声可能在下一条句子的播放期间才被识别，因此对比最近几句。
      const heard = normalizeForMatch(transcript)
      if (heard.length < 2) return
      const echoLike = lastSpokenTextsRef.current.some(spoken => similarity(spoken, heard) >= 0.45)
      if (echoLike) return
      stopBackgroundListening()
      sentenceQueueRef.current = []
      playingSentenceRef.current = false
      stopCurrentAudio()
      setListening(false)
      sendAnswerRef.current(transcript.trim())
    }
    recognition.onerror = () => {
      if (backgroundRecognitionRef.current === recognition) {
        backgroundRecognitionRef.current = null
      }
    }
    recognition.onend = () => {
      if (backgroundRecognitionRef.current === recognition) {
        backgroundRecognitionRef.current = null
      }
    }
    backgroundRecognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      backgroundRecognitionRef.current = null
    }
  }, [stopCurrentAudio])

  /** 合成并缓存一句语音；缓存命中直接复用（同句不回炉）。 */
  const synthesizeSentence = useCallback(async (text: string): Promise<Blob> => {
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
    return blob
  }, [settings.voiceId])

  /** 后台预生成队列中下一句的语音，播放到时零合成延迟。 */
  const prefetchNextSentence = useCallback((): void => {
    const next = sentenceQueueRef.current[0]
    if (next === undefined) return
    if (ttsCacheRef.current.has(next) || prefetchInFlightRef.current.has(next)) return
    prefetchInFlightRef.current.add(next)
    void synthesizeSentence(next)
      .then(blob => {
        ttsCacheRef.current.set(next, blob)
        if (ttsCacheRef.current.size > 6) {
          const oldest = ttsCacheRef.current.keys().next().value
          if (oldest !== undefined) ttsCacheRef.current.delete(oldest)
        }
      })
      .catch(() => {
        // 预生成失败不影响主流程，播放时重新合成
      })
      .finally(() => {
        prefetchInFlightRef.current.delete(next)
      })
  }, [synthesizeSentence])

  const speak = useCallback(async (text: string, onDone?: () => void): Promise<void> => {
    if (typeof window === 'undefined') return
    try {
      if (!interactingRef.current) return
      // 情绪标签优先（LLM 语义动作），本地规则兜底
      const { emotion, clean } = extractEmotion(text)
      if (emotion !== undefined) {
        mmdRef.current?.playGesture(emotion)
      } else {
        triggerGesture(clean)
      }
      stopCurrentAudio()
      const audio = audioRef.current
      if (audio === null) throw new Error('音频播放器未就绪')
      const blob = ttsCacheRef.current.get(clean) ?? await synthesizeSentence(clean)
      ttsCacheRef.current.set(clean, blob)
      if (!interactingRef.current) return
      stopCurrentAudio()
      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url
      audio.src = url
      // 记录最近朗读的句子（最多 3 句），供后台聆听做回声过滤
      const spokenNorm = normalizeForMatch(clean)
      if (spokenNorm.length >= 2) {
        lastSpokenTextsRef.current = [...lastSpokenTextsRef.current, spokenNorm].slice(-3)
      }
      onSpeechEndRef.current = onDone ?? null
      audio.onended = () => {
        if (audioRef.current === audio) {
          const done = onSpeechEndRef.current
          onSpeechEndRef.current = null
          stopBackgroundListening()
          stopCurrentAudio()
          // 预生成下一句，消除句间合成空隙
          prefetchNextSentence()
          done?.()
        }
      }
      audio.onerror = () => {
        if (audioRef.current === audio) {
          const done = onSpeechEndRef.current
          onSpeechEndRef.current = null
          stopBackgroundListening()
          setSpeechError('语音播放失败，请稍后重试')
          stopCurrentAudio()
          done?.()
        }
      }
      try {
        await audio.play()
        setSpeaking(true)
        // 她说话期间后台聆听：你插话她会立刻停下并回复
        startBackgroundListening()
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
  }, [settings.voiceId, stopCurrentAudio, startBackgroundListening, stopBackgroundListening, synthesizeSentence, prefetchNextSentence])

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
    lastSpokenTextsRef.current = []
    ttsCacheRef.current.clear()
    prefetchInFlightRef.current.clear()
    stopBackgroundListening()
    stopCurrentAudio()
  }, [stopCurrentAudio, stopBackgroundListening])

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
    // 动作预测：你说话的语义先触发手势，不等待 LLM 回复
    triggerGesture(text)
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
    stopBackgroundListening()
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
    recognition.interimResults = true
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
        return
      }
      // 中间结果实时上屏，用户能看到 ASR 正在出字
      const interim = results.map(result => result[0]?.transcript ?? '').join('')
      if (interim.trim() !== '') {
        setBubbleText(`听到了：${interim.trim()}`)
      }
    }
    recognition.onerror = (event): void => {
      const error = event.error ?? 'unknown'
      handledByError = true
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
    recognition.onend = (): void => {
      setListening(false)
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
    if (event.pointerType !== 'mouse') return
    // 右键拖拽 = 旋转模型（左键保持移动面板）
    if (event.button === 2) {
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
        mode: 'rotate',
        lastX: event.clientX,
        lastY: event.clientY
      }
      dragMovedRef.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button !== 0) return
    unlockAudio()
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      mode: 'move',
      lastX: event.clientX,
      lastY: event.clientY
    }
    dragMovedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [position, unlockAudio])

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragStateRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    if (state.mode === 'rotate') {
      const dx = event.clientX - state.lastX
      const dy = event.clientY - state.lastY
      state.lastX = event.clientX
      state.lastY = event.clientY
      // 拖拽即「抓住模型转」：向右拖脸向右转，向下拖视角抬高
      mmdRef.current?.rotateBy(-dx * 0.012, dy * 0.012)
      // 同步面板朝向滑块（就近取整，避免拖动过程频繁重渲染）
      setYawDeg(Math.round(mmdRef.current?.getYawDegrees() ?? 0))
      return
    }
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
      style={{ left: position.x, top: position.y, width: stageWidth }}
      data-testid='virtual-companion'
    >
      <div
        ref={stageRef}
        className={`${css.stage} ${speaking ? css.speaking : ''} ${hovered ? css.hovered : ''}`}
        style={{ width: stageWidth, height: stageHeight }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(event) => event.preventDefault()}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <canvas ref={canvasRef} className={css.canvas} aria-label='虚拟伙伴 3D 人物' />
        <img
          className={`${css.portrait} ${modelReady ? css.portraitHidden : ''}`}
          src='/virtual-companion/portrait'
          alt='虚拟伙伴立绘'
          draggable={false}
        />
        {statusText !== null && (
          <div className={css.bubble} style={{ background: activeBackground.css, color: activeBackground.textColor }} role='status'>{statusText}</div>
        )}
      </div>
      {panelOpen && (
        <div
          ref={panelRef}
          className={css.panel}
          style={{ left: panelLeft, top: panelTop, background: activeBackground.css, color: activeBackground.textColor }}
          role='dialog'
          aria-label='虚拟人物设置'
        >
          <div
            className={css.panelHeader}
            onPointerDown={startPanelDrag}
            onPointerMove={movePanelDrag}
            onPointerUp={endPanelDrag}
            onPointerCancel={endPanelDrag}
          >
            <span>虚拟人物设置</span>
            <button
              className={css.closeButton}
              type='button'
              onClick={closeSettings}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label='关闭设置'
            >×</button>
          </div>
          <label className={css.field}>
            <span>人物角色：{activeRole.label}</span>
            <PanelSelect
              ariaLabel='人物角色'
              value={settings.roleId}
              onValueChange={(value) => setSettings({ ...settings, roleId: value as RoleId })}
              items={ROLE_PRESETS.map(role => ({ value: role.id, label: `${role.label} - ${role.description}` }))}
            />
          </label>
          <label className={css.field}>
            <span>人物模型</span>
            <PanelSelect
              ariaLabel='人物模型'
              testId='vc-model-select'
              value={settings.modelId}
              onValueChange={(value) => setSettings({ ...settings, modelId: value })}
              items={(modelOptions.length > 0 ? modelOptions : [{ id: settings.modelId, label: settings.modelId }])
                .map(model => ({ value: model.id, label: model.label }))}
            />
          </label>
          <div className={css.field}>
            <span>动作列表（{motionReady ? (motionStatus === 'playing' ? '播放中' : motionStatus === 'paused' ? '保持姿势/已暂停' : '已就绪') : '未加载'}）</span>
            <PanelSelect
              ariaLabel='动作列表'
              value={selectedMotion}
              disabled={!modelReady}
              onValueChange={(id) => {
                setSelectedMotion(id)
                setMotionReady(false)
                setMotionStatus('stopped')
                void (async () => {
                  const mmd = mmdRef.current
                  if (mmd === null) return
                  try {
                    if (id === 'stand') {
                      mmd.stopMotion()
                      setMotionStatus('stopped')
                    } else {
                      const motion = motionOptions.find(item => item.id === id)
                      if (motion === undefined) return
                      await mmd.loadMotion(motion.url)
                    }
                    setMotionReady(true)
                  } catch (error) {
                    console.warn('[virtual-companion] 动作切换失败：', error)
                  }
                })()
              }}
              items={[
                { value: 'stand', label: '默认站姿' },
                ...motionOptions.map(motion => ({ value: motion.id, label: motion.label }))
              ]}
            />
            <div style={{ display: 'flex', gap: '0.45em' }}>
              <button
                type='button'
                disabled={!motionReady || selectedMotion === 'stand'}
                onClick={() => {
                  if (mmdRef.current?.playMotion(false) === true) setMotionStatus('playing')
                }}
              >播放一次</button>
              <button
                type='button'
                disabled={!motionReady || selectedMotion === 'stand'}
                onClick={() => {
                  if (mmdRef.current?.playMotion(true) === true) setMotionStatus('playing')
                }}
              >循环播放</button>
              <button
                type='button'
                disabled={!motionReady || selectedMotion === 'stand' || motionStatus !== 'playing'}
                onClick={() => {
                  mmdRef.current?.pauseMotion()
                  setMotionStatus('paused')
                }}
              >暂停</button>
              <button
                type='button'
                disabled={!motionReady || motionStatus === 'stopped'}
                onClick={() => {
                  const mmd = mmdRef.current
                  mmd?.stopMotion()
                  if (selectedMotion === 'stand') {
                    setMotionStatus('stopped')
                  } else setMotionStatus('stopped')
                }}
              >停止</button>
            </div>
          </div>
          <label className={css.field}>
            <span>亮度：{settings.brightness.toFixed(2)}</span>
            <Slider.Root
              className={css.sliderRoot}
              min={BRIGHTNESS_MIN}
              max={BRIGHTNESS_MAX}
              step={0.05}
              value={[settings.brightness]}
              onValueChange={([value]) => setSettings({ ...settings, brightness: value ?? settings.brightness })}
              aria-label='亮度'
            >
              <Slider.Track className={css.sliderTrack}><Slider.Range className={css.sliderRange} /></Slider.Track>
              <Slider.Thumb className={css.sliderThumb} />
            </Slider.Root>
          </label>
          <label className={css.field}>
            <span>面部光：{settings.faceLight.toFixed(2)}</span>
            <Slider.Root
              className={css.sliderRoot}
              min={FACE_LIGHT_MIN}
              max={FACE_LIGHT_MAX}
              step={0.05}
              value={[settings.faceLight]}
              onValueChange={([value]) => setSettings({ ...settings, faceLight: value ?? settings.faceLight })}
              aria-label='面部光'
            >
              <Slider.Track className={css.sliderTrack}><Slider.Range className={css.sliderRange} /></Slider.Track>
              <Slider.Thumb className={css.sliderThumb} />
            </Slider.Root>
          </label>
          <label className={css.field}>
            <span>人物朝向：{yawDeg}°（0° 正面，180° 背面）</span>
            <Slider.Root
              className={css.sliderRoot}
              min={0}
              max={360}
              step={1}
              value={[yawDeg]}
              onValueChange={([value]) => {
                const degrees = value ?? yawDeg
                setYawDeg(degrees)
                mmdRef.current?.setYawDegrees(degrees)
              }}
              aria-label='人物朝向'
            >
              <Slider.Track className={css.sliderTrack}><Slider.Range className={css.sliderRange} /></Slider.Track>
              <Slider.Thumb className={css.sliderThumb} />
            </Slider.Root>
          </label>
          {ikDiag !== '' && (
            <div style={{ fontSize: '0.72em', opacity: 0.85, lineHeight: 1.5, wordBreak: 'break-all', padding: '0 0.2em' }}>
              {ikDiag}
            </div>
          )}
          <label className={css.field}>
            <span>音色</span>
            <PanelSelect
              ariaLabel='音色'
              value={settings.voiceId}
              onValueChange={(value) => setSettings({ ...settings, voiceId: value as VoiceStyleId })}
              items={VOICE_STYLES.map(voice => ({ value: voice.id, label: `${voice.label} - ${voice.description}` }))}
            />
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
            <Switch.Root
              className={css.switchRoot}
              checked={settings.realtime}
              onCheckedChange={(checked) => setSettings({ ...settings, realtime: checked })}
              aria-label='流式实时回复'
            >
              <Switch.Thumb className={css.switchThumb} />
            </Switch.Root>
          </label>
          <div className={css.panelHint}>双击人物打开此面板，单击开始/停止语音聊天；右键拖拽人物可旋转</div>
        </div>
      )}
    </div>
  )
}
