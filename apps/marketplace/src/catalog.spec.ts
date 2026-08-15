import { describe, expect, it } from 'vitest'
import { filterPlugins, permissionCount } from './catalog'
import type { PluginListing } from './types'

const plugin: PluginListing = {
  id: 'taskboard',
  packageName: '@suhan-dsh/taskboard',
  version: '0.1.0',
  description: 'Taskboard',
  displayName: { 'zh-CN': '需求任务看板', 'en-US': 'Taskboard' },
  summary: { 'zh-CN': '项目需求追溯与交付工作流' },
  categories: ['workflow'],
  tags: ['任务看板', 'agent'],
  compatibility: { dsh: '>=0.1', node: '>=22', profiles: ['web'] },
  permissions: { network: ['local'], filesystem: ['data'], process: [], secrets: [] },
  quality: { unitTests: true, contractTests: true, browserTests: false },
  status: 'internal',
}

describe('plugin catalog', () => {
  it('searches localized names, package names and tags', () => {
    expect(filterPlugins([plugin], '任务', 'all')).toEqual([plugin])
    expect(filterPlugins([plugin], '@suhan-dsh', 'all')).toEqual([plugin])
    expect(filterPlugins([plugin], 'missing', 'all')).toEqual([])
  })

  it('combines category filtering with search', () => {
    expect(filterPlugins([plugin], 'agent', 'workflow')).toEqual([plugin])
    expect(filterPlugins([plugin], 'agent', 'knowledge')).toEqual([])
  })

  it('counts declared permission capabilities', () => {
    expect(permissionCount(plugin)).toBe(2)
  })
})
