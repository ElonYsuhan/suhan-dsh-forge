/**
 * 任务依赖编辑器（独立弹窗，从详情页打开；执行开始前随时可配置，含方案未确认的 AI 项）：
 * 只配置依赖并保存。保存后服务端按新依赖重新评估执行闸门：
 * 前置满足 → 自动开始执行；未满足 → 挂起，全部完成后自动开始；也可随时手动执行。
 */
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { Board, TaskDependency, WorkItem } from '../shared/types.ts'
import { DependencyConfig } from './ui/DependencyConfig.tsx'
import css from './DependencyEditor.module.css'

/** Dependency editor surface props. */
export interface DependencyEditorProps {
  item: WorkItem
  board: Board
  /** 正在提交 */
  busy?: boolean
  onCancel: () => void
  /** 保存依赖（null = 清空）；由服务端重新评估执行闸门。 */
  onSave: (dependencies: TaskDependency[] | null) => void
}

/**
 * Render the dependency-only editor dialog.
 * @param props - the item, board, and save callback.
 */
export function DependencyEditor ({ item, board, busy = false, onCancel, onSave }: DependencyEditorProps) {
  const [dependencies, setDependencies] = useState<TaskDependency[]>(() => (item.dependencies ?? []).map(dep => ({ ...dep })))
  // 没有实际变更时不提交（避免无变化保存也触发自动执行评估）。
  const changed = JSON.stringify(dependencies) !== JSON.stringify(item.dependencies ?? [])

  const handleSave = (): void => {
    if (!changed) {
      onCancel()
      return
    }
    onSave(dependencies.length === 0 ? null : dependencies)
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={css.mask} />
        <div className={css.layer}>
          <Dialog.Content className={css.panel} aria-label='配置任务依赖'>
            <header className={css.head}>
              <h3 className={css.title}>配置任务依赖</h3>
              <Dialog.Close asChild>
                <button type='button' className={css.closeBtn} aria-label='关闭'>✕</button>
              </Dialog.Close>
            </header>
            <p className={css.target}>为「{item.title}」配置依赖：</p>
            <DependencyConfig
              board={board}
              itemId={item.id}
              dependencies={dependencies}
              onChange={setDependencies}
              dataTestPrefix='taskboard-dep-editor'
            />
            <footer className={css.foot}>
              <button type='button' className={css.cancelBtn} onClick={onCancel}>取消</button>
              <button type='button' className={css.saveBtn} onClick={handleSave} disabled={busy || !changed} data-testid='taskboard-dep-editor-save'>
                {busy ? '保存中…' : '保存'}
              </button>
            </footer>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
