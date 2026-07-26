import type { ComponentChildren } from 'preact';

interface FormBaseProps {
  action: string;
  /** 传入即启用提交前二次确认（由 forms 增强器接管；无脚本时直接提交）。 */
  confirm?: string;
  class?: string;
  children: ComponentChildren;
}

/**
 * `csrfToken` 对 POST 是**必填**、对 GET 是禁止的。
 *
 * 写成判别联合而不是一个可选属性：可选属性下漏传只是渲染出
 * `value=""`，仍然要等到运行时才表现为 403——那正是这个组件立意要消灭的
 * 失败模式，没理由把它留在编译期之外。
 */
type FormProps = FormBaseProps &
  ({ method?: 'post'; csrfToken: string } | { method: 'get'; csrfToken?: never });

/**
 * 表单容器，自动注入 CSRF 隐藏域。
 *
 * 旧站的 22 个表单各自手抄一遍 `<input type="hidden" name="_csrf" ...>`，
 * 漏写就是 403，而且只有在运行时才发现。收进组件后这件事不可能再漏。
 */
export function Form({
  action,
  method = 'post',
  csrfToken,
  confirm,
  class: className,
  children
}: FormProps) {
  return (
    <form
      class={className}
      action={action}
      method={method}
      data-confirm={confirm}
      // 搜索类 GET 表单交给调用方加 role="search"
    >
      {method === 'post' && <input type="hidden" name="_csrf" value={csrfToken ?? ''} />}
      {children}
    </form>
  );
}

interface FieldProps {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'search';
  value?: string | number;
  /** 输入格式说明。会自动挂到 aria-describedby 上。 */
  hint?: string;
  /** 校验失败信息。出现时字段被标记为 aria-invalid。 */
  error?: string;
  required?: boolean;
  readonly?: boolean;
  autofocus?: boolean;
  autocomplete?: string;
  placeholder?: string;
  inputmode?: 'numeric' | 'text' | 'email';
  pattern?: string;
  minlength?: number;
  maxlength?: number;
  min?: number;
  max?: number;
  class?: string;
}

/**
 * 带标签的输入框。label/hint/error 与控件的关联由组件负责连线，
 * 调用方不需要（也无法忘记）手写 for / id / aria-describedby。
 */
export function Field({
  name,
  label,
  type = 'text',
  value,
  hint,
  error,
  required,
  readonly,
  autofocus,
  autocomplete,
  placeholder,
  inputmode,
  pattern,
  minlength,
  maxlength,
  min,
  max,
  class: className
}: FieldProps) {
  const id = `f-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
        {required && <span class="field__required" aria-hidden="true">*</span>}
      </label>
      <input
        class={['field__input', className].filter(Boolean).join(' ')}
        id={id}
        name={name}
        type={type}
        value={value === undefined ? undefined : String(value)}
        required={required}
        readonly={readonly}
        autofocus={autofocus}
        autocomplete={autocomplete}
        placeholder={placeholder}
        inputMode={inputmode}
        pattern={pattern}
        minLength={minlength}
        maxLength={maxlength}
        min={min}
        max={max}
        aria-describedby={describedBy}
        aria-invalid={error ? 'true' : undefined}
      />
      {hint && (
        <p class="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p class="field__error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

interface CheckboxProps {
  name: string;
  label: string;
  checked?: boolean;
  hint?: string;
}

export function Checkbox({ name, label, checked, hint }: CheckboxProps) {
  const id = `f-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div class="field field--check">
      <input
        class="field__checkbox"
        id={id}
        name={name}
        type="checkbox"
        value="on"
        checked={checked}
        aria-describedby={hintId}
      />
      <label class="field__label" for={id}>
        {label}
      </label>
      {hint && (
        <p class="field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

interface SelectProps {
  name: string;
  label: string;
  value?: string;
  options: { value: string; label: string }[];
}

export function Select({ name, label, value, options }: SelectProps) {
  const id = `f-${name}`;
  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
      </label>
      <select class="field__input" id={id} name={name}>
        {options.map((option) => (
          <option key={option.value} value={option.value} selected={option.value === value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
