import type { PluginListing } from './types'

export const categoryLabels: Record<string, string> = {
  workflow: '工作流',
  'project-management': '项目管理',
  productivity: '效率',
  development: '开发工具',
  knowledge: '知识管理',
}

function searchableText(plugin: PluginListing): string {
  return [
    plugin.displayName['zh-CN'],
    plugin.displayName['en-US'],
    plugin.summary['zh-CN'],
    plugin.summary['en-US'],
    plugin.packageName,
    ...plugin.tags,
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN')
}

export function filterPlugins(
  plugins: PluginListing[],
  query: string,
  category: string,
): PluginListing[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  return plugins.filter(plugin => {
    const matchesCategory = category === 'all' || plugin.categories.includes(category)
    const matchesQuery = normalizedQuery === '' || searchableText(plugin).includes(normalizedQuery)
    return matchesCategory && matchesQuery
  })
}

export function permissionCount(plugin: PluginListing): number {
  return Object.values(plugin.permissions).reduce((total, values) => total + values.length, 0)
}
