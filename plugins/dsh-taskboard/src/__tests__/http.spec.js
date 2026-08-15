import { describe, expect, it } from 'vitest'
import { HttpError, readJsonBody } from '../http.ts'

function request (body, contentType = 'application/json') {
  const buffer = Buffer.from(body)
  return {
    headers: { 'content-type': contentType, 'content-length': String(buffer.byteLength) },
    async * [Symbol.asyncIterator] () { yield buffer }
  }
}

describe('taskboard HTTP input boundary', () => {
  it('accepts JSON and rejects unsupported or malformed bodies', async () => {
    await expect(readJsonBody(request('{"title":"ok"}'))).resolves.toEqual({ title: 'ok' })
    await expect(readJsonBody(request('{}', 'text/plain'))).rejects.toMatchObject({ status: 415 })
    await expect(readJsonBody(request('{'))).rejects.toMatchObject({ status: 400 })
  })

  it('rejects declared bodies larger than 256 KiB before reading', async () => {
    const oversized = {
      headers: { 'content-type': 'application/json', 'content-length': String(257 * 1024) },
      async * [Symbol.asyncIterator] () {}
    }
    await expect(readJsonBody(oversized)).rejects.toBeInstanceOf(HttpError)
    await expect(readJsonBody(oversized)).rejects.toMatchObject({ status: 413 })
  })
})
