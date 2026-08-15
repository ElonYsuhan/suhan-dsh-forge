/**
 * 聊天页「＋待办」：composer 工具行左端的小控件，点击弹出创建表单，
 * 把任务直接建到所选项目的看板待办环节。
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
  const [desc, setDesc] = useState('')
  const [error, setError] = useState<string | null>(null)
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
    const trimmed = title.trim()
    if (projectKey === '' || trimmed === '' || boards === null) return
    const board = boards.boards[projectKey]
    if (board === undefined) return
    createItem(projectKey, {
      type: 'task',
      title: trimmed,
      desc: desc.trim(),
      priority: 'medium',
      labels: [],
      status: board.columns[0]?.id ?? 'todo',
      executionMode: 'auto'
    })
      .then(() => {
        setOpen(false)
        setTitle('')
        setDesc('')
        setError(null)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  return (
    <>
      <button
        type='button'
        className={css.trigger}
        onClick={() => setOpen(true)}
        title='创建待办任务到看板'
        aria-label='创建待办任务'
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
            aria-label='创建待办任务'
            onClick={ev => ev.stopPropagation()}
            onSubmit={handleSubmit}
            tabIndex={-1}
          >
            <header className={css.head}>
              <h3 className={css.title}>创建待办任务</h3>
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
              <span className={css.fieldLabel}>标题</span>
              <input
                className={css.input}
                value={title}
                onChange={ev => setTitle(ev.target.value)}
                placeholder='待办任务标题'
                data-dialog-initial-focus
                required
                data-testid='taskboard-todo-title'
              />
            </label>

            <label className={css.field}>
              <span className={css.fieldLabel}>描述</span>
              <textarea className={css.textarea} value={desc} onChange={ev => setDesc(ev.target.value)} placeholder='可选' rows={2} />
            </label>

            {error !== null && <div className={css.error} role='alert'>{error}</div>}

            <footer className={css.foot}>
              <button type='button' className={css.cancelBtn} onClick={closeDialog}>取消</button>
              <button type='submit' className={css.saveBtn} disabled={title.trim() === '' || projectKey === ''}>创建</button>
            </footer>
          </form>
        </div>
      )}
    </>
  )
}
