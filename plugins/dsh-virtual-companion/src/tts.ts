/**
 * Host-side high-quality TTS for the virtual companion.
 *
 * Instead of relying on the browser's low-quality speechSynthesis voices, the
 * Host synthesizes speech through the open-source `msedge-tts` client, which
 * uses Microsoft Edge's neural Read Aloud voices. This module owns the Edge TTS
 * client lifecycle per request. Besides returning a bounded MP3 buffer for
 * small/fallback requests, it also exposes a streaming MP3 source so the
 * browser can begin playback while Edge is still synthesizing the sentence.
 */
import { Readable } from 'node:stream'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { getVoiceStyle, type VoiceStyleId } from './shared/voice.ts'
import { safeDiagnostic } from './http.ts'

/** Maximum audio bytes accepted from the TTS backend. */
export const TTS_MAX_BYTES = 8 * 1024 * 1024

/** Maximum time to wait for one TTS synthesis request. */
export const TTS_TIMEOUT_MS = 20_000

/** Client-safe TTS failure. */
export class TtsError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'TtsError'
  }
}

/** Audio result returned by a speech synthesizer. */
export interface TtsAudioResult {
  buffer: Buffer
  contentType: string
}

/** Live audio source returned by a streaming speech synthesizer. */
export interface TtsStreamResult {
  stream: Readable
  contentType: string
}

/** Injectable speech synthesizer used by the Host route. */
export interface SpeechSynth {
  synthesize (text: string, voice: VoiceStyleId): Promise<TtsAudioResult>
  /** Optional live streaming source. The route uses it when available. */
  stream? (text: string, voice: VoiceStyleId): Promise<TtsStreamResult>
  dispose (): void
}

/** Race a promise against a timeout, invoking a cleanup callback on timeout. */
async function withTimeout<T> (promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new TtsError('TTS synthesis timed out'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Collect a Readable into a bounded Buffer. */
async function collectStream (stream: Readable, maxBytes: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(error)
    }

    stream.on('data', (chunk: unknown) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      size += buffer.length
      if (size > maxBytes) {
        fail(new TtsError(`TTS audio exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(buffer)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    stream.on('error', (error: Error) => fail(error))
  })
}

/**
 * Default synthesizer backed by `msedge-tts`.
 *
 * A new MsEdgeTTS client is created per request so voice changes or failed
 * requests cannot corrupt another in-flight synthesis. The WebSocket is closed
 * in `finally`, and `dispose()` is a no-op because no long-lived resource is
 * retained after a request completes.
 */
export class EdgeTtsSpeechSynth implements SpeechSynth {
  async synthesize (text: string, voice: VoiceStyleId): Promise<TtsAudioResult> {
    const style = getVoiceStyle(voice)
    const tts = new MsEdgeTTS()
    let audioStream: Readable | null = null
    try {
      return await withTimeout((async () => {
        await tts.setMetadata(style.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
        const stream = tts.toStream(text, {
          rate: style.edgeRate,
          pitch: style.edgePitch
        })
        audioStream = stream.audioStream
        const buffer = await collectStream(audioStream, TTS_MAX_BYTES)
        if (buffer.length === 0) throw new TtsError('TTS returned no audio data')
        return { buffer, contentType: 'audio/mpeg' }
      })(), TTS_TIMEOUT_MS, () => {
        audioStream?.destroy()
        try {
          tts.close()
        } catch {
          // best-effort timeout cleanup; do not mask the timeout error
        }
      })
    } catch (error) {
      if (error instanceof TtsError) throw error
      throw new TtsError(`Edge TTS synthesis failed: ${safeDiagnostic(error)}`)
    } finally {
      try {
        tts.close()
      } catch {
        // close() is best-effort cleanup; the original error must not be hidden.
      }
    }
  }

  /**
   * Start an Edge TTS synthesis and return its MP3 Readable immediately.
   *
   * The returned stream owns the underlying MsEdgeTTS client; the client is
   * closed when the stream ends, closes, or errors. This lets the HTTP route
   * pipe audio to the browser as chunks are synthesized instead of buffering
   * the entire sentence before playback.
   */
  async stream (text: string, voice: VoiceStyleId): Promise<TtsStreamResult> {
    const style = getVoiceStyle(voice)
    const tts = new MsEdgeTTS()
    let audioStream: Readable | null = null
    let closed = false

    const close = (): void => {
      if (closed) return
      closed = true
      try {
        tts.close()
      } catch {
        // best-effort cleanup; do not mask the original stream error
      }
    }

    try {
      await withTimeout((async () => {
        await tts.setMetadata(style.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
        const result = tts.toStream(text, {
          rate: style.edgeRate,
          pitch: style.edgePitch
        })
        audioStream = result.audioStream
        audioStream.once('end', close)
        audioStream.once('close', close)
        audioStream.once('error', close)
      })(), TTS_TIMEOUT_MS, () => {
        audioStream?.destroy()
        close()
      })
      if (audioStream === null) throw new TtsError('TTS returned no audio stream')
      return { stream: audioStream, contentType: 'audio/mpeg' }
    } catch (error) {
      close()
      if (error instanceof TtsError) throw error
      throw new TtsError(`Edge TTS streaming failed: ${safeDiagnostic(error)}`)
    }
  }

  dispose (): void {
    // Per-request clients are already closed by synthesize()/stream().
  }
}
