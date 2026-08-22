/**
 * DSH 主设置里的“任务看板”设置页。
 * 复用现有 REST 与 SettingsForm：选择已注册项目后编辑该看板的环节/类型。
 */
import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: loads the settings.section slot augmentation from the DSH settings domain.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { fetchBoards, saveSettings, type BoardsResponse } from './api.ts'
import { SettingsForm } from './SettingsForm.tsx'
import { UiSelect } from './ui/Select.tsx'
import type { Board, ColumnDef, ItemTypeDef } from '../shared/types.ts'
import css from './TaskboardSettingsSection.module.css'

/** DSH Settings section component props. */
export type TaskboardSettingsSectionProps = PropsRuntime<'settings.section'>

/**
 * Render the taskboard settings page inside DSH Settings.
 * @param _props - runtime props supplied by the settings shell.
 */
export function TaskboardSettingsSection (_props: TaskboardSettingsSectionProps) {
  const [data, setData] = useState<BoardsResponse | null>(null)
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [formVersion, setFormVersion] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await fetchBoards()
      setData(res)
      setError(null)
      const keys = Object.keys(res.boards)
      setCurrentKey(prev => prev !== null && keys.includes(prev) ? prev : (keys[0] ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const board: Board | null = data !== null && currentKey !== null
    ? (data.boards[currentKey] ?? null)
    : null

  const handleSave = async (settings: { columns: ColumnDef[]; itemTypes: ItemTypeDef[] }): Promise<void> => {
    if (currentKey === null) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const updated = await saveSettings(currentKey, settings)
      setData(prev => prev === null
        ? prev
        : { ...prev, boards: { ...prev.boards, [currentKey]: updated } })
      setNotice('看板设置已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = (): void => {
    setFormVersion(version => version + 1)
    setError(null)
    setNotice(null)
  }

  return (
    <section className={css.section} aria-labelledby='taskboard-settings-title' data-testid='taskboard-settings-section'>
      <header className={css.head}>
        <div>
          <h3 id='taskboard-settings-title' className={css.title}>任务看板</h3>
          <p className={css.subtitle}>管理各项目看板的环节（列）与工作项类型</p>
        </div>
      </header>

      {error !== null && <div className={css.error} role='alert'>{error}</div>}
      {notice !== null && <div className={css.notice} role='status'>{notice}</div>}

      {loading && data === null
        ? <div className={css.empty}>正在加载项目看板…</div>
        : data === null
          ? <div className={css.empty}>当前没有可用的任务看板数据。</div>
          : (
            <div className={css.body}>
              {data.workspaces.length === 0
                ? <div className={css.empty}>当前没有已注册的 DSH 工作区。</div>
                : (
                  <>
                    <div className={css.projectBar}>
                      <span className={css.projectLabel} id='taskboard-settings-project-label'>项目</span>
                      <UiSelect
                        className={css.projectSelect}
                        value={currentKey ?? ''}
                        onValueChange={key => {
                          setCurrentKey(key)
                          setFormVersion(version => version + 1)
                          setError(null)
                          setNotice(null)
                        }}
                        options={data.workspaces.map(workspace => ({ value: workspace.id, label: workspace.title }))}
                        placeholder='请选择项目'
                        ariaLabel='项目'
                        dataTestId='taskboard-settings-project'
                      />
                    </div>
                    {board === null
                      ? <div className={css.empty}>该项目暂无看板。</div>
                      : (
                        <SettingsForm
                          key={`${currentKey}-${formVersion}`}
                          board={board}
                          onCancel={handleCancel}
                          onSave={handleSave}
                        />
                      )}
                  </>
                )}
            </div>
          )}
      {saving && <div className={css.saving} role='status'>保存中…</div>}
    </section>
  )
}
