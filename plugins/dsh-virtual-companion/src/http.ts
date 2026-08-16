/**
 * Minimal HTTP helpers for the virtual companion Host route.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 64 * 1024

/** HTTP error carrying a client-safe status code. */
export class HttpError extends Error {
  readonly status: number

  constructor (status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Read a JSON request body with a size limit. */
export async function readJsonBody (req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

/** Send a JSON response. */
export function sendJson (res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Send one SSE data frame. Caller is responsible for headers and end(). */
export function sendSseEvent (res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** Keep Host diagnostics small and avoid leaking local absolute paths or credentials. */
export function safeDiagnostic (value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/\/Users\/[^/\s]+\//g, '/Users/<redacted>/')
    .replace(/\b(Bearer\s+|(?:api[-_]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2_000)
}
