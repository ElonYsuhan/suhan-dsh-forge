import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { HttpError, readJsonBody, safeDiagnostic } from '../http.ts'

function streamRequest (chunks: Buffer[]): IncomingMessage {
  return {
    async * [Symbol.asyncIterator] () {
      yield * chunks
    }
  } as unknown as IncomingMessage
}

describe('http helpers', () => {
  it('reads empty bodies as an empty object', async () => {
    await expect(readJsonBody(streamRequest([]))).resolves.toEqual({})
  })

  it('rejects invalid JSON with 400', async () => {
    await expect(readJsonBody(streamRequest([Buffer.from('{bad')]))).rejects.toMatchObject({
      status: 400,
      message: 'invalid JSON'
    })
  })

  it('rejects oversized bodies with 413', async () => {
    const big = Buffer.alloc(70 * 1024, 0x61)
    await expect(readJsonBody(streamRequest([big]))).rejects.toMatchObject({
      status: 413,
      message: 'request body too large'
    })
  })

  it('sanitizes local paths and credential-like values from diagnostics', () => {
    const message = safeDiagnostic(new Error('/Users/alice/secret.txt secret=abc123'))
    expect(message).not.toContain('/Users/alice/')
    expect(message).not.toContain('abc123')
    expect(message).toContain('<redacted>')
  })

  it('preserves HttpError status on the error object', () => {
    const error = new HttpError(418, 'teapot')
    expect(error.status).toBe(418)
    expect(error.message).toBe('teapot')
  })
})
