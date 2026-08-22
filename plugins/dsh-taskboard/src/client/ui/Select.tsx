/**
 * 看板统一选择器（Radix Select 封装）：popper 定位、键盘原生、无视觉负担。
 * 视觉由调用方传入的 className（如模块 css 的 .select）作用在 Trigger 上。
 */
import * as RadixSelect from '@radix-ui/react-select'
import css from './Select.module.css'

/** 选项 */
export interface UiSelectOption {
  value: string
  label: string
}

/** Select surface props. */
export interface UiSelectProps {
  /** 当前值；不在选项中时显示 placeholder（如「（无）」） */
  value: string
  onValueChange: (value: string) => void
  options: UiSelectOption[]
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  /** 应用到 Trigger 的样式类（视觉）；CSS module 类名可能为 undefined */
  className?: string | undefined
  /** 透传到 Trigger 的测试钩子 */
  dataTestId?: string
}

/**
 * Render a Radix Select.
 * @param props - value, options, and callbacks.
 */
export function UiSelect ({ value, onValueChange, options, placeholder = '请选择', ariaLabel, disabled, className, dataTestId }: UiSelectProps) {
  const resolved = options.some(option => option.value === value) ? value : ''
  return (
    <RadixSelect.Root value={resolved} onValueChange={onValueChange} {...(disabled === undefined ? {} : { disabled })}>
      <RadixSelect.Trigger className={className} aria-label={ariaLabel} data-testid={dataTestId}>
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className={css.icon}>▾</RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className={css.content} position='popper' sideOffset={4}>
          <RadixSelect.Viewport className={css.viewport}>
            {options.map(option => (
              <RadixSelect.Item key={option.value} className={css.item} value={option.value}>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className={css.indicator}>✓</RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
