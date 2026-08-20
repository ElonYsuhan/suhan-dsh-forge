/**
 * 聊天页「＋待办」：composer 工具行左端的小控件，点击弹出创建表单，
 * 把想法以草稿形式建到所选项目看板第一列（需 AI 分析确认后才能执行）。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createItem, fetchBoards, type BoardsResponse } from './api.ts'
import css from './TodoCreateButton.module.css'
import { useDialogFocus } from './useDialogFocus.ts'

/** 当前聊天会话所属项目。 */
export interface TodoCreateInjected {
  projectPath?: string | undefined
}

/** Composed slot props: conversation.input.left is a session-scoped list entry. */
export type TodoCreateButtonProps = ComposedProps<'conversation.input.left', 'todo-create', never, undefined, TodoCreateInjected>

/**
 * Render the composer tool-row button and its create dialog.
 * @param _props - composed slot props (unused; the dialog owns its state).
 */
export function TodoCreateButton ({ projectPath }: TodoCreateButtonProps) {
  const [open, setOpen] = useState(false)
  const [boards, setBoards] = useState<BoardsResponse | null>(null)
  const [projectKey, setProjectKey] = useState('')
  const [title, setTitle] = useState('')
  const [requirement, setRequirement] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const closeDialog = useCallback(() => setOpen(false), [])
  const panelRef = useDialogFocus<HTMLFormElement>(closeDialog, open)

  useEffect(() => {
    if (!open) return
    fetchBoards()
      .then(res => {
        setBoards(res)
        const currentKey = projectPath === undefined
          ? undefined
          : Object.keys(res.boards).find(key => res.boards[key]?.projectPath === projectPath)
        setProjectKey(prev => prev !== '' && prev in res.boards ? prev : (currentKey ?? Object.keys(res.boards)[0] ?? ''))
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [open])

  const handleSubmit = (ev: FormEvent): void => {
    ev.preventDefault()
    const trimmedTitle = title.trim()
    const trimmedRequirement = requirement.trim()
    if (projectKey === '' || boards === null || (trimmedTitle === '' && trimmedRequirement === '')) return
    const board = boards.boards[projectKey]
    if (board === undefined) return
    createItem(projectKey, {
      type: 'task',
      title: trimmedTitle,
      desc: trimmedRequirement,
      originalRequirement: trimmedRequirement,
      priority: 'medium',
      labels: [],
      status: board.columns[0]?.id ?? 'todo',
      executionMode: 'auto'
    })
      .then(created => {
        setTitle('')
        setRequirement('')
        setError(null)
        setNotice(`已创建草稿「${created.title}」，请到需求看板完成 AI 分析确认后执行`)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  return (
    <>
      <button
        type='button'
        className={css.trigger}
        onClick={() => setOpen(true)}
        title='创建想法草稿到看板'
        aria-label='创建想法草稿'
        data-testid='taskboard-todo-create'
      >
        ＋待办
      </button>

      {open && (
        <div className={css.mask} onClick={closeDialog}>
          <form
            className={css.panel}
            ref={panelRef}
            role='dialog'
            aria-modal='true'
            aria-label='创建想法草稿'
            onClick={ev => ev.stopPropagation()}
            onSubmit={handleSubmit}
            tabIndex={-1}
          >
            <header className={css.head}>
              <h3 className={css.title}>创建想法草稿</h3>
              <button type='button' className={css.closeBtn} onClick={closeDialog} aria-label='关闭'>✕</button>
            </header>

            <label className={css.field}>
              <span className={css.fieldLabel}>项目</span>
              <select
                className={css.select}
                value={projectKey}
                onChange={ev => setProjectKey(ev.target.value)}
                data-testid='taskboard-todo-project'
              >
                {boards !== null && Object.entries(boards.boards).map(([key, board]) => (
                  <option key={key} value={key}>{board.projectTitle}</option>
                ))}
              </select>
            </label>

            <label className={css.field}>
              <span className={css.fieldLabel}>标题（可选）</span>
              <input
                className={css.input}
                value={title}
                onChange={ev => setTitle(ev.target.value)}
                placeholder='如：给系统加个登录功能'
                data-dialog-initial-focus
                data-testid='taskboard-todo-title'
              />
            </label>

            <label className={css.field}>
              <span className={css.fieldLabel}>想法计划描述</span>
              <textarea
                className={css.textarea}
                value={requirement}
                onChange={ev => setRequirement(ev.target.value)}
                placeholder='用自然语言描述你的想法，AI 会结合项目分析后生成可执行方案'
                rows={4}
                data-testid='taskboard-todo-requirement'
              />
            </label>

            {error !== null && <div className={css.error} role='alert'>{error}</div>}
            {notice !== null && <div className={css.notice} role='status'>{notice}</div>}

            <footer className={css.foot}>
              <button type='button' className={css.cancelBtn} onClick={closeDialog}>取消</button>
              <button type='submit' className={css.saveBtn} disabled={projectKey === '' || (title.trim() === '' && requirement.trim() === '')}>创建草稿</button>
            </footer>
          </form>
        </div>
      )}
    </>
  )
}
