/**
 * 任务依赖配置区（新建/编辑表单与独立依赖编辑器共用）：
 * 关联当前项目其他任务并配置顺序类型（before/after/parallel，本任务视角），最多 10 项。
 * 保存/提交后服务端按新依赖重新评估执行闸门：前置满足 → 自动开始执行；未满足 → 挂起待前置完成。
 */
import { DEPENDENCY_LABELS, type Board, type DependencyType, type TaskDependency } from '../../shared/types.ts'
import { UiSelect } from './Select.tsx'
import css from './DependencyConfig.module.css'

/** 依赖类型选项（本任务视角标签） */
export const DEPENDENCY_TYPE_OPTIONS = (Object.keys(DEPENDENCY_LABELS) as DependencyType[])
  .map(type => ({ value: type, label: DEPENDENCY_LABELS[type] }))

/** 依赖配置区 props */
export interface DependencyConfigProps {
  board: Board
  /** 当前工作项 id；新建表单传 null（不排除自身、不提示自动执行语义） */
  itemId: string | null
  dependencies: TaskDependency[]
  onChange: (dependencies: TaskDependency[]) => void
  /** 区块标题；默认「任务依赖（可选）」 */
  heading?: string
  /** 测试钩子前缀（默认 taskboard-editor-dep） */
  dataTestPrefix?: string
}

/**
 * Render the dependency config section.
 * @param props - board for candidates, current value, and change callback.
 */
export function DependencyConfig ({ board, itemId, dependencies, onChange, heading = '任务依赖（可选）', dataTestPrefix = 'taskboard-editor-dep' }: DependencyConfigProps) {
  // 已归档但仍在引用中的依赖任务保留在选项里（标记已归档），避免打开编辑器就丢配置。
  const referencedIds = new Set(dependencies.map(dep => dep.taskId))
  const options = board.items
    .filter(i => i.id !== itemId && (!i.archived || referencedIds.has(i.id)))
    .map(i => ({ value: i.id, label: `${i.title}${i.archived ? '（已归档）' : ''}` }))

  return (
    <section className={css.section}>
      <div className={css.head}>
        <span className={css.heading}>{heading}</span>
        <button
          type='button'
          className={css.addBtn}
          onClick={() => onChange([...dependencies, { taskId: options[0]?.value ?? '', type: 'before' }])}
          disabled={dependencies.length >= 10 || options.length === 0}
          data-testid={`${dataTestPrefix}-add`}
        >
          + 添加依赖
        </button>
      </div>
      <p className={css.hint}>
        在此之前 = 本任务先执行，完成后自动开始该任务；之后 = 本任务等待该任务，其完成后自动开始本任务；并行 = 无顺序约束。
        {itemId !== null && ' 保存后若前置任务均已交付完成将自动开始执行本任务，否则挂起等待，全部完成后自动开始；也可随时手动执行。'}
      </p>
      {dependencies.length === 0
        ? <p className={css.empty}>未配置任务依赖</p>
        : (
          <ul className={css.list}>
            {dependencies.map((dep, index) => (
              <li key={`${dep.taskId}-${index}`} className={css.row}>
                <UiSelect
                  className={css.select}
                  value={dep.taskId}
                  onValueChange={taskId => onChange(dependencies.map((d, i) => i === index ? { ...d, taskId } : d))}
                  options={options}
                  placeholder='选择任务'
                  ariaLabel={`依赖 ${index + 1} 目标任务`}
                  dataTestId={`${dataTestPrefix}-target-${index}`}
                />
                <UiSelect
                  className={css.select}
                  value={dep.type}
                  onValueChange={typeValue => onChange(dependencies.map((d, i) => i === index ? { ...d, type: typeValue as DependencyType } : d))}
                  options={DEPENDENCY_TYPE_OPTIONS}
                  ariaLabel={`依赖 ${index + 1} 类型`}
                  dataTestId={`${dataTestPrefix}-type-${index}`}
                />
                <button
                  type='button'
                  className={css.removeBtn}
                  onClick={() => onChange(dependencies.filter((_, i) => i !== index))}
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
}
