export const ROUTES = {
  plugins: '/plugins',
  quality: '/quality',
} as const

export type RouteName = typeof ROUTES[keyof typeof ROUTES]

export const DEFAULT_ROUTE: RouteName = ROUTES.plugins

export function parseHash(hash: string): string {
  return hash.replace(/^#/, '').split('?')[0] || '/'
}

export function resolveRoute(hash: string): RouteName {
  const path = parseHash(hash)
  if (path === ROUTES.plugins) return ROUTES.plugins
  if (path === ROUTES.quality) return ROUTES.quality
  return DEFAULT_ROUTE
}
