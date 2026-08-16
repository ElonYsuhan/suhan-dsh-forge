import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTE, resolveRoute, ROUTES } from './router'

describe('management router', () => {
  it('resolves the plugin list route', () => {
    expect(resolveRoute('#/plugins')).toBe(ROUTES.plugins)
    expect(resolveRoute('#/plugins?q=task')).toBe(ROUTES.plugins)
  })

  it('resolves the quality gate route', () => {
    expect(resolveRoute('#/quality')).toBe(ROUTES.quality)
  })

  it('falls back to the plugin list for empty or unknown hashes', () => {
    expect(resolveRoute('')).toBe(DEFAULT_ROUTE)
    expect(resolveRoute('#')).toBe(DEFAULT_ROUTE)
    expect(resolveRoute('#/unknown')).toBe(DEFAULT_ROUTE)
  })
})
