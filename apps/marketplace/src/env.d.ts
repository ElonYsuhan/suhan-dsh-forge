/// <reference types="vite/client" />

declare module 'virtual:dsh-plugins' {
  import type { PluginListing } from './types'
  const plugins: PluginListing[]
  export default plugins
}
