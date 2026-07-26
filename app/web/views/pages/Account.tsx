import type { PageProps } from '../../../types/view.js';
import { Field, Form } from '../components/Form.js';
import { Icon } from '../components/Icon.js';
import { Button, Card } from '../components/ui.js';
import { BaseLayout } from '../layouts/BaseLayout.js';

export interface AccountPageProps extends PageProps {
  account: {
    username: string;
    email: string;
    emailVerified: boolean;
    /** 有本地密码才能解绑 Microsoft，也才需要"当前密码"。 */
    hasPassword: boolean;
    microsoftLinked: boolean;
    role: string;
    createdAt: string;
  };
}

/**
 * 账户中心。四个区块各自只做一件事，状态分支写在区块内部。
 */
export function AccountPage({ ctx, account }: AccountPageProps) {
  return (
    <BaseLayout title="账户" ctx={ctx}>
      <div class="stack account">
        <div>
          <p class="eyebrow">ACCOUNT</p>
          <h1>{account.username}</h1>
          <p class="account__meta">
            {account.role} · 注册于 {account.createdAt.slice(0, 10)}
          </p>
        </div>

        <Card title="邮箱">
          <div class="settings-row">
            <div>
              <p class="account__value">{account.email}</p>
              <p class="account__hint">
                {account.emailVerified ? '这个邮箱已验证，可用于登录与找回密码。' : '邮箱尚未验证。'}
              </p>
            </div>
            {account.emailVerified ? (
              <span class="verified">
                <Icon name="check" /> 已验证
              </span>
            ) : (
              <Form action="/resend-verification" csrfToken={ctx.csrfToken}>
                <input type="hidden" name="email" value={account.email} />
                <Button variant="secondary" small pendingLabel="发送中…">
                  发送验证码
                </Button>
              </Form>
            )}
          </div>
        </Card>

        <Card title={account.hasPassword ? '修改密码' : '设置本地密码'}>
          <p class="account__hint">
            {account.hasPassword
              ? '修改后需要用新密码重新登录。'
              : '这个账号目前只能通过 Microsoft 登录。设置本地密码后，两种方式都可用。'}
          </p>
          <Form action="/account/password" csrfToken={ctx.csrfToken} class="stack account__form">
            {account.hasPassword && (
              <Field
                name="currentPassword"
                label="当前密码"
                type="password"
                autocomplete="current-password"
                required
              />
            )}
            <Field
              name="password"
              label="新密码"
              type="password"
              hint="至少 8 个字符"
              minlength={8}
              autocomplete="new-password"
              required
            />
            <Field
              name="passwordConfirm"
              label="确认新密码"
              type="password"
              autocomplete="new-password"
              required
            />
            <Button variant="primary" pendingLabel="保存中…">
              {account.hasPassword ? '保存修改' : '设置密码'}
            </Button>
          </Form>
        </Card>

        <Card title="Microsoft 账户">
          <div class="settings-row">
            <div>
              <p class="account__hint">
                {account.microsoftLinked
                  ? '已绑定。可以用 Microsoft 账户直接登录。'
                  : ctx.settings.microsoftReady
                    ? '绑定后可以用 Microsoft 账户直接登录。'
                    : '站点当前未启用 Microsoft 登录。'}
              </p>
              {account.microsoftLinked && !account.hasPassword && (
                <p class="account__hint">解绑前需要先设置本地密码，否则将无法登录。</p>
              )}
            </div>

            {account.microsoftLinked ? (
              <Form
                action="/account/unlink/microsoft"
                csrfToken={ctx.csrfToken}
                confirm="解绑后将无法用 Microsoft 账户登录，确认继续？"
              >
                <Button variant="danger" small>
                  解绑
                </Button>
              </Form>
            ) : (
              ctx.settings.microsoftReady && (
                <a class="btn btn--secondary btn--small ms-button" href="/account/link/microsoft">
                  <span class="ms-logo" aria-hidden="true" />
                  绑定 Microsoft
                </a>
              )
            )}
          </div>
        </Card>
      </div>
    </BaseLayout>
  );
}
