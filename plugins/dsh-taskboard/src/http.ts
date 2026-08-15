import type { IncomingMessage } from 'node:http'

const MAX_BODY_BYTES = 256 * 1024

export class HttpError extends Error {
  constructor (readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

function jsonContentType (value: string | undefined): boolean {
  if (value === undefined) return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

/** 读取有上限的 JSON body；空动作请求无需 Content-Type。 */
export async function readJsonBody (req: IncomingMessage): Promise<unknown> {
  const declared = Number.parseInt(req.headers['content-length'] ?? '0', 10)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')

  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    bytes += chunk.byteLength
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  const contentType = Array.isArray(req.headers['content-type']) ? req.headers['content-type'][0] : req.headers['content-type']
  if (!jsonContentType(contentType)) throw new HttpError(415, '请求体必须使用 application/json')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, '请求体不是有效 JSON')
  }
}
