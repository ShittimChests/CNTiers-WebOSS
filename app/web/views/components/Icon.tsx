export type IconName =
  | 'crown'
  | 'medal-2'
  | 'medal-3'
  | 'flask'
  | 'search'
  | 'menu'
  | 'close'
  | 'sort'
  | 'sort-asc'
  | 'sort-desc'
  | 'check'
  | 'warn';

interface IconProps {
  name: IconName;
  /** 有独立含义时传入，会渲染成可访问名称；装饰性图标留空。 */
  label?: string;
  class?: string;
}

/**
 * 引用 sprite 里的像素图标。
 *
 * 默认 aria-hidden——榜单里的奖牌、测试服烧瓶旁边都已有可见文本，
 * 再给图标一个名字只会让屏幕阅读器重复播报。
 */
export function Icon({ name, label, class: className }: IconProps) {
  const classes = ['icon', className].filter(Boolean).join(' ');
  return (
    <svg
      class={classes}
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      focusable="false"
    >
      <use href={`/sprite.svg#i-${name}`} />
    </svg>
  );
}
