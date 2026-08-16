/**
 * 虚拟人物插件，浏览器半：
 * - 注册 `shell.overlay` 全页面浮动 3D 人物
 * - 拖拽移动、单击开启模型主动提问的语音聊天都在浮层组件内完成
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-layout's SlotMap merge (declares 'shell.overlay').
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { VirtualCompanion } from './VirtualCompanion.tsx'

export type { VirtualCompanionProps } from './VirtualCompanion.tsx'

/** Required services: slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: contribute the floating companion to shell.overlay.
 * @param ctx - client root context.
 */
export function apply (ctx: ClientContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'virtual-companion',
    order: 200
  }, VirtualCompanion))
}
