import type { PageProps } from '../../../types/view.js';
import { LinkButton } from '../components/ui.js';
import { BaseLayout } from '../layouts/BaseLayout.js';

export interface ErrorPageProps extends PageProps {
  title: string;
  detail: string;
  /** 有更合适的去处时覆盖，例如未登录就回登录页。 */
  backHref?: string;
  backLabel?: string;
}

/**
 * 通用错误页。文案说清发生了什么以及下一步怎么做，不道歉也不含糊
 * ——错误页是给人指路的，不是表达情绪的。
 */
export function ErrorPage({ ctx, title, detail, backHref = '/', backLabel = '回到榜单' }: ErrorPageProps) {
  return (
    <BaseLayout title={title} ctx={ctx}>
      <div class="stack">
        <h1>{title}</h1>
        <p class="error-detail">{detail}</p>
        <p>
          <LinkButton href={backHref} variant="primary">
            {backLabel}
          </LinkButton>
        </p>
      </div>
    </BaseLayout>
  );
}
