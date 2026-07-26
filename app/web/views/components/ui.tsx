import type { ComponentChildren } from 'preact';
import { materialForRank } from '../../shared/tiers.js';
import { Icon } from './Icon.js';

/**
 * 基础展示组件。集中在一个文件里是有意的：它们都很小、互相引用频繁，
 * 拆成十几个单文件只会制造导入噪音。带交互或带状态的组件另开文件。
 */

// ---------- 卡片与区块 ----------

interface CardProps {
  title?: string;
  /** 标题上方的小标签。只在真的有分类信息时用，不做装饰。 */
  eyebrow?: string;
  actions?: ComponentChildren;
  children: ComponentChildren;
}

export function Card({ title, eyebrow, actions, children }: CardProps) {
  const hasHeader = Boolean(title) || Boolean(actions);
  return (
    <section class="card">
      {hasHeader && (
        <header class="card__head">
          <div>
            {eyebrow && <p class="eyebrow">{eyebrow}</p>}
            {title && <h2 class="card__title">{title}</h2>}
          </div>
          {actions && <div class="cluster">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ---------- 按钮 ----------

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps {
  variant?: ButtonVariant;
  type?: 'submit' | 'button';
  small?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
  formaction?: string;
  formmethod?: string;
  /** 提交中显示的文案，由 forms 增强器接管。 */
  pendingLabel?: string;
  children: ComponentChildren;
}

export function Button({
  variant = 'secondary',
  type = 'submit',
  small = false,
  disabled,
  name,
  value,
  formaction,
  formmethod,
  pendingLabel,
  children
}: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, small && 'btn--small'].filter(Boolean).join(' ');
  return (
    <button
      class={classes}
      type={type}
      disabled={disabled}
      name={name}
      value={value}
      formaction={formaction}
      formmethod={formmethod}
      data-pending-label={pendingLabel}
    >
      {children}
    </button>
  );
}

interface LinkButtonProps {
  href: string;
  variant?: ButtonVariant;
  small?: boolean;
  children: ComponentChildren;
}

export function LinkButton({ href, variant = 'secondary', small, children }: LinkButtonProps) {
  const classes = ['btn', `btn--${variant}`, small && 'btn--small'].filter(Boolean).join(' ');
  return (
    <a class={classes} href={href}>
      {children}
    </a>
  );
}

// ---------- 段位徽章 ----------

/**
 * 段位徽章。文字始终可见——颜色只是辅助，不能是唯一的区分手段。
 * 下界合金档带渐变描边（全站唯一的渐变，"附魔光泽"）。
 */
export function TierBadge({ rank }: { rank: string }) {
  return (
    <span class={`badge badge--${materialForRank(rank)}`}>{rank}</span>
  );
}

/** 细分项目 + 定级，如 `Sword HT1`。 */
export function Chip({ label, tier }: { label: string; tier: string }) {
  return (
    <span class="chip">
      <span class="chip__label">{label}</span>
      <b class="chip__tier">{tier}</b>
    </span>
  );
}

/** 测试服标记。 */
export function TestServerTag({ name }: { name: string }) {
  return (
    <span class="tag">
      <Icon name="flask" />
      {name}
    </span>
  );
}

// ---------- 积分槽（签名元素） ----------

/**
 * 分段式积分槽。
 *
 * 用原生 <progress> 而不是 div + 宽度：动态数值通过属性表达，
 * 因此 CSP 里不需要 style-src unsafe-inline（旧站的积分条是内联宽度）。
 * 分段质感由 CSS 的 mask 切出来，对应 Minecraft 经验条的分格外观。
 *
 * 旁边总有可见的数字，所以这里 aria-hidden 避免重复播报。
 */
export function XpBar({ value, max }: { value: number; max: number }) {
  return (
    <progress class="xpbar" value={String(Math.max(0, value))} max={String(Math.max(1, max))} aria-hidden="true" />
  );
}

// ---------- 名次标记 ----------

/** 前三名的像素奖牌。名次数字本身可见，图标是装饰。 */
export function RankMedal({ position }: { position: number }) {
  if (position === 1) return <Icon name="crown" class="medal medal--1" />;
  if (position === 2) return <Icon name="medal-2" class="medal medal--2" />;
  if (position === 3) return <Icon name="medal-3" class="medal medal--3" />;
  return null;
}

// ---------- 提示与空态 ----------

interface AlertProps {
  kind: 'success' | 'error' | 'info';
  children: ComponentChildren;
}

export function Alert({ kind, children }: AlertProps) {
  return (
    <p class={`alert alert--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function EmptyState({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

// ---------- 分页 ----------

interface PaginationProps {
  page: number;
  totalPages: number;
  /** 构造某一页的链接，由调用方决定保留哪些查询参数。 */
  hrefFor: (page: number) => string;
}

export function Pagination({ page, totalPages, hrefFor }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <nav class="pagination" aria-label="分页">
      {page > 1 && (
        <a class="pagination__link" href={hrefFor(page - 1)} rel="prev">
          上一页
        </a>
      )}
      <span class="pagination__status">
        第 {page} / {totalPages} 页
      </span>
      {page < totalPages && (
        <a class="pagination__link" href={hrefFor(page + 1)} rel="next">
          下一页
        </a>
      )}
    </nav>
  );
}
