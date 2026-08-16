import { describe, expect, it } from 'vitest'
import { VOICE_STYLES } from '../shared/voice.ts'

// 2026-08-16 对 Edge TTS 端点逐名实测可用的 zh-CN 女声；
// 未验证的音色名会导致合成流被服务端关闭（no turn.end），
// 表现为 502 / ERR_EMPTY_RESPONSE。新增音色必须先实测加入此名单。
const VERIFIED_EDGE_VOICES = new Set([
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-XiaobeiNeural',
  'zh-CN-XiaoniNeural',
  'zh-CN-XiaoxuanNeural',
  'zh-CN-YunxiaNeural',
  'zh-CN-YunxiNeural'
])

describe('companion voice styles', () => {
  it('only maps to Edge voices verified against the live endpoint', () => {
    for (const style of VOICE_STYLES) {
      expect(VERIFIED_EDGE_VOICES.has(style.edgeVoice), `${style.id} -> ${style.edgeVoice} 未经实测验证`).toBe(true)
    }
  })
})
