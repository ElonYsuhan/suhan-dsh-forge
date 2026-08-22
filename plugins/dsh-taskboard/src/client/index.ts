/**
 * 需求看板插件，浏览器半：
 * - `shell.overlay` 条目（左缘按钮 + 看板工作台）
 * - `conversation.input.left` 条目（聊天页「＋待办」）
 * 注入面 openSession 通过浏览器半 sessions 服务把聊天页切换到工作项会话。
 */
import type { ClientContext, SessionRuntime } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-layout's SlotMap merge (declares 'shell.overlay')
// and ui-conversation's composer merge (declares 'conversation.input.left').
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TodoCreateButton, type TodoCreateInjected } from './TodoCreateButton.tsx'
import { TaskboardLauncher, type TaskboardInjected } from './TaskboardLauncher.tsx'
import { TaskboardSettingsSection } from './TaskboardSettingsSection.tsx'

export type { TaskboardLauncherProps } from './TaskboardLauncher.tsx'

/** Required services: slot registry + session runtime (会话联动). */
export const inject = ['slots', 'sessions']

/**
 * Client plugin body: contribute the taskboard overlay entry and the
 * composer todo-create button.
 * @param ctx - client root context.
 */
export function apply (ctx: ClientContext): void {
  const sessions = ctx.sessions as unknown as Pick<SessionRuntime, 'list' | 'open'>
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'taskboard',
    order: 100,
    inject: (): TaskboardInjected => {
      // ctx.sessions 的运行时实现是 SessionRuntime（runtime 提供），
      // 但类型声明被 dsh-session 的 SessionStore merge 覆盖，窄化到运行时面。
      return {
        /** 把聊天页切换到指定会话（工作项执行档案）。 */
        openSession: (sessionId: string) => {
          sessions.open(sessionId as SessionId)
        },
        currentSessionId: () => sessions.list.getSnapshot().current,
        subscribeSessions: (listener: () => void) => sessions.list.subscribe(listener),
        /** 会话是否仍存在于宿主列表（任务验收归档后会话会被移除/终结）。 */
        isSessionAlive: (sessionId: string) => {
          const snapshot = sessions.list.getSnapshot()
          const id = sessionId as SessionId
          return snapshot.ids.includes(id) || snapshot.byId[id] !== undefined
        },
        currentProjectPath: () => {
          const snapshot = sessions.list.getSnapshot()
          return snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current]?.cwd
        }
      }
    },
  }, TaskboardLauncher))

  // DSH 主设置页：管理各项目看板的环节/类型。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'taskboard',
    order: 100,
    label: '任务看板'
  }, TaskboardSettingsSection))

  // 聊天页 composer 工具行：创建待办任务到看板。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'todo-create',
    order: 0,
    inject: (sessionId): TodoCreateInjected => ({
      projectPath: sessions.list.getSnapshot().byId[sessionId]?.cwd
    })
  }, TodoCreateButton))
}
