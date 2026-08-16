export interface LocalizedText {
  'zh-CN': string
  'en-US'?: string
}

export interface PluginPermissions {
  network: string[]
  filesystem: string[]
  process: string[]
  secrets: string[]
}

export interface PluginListing {
  id: string
  packageName: string
  version: string
  description: string
  /** 本地产物文件名，按 `artifacts/<插件目录>/` 自动扫描。 */
  artifacts?: string[]
  displayName: LocalizedText
  summary: LocalizedText
  categories: string[]
  tags: string[]
  compatibility: {
    dsh: string
    node: string
    profiles: string[]
  }
  permissions: PluginPermissions
  quality: {
    unitTests: boolean
    contractTests: boolean
    browserTests: boolean
  }
  status: 'internal' | 'preview' | 'public' | 'published'
}
