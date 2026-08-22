/**
 * 工作项弹窗（Radix Dialog）：
 * - 新建（item === null）：AI 创建流程极简表单 —— 可选标题 + 想法计划描述 +
 *   「保存草稿」（仅落草稿，稍后再生成方案）或「任务方案生成」（创建后立即启动方案生成）；
 * - 编辑（item !== null）：类型 / 标题 / 描述 / 优先级 / 标签 / 迭代 / 追溯父级 /
 *   环节 / 任务依赖（关联当前项目任务，before/after/parallel 约束顺序并自动串联）。
 */
import { useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { DEPENDENCY_LABELS, PRIORITIES, executionModeOf, type Board, type DependencyType, type ExecutionMode, type Priority, type TaskDependency, type WorkItem } from '../shared/types.ts'
import type { ItemInput } from './api.ts'
import { UiSelect } from './ui/Select.tsx'
import css from './ItemEditor.module.css'

/** Editor surface props. */
export interface ItemEditorProps {
  /** 正在编辑的工作项；null 为新建 */
  item: WorkItem | null
  board: Board
  /** 新建时预选的环节 */
  defaultStatus?: string | undefined
  onCancel: () => void
  /** 新建：generatePlan=false 仅保存草稿（稍后再生成方案）；true 创建后立即启动任务方案生成。编辑：更新工作项。 */
  onSave: (input: ItemInput, generatePlan?: boolean) => void
}

const DEPENDENCY_TYPE_OPTIONS = (Object.keys(DEPENDENCY_LABELS) as DependencyType[])
  .map(type => ({ value: type, label: DEPENDENCY_LABELS[type] }))

/**
 * Render the editor dialog.
 * @param props - the item under edit, the board (类型/环节/父级选项), and callbacks.
 */
export function ItemEditor ({ item, board, defaultStatus, onCancel, onSave }: ItemEditorProps) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [requirement, setRequirement] = useState(item?.originalRequirement ?? '')
  const [type, setType] = useState(item?.type ?? board.itemTypes[0]?.key ?? 'task')
  const [desc, setDesc] = useState(item?.desc ?? '')
  const [priority, setPriority] = useState<Priority>(item?.priority ?? 'medium')
  const [labels, setLabels] = useState(item?.labels.join('、') ?? '')
  const [iteration, setIteration] = useState(item?.iteration ?? '')
  const [parentId, setParentId] = useState(item?.parentId ?? '')
  const [status, setStatus] = useState(item?.status ?? defaultStatus ?? board.columns[0]?.id ?? 'todo')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(item === null ? 'auto' : executionModeOf(item))
  const [dependencies, setDependencies] = useState<TaskDependency[]>(() => (item?.dependencies ?? []).map(dep => ({ ...dep })))

  const candidates = board.items.filter(i => i.id !== item?.id && !i.archived)
  // 已归档但仍在引用中的依赖任务保留在选项里（标记已归档），避免打开编辑器就丢配置。
  const referencedIds = new Set((item?.dependencies ?? []).map(dep => dep.taskId))
  const dependencyOptions = board.items
    .filter(i => i.id !== item?.id && (!i.archived || referencedIds.has(i.id)))
    .map(i => ({ value: i.id, label: `${i.title}${i.archived ? '（已归档）' : ''}` }))
  const parentOptions = candidates.map(i => ({ value: i.id, label: i.title }))
  const depsChanged = JSON.stringify(dependencies) !== JSON.stringify(item?.dependencies ?? [])

  const handleSubmit = (ev: FormEvent): void => {
    ev.preventDefault()
    if (item === null) {
      if (requirement.trim() === '' && title.trim() === '') return
      onSave({
        type,
        title: title.trim(),
        desc: '',
        originalRequirement: requirement.trim(),
        priority: 'medium',
        labels: [],
        parentId: null,
        iteration: null,
        status: board.columns[0]?.id ?? 'todo',
        executionMode: 'auto',
        ...(dependencies.length === 0 ? {} : { dependencies })
      }, true)
      return
    }
    const trimmed = title.trim()
    if (trimmed === '') return
    onSave({
      type,
      title: trimmed,
      desc: desc.trim(),
      priority,
      labels: labels.split(/[、,，]/).map(s => s.trim()).filter(s => s !== ''),
      parentId: parentId === '' ? null : parentId,
      iteration: iteration.trim() === '' ? null : iteration.trim(),
      status,
      executionMode,
      ...(depsChanged ? { dependencies: dependencies.length === 0 ? null : dependencies } : {})
    })
  }

  /** 「保存草稿」：仅创建，不启动方案生成（后续可在详情中随时生成）。 */
  const handleSaveDraft = (): void => {
    if (item !== null || (requirement.trim() === '' && title.trim() === '')) return
    onSave({
      type,
      title: title.trim(),
      desc: '',
      originalRequirement: requirement.trim(),
      priority: 'medium',
      labels: [],
      parentId: null,
      iteration: null,
      status: board.columns[0]?.id ?? 'todo',
      executionMode: 'auto',
      ...(dependencies.length === 0 ? {} : { dependencies })
    }, false)
  }

  // ── 任务依赖配置（新建与编辑共用；可选，最多 10 项） ──────
  const depSection = (
    <section className={css.depSection}>
      <div className={css.depHead}>
        <span className={css.fieldLabel}>任务依赖（可选）</span>
        <button
          type='button'
          className={css.depAddBtn}
          onClick={() => setDependencies(prev => [...prev, { taskId: dependencyOptions[0]?.value ?? '', type: 'before' }])}
          disabled={dependencies.length >= 10 || dependencyOptions.length === 0}
          data-testid='taskboard-editor-dep-add'
        >
          + 添加依赖
        </button>
      </div>
      <p className={css.depHint}>
        在此之前 = 本任务先执行，完成后自动开始该任务；之后 = 本任务等待该任务，其完成后自动开始本任务；并行 = 无顺序约束。关联任务成功后自动串联执行。
      </p>
      {dependencies.length === 0
        ? <p className={css.depEmpty}>未配置任务依赖</p>
        : (
          <ul className={css.depList}>
            {dependencies.map((dep, index) => (
              <li key={`${dep.taskId}-${index}`} className={css.depRow}>
                <UiSelect
                  className={css.select}
                  value={dep.taskId}
                  onValueChange={taskId => setDependencies(prev => prev.map((d, i) => i === index ? { ...d, taskId } : d))}
                  options={dependencyOptions}
                  placeholder='选择任务'
                  ariaLabel={`依赖 ${index + 1} 目标任务`}
                  dataTestId={`taskboard-editor-dep-target-${index}`}
                />
                <UiSelect
                  className={css.select}
                  value={dep.type}
                  onValueChange={typeValue => setDependencies(prev => prev.map((d, i) => i === index ? { ...d, type: typeValue as DependencyType } : d))}
                  options={DEPENDENCY_TYPE_OPTIONS}
                  ariaLabel={`依赖 ${index + 1} 类型`}
                  dataTestId={`taskboard-editor-dep-type-${index}`}
                />
                <button
                  type='button'
                  className={css.depRemoveBtn}
                  onClick={() => setDependencies(prev => prev.filter((_, i) => i !== index))}
                  aria-label={`移除依赖 ${index + 1}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )

  // ── 新建：AI 创建流程极简表单 ─────────────────────────────
  if (item === null) {
    const submitDisabled = requirement.trim() === '' && title.trim() === ''
    return (
      <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
        <Dialog.Portal>
          <Dialog.Overlay className={css.mask} />
          <div className={css.layer}>
            <Dialog.Content className={css.panel} aria-label='新建想法'>
              <form onSubmit={handleSubmit}>
                <header className={css.head}>
                  <h3 className={css.title}>新建想法</h3>
                  <Dialog.Close asChild>
                    <button type='button' className={css.closeBtn} aria-label='关闭'>✕</button>
                  </Dialog.Close>
                </header>

                <label className={css.field}>
                  <span className={css.fieldLabel}>标题（可选，方案生成后给出建议）</span>
                  <input
                    className={css.input}
                    value={title}
                    onChange={ev => setTitle(ev.target.value)}
                    placeholder='如：给系统加个登录功能'
                    autoFocus
                    data-testid='taskboard-editor-title'
                  />
                </label>

                <label className={css.field}>
                  <span className={css.fieldLabel}>想法计划描述</span>
                  <textarea
                    className={css.textarea}
                    value={requirement}
                    onChange={ev => setRequirement(ev.target.value)}
                    placeholder='用自然语言描述你的想法或需求，会结合当前项目生成可执行方案。例如：给系统加个登录功能，账号密码登录，登录后保持登录状态。'
                    rows={8}
                    data-testid='taskboard-editor-requirement'
                  />
                </label>

                {depSection}

                <footer className={css.foot}>
                  <button type='button' className={css.cancelBtn} onClick={onCancel}>取消</button>
                  <button type='button' className={css.draftBtn} onClick={handleSaveDraft} disabled={submitDisabled} data-testid='taskboard-editor-save-draft'>
                    保存草稿
                  </button>
                  <button type='submit' className={css.saveBtn} disabled={submitDisabled}>任务方案生成</button>
                </footer>
              </form>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }

  // ── 编辑：全字段表单 ─────────────────────────────────────
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={css.mask} />
        <div className={css.layer}>
          <Dialog.Content className={css.panel} aria-label='编辑工作项'>
            <form onSubmit={handleSubmit}>
              <header className={css.head}>
                <h3 className={css.title}>编辑工作项</h3>
                <Dialog.Close asChild>
                  <button type='button' className={css.closeBtn} aria-label='关闭'>✕</button>
                </Dialog.Close>
              </header>

              <div className={css.row}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>类型</span>
                  <UiSelect
                    className={css.select}
                    value={type}
                    onValueChange={setType}
                    options={board.itemTypes.map(t => ({ value: t.key, label: t.label }))}
                    ariaLabel='类型'
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>优先级</span>
                  <UiSelect
                    className={css.select}
                    value={priority}
                    onValueChange={value => setPriority(value as Priority)}
                    options={PRIORITIES.map(p => ({ value: p.key, label: p.label }))}
                    ariaLabel='优先级'
                  />
                </label>
              </div>

              <label className={css.field}>
                <span className={css.fieldLabel}>标题</span>
                <input
                  className={css.input}
                  value={title}
                  onChange={ev => setTitle(ev.target.value)}
                  placeholder='工作项标题'
                  autoFocus
                  required
                  data-testid='taskboard-editor-title'
                />
              </label>

              <label className={css.field}>
                <span className={css.fieldLabel}>描述</span>
                <textarea
                  className={css.textarea}
                  value={desc}
                  onChange={ev => setDesc(ev.target.value)}
                  placeholder='目标、范围、验收标准…'
                  rows={3}
                />
              </label>

              <div className={css.row}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>追溯父级</span>
                  <UiSelect
                    className={css.select}
                    value={parentId}
                    onValueChange={value => setParentId(value === '' ? '' : value)}
                    options={[{ value: '', label: '（无）' }, ...parentOptions]}
                    ariaLabel='追溯父级'
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>迭代</span>
                  <input className={css.input} value={iteration} onChange={ev => setIteration(ev.target.value)} placeholder='如 2026-08 S2' />
                </label>
              </div>

              <div className={css.row}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>执行方式</span>
                  <UiSelect
                    className={css.select}
                    value={executionMode}
                    onValueChange={value => setExecutionMode(value as ExecutionMode)}
                    options={[
                      { value: 'auto', label: '小任务 · AI 自主推进' },
                      { value: 'review', label: '重大任务 · 每环节人工审核' }
                    ]}
                    ariaLabel='执行方式'
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>环节</span>
                  <UiSelect
                    className={css.select}
                    value={status}
                    onValueChange={setStatus}
                    options={board.columns.map(c => ({ value: c.id, label: c.label }))}
                    ariaLabel='环节'
                  />
                </label>
              </div>

              <label className={css.field}>
                <span className={css.fieldLabel}>标签（、分隔）</span>
                <input className={css.input} value={labels} onChange={ev => setLabels(ev.target.value)} placeholder='如 工程、迁移' />
              </label>

              {depSection}

              <footer className={css.foot}>
                <button type='button' className={css.cancelBtn} onClick={onCancel}>取消</button>
                <button type='submit' className={css.saveBtn} disabled={title.trim() === ''}>保存</button>
              </footer>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
