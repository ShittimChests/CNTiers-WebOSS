import type { ComponentChildren } from 'preact';
import type { PageProps } from '../../../types/view.js';
import { Field, Form } from '../components/Form.js';
import { Alert, Button, Card } from '../components/ui.js';
import { BaseLayout } from '../layouts/BaseLayout.js';

/**
 * 认证相关的五个页面。它们共享同一个窄栏外壳，因此放在一起：
 * 旧站把这个外壳在五个模板里各复制了一遍。
 */

interface AuthShellProps extends PageProps {
  title: string;
  eyebrow: string;
  intro: string;
  error?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
}

function AuthShell({ ctx, title, eyebrow, intro, error, children, footer }: AuthShellProps) {
  return (
    <BaseLayout title={title} ctx={ctx}>
      <div class="auth">
        <Card>
          <p class="eyebrow">{eyebrow}</p>
          <h1 class="auth__title">{title}</h1>
          <p class="auth__intro">{intro}</p>

          {error && <Alert kind="error">{error}</Alert>}

          {children}

          {footer && <div class="auth__footer">{footer}</div>}
        </Card>
      </div>
    </BaseLayout>
  );
}

// ---------- 登录 ----------

export interface LoginPageProps extends PageProps {
  error?: string;
  /** 登录后要回到的路径。 */
  next?: string;
  identifier?: string;
}

export function LoginPage({ ctx, error, next, identifier }: LoginPageProps) {
  return (
    <AuthShell
      ctx={ctx}
      eyebrow="SIGN IN"
      title="登录"
      intro="用用户名或邮箱登录。"
      error={error}
      footer={
        <>
          <a href="/forgot">忘记密码</a>
          {ctx.settings.registrationEnabled && <a href="/register">注册新账号</a>}
        </>
      }
    >
      <Form action={next ? `/login?next=${encodeURIComponent(next)}` : '/login'} csrfToken={ctx.csrfToken} class="stack">
        <Field
          name="identifier"
          label="用户名或邮箱"
          value={identifier}
          autocomplete="username"
          required
          autofocus
        />
        <Field name="password" label="密码" type="password" autocomplete="current-password" required />
        <Button variant="primary" pendingLabel="登录中…">
          登录
        </Button>
      </Form>

      {ctx.settings.microsoftReady && (
        <>
          <p class="auth__divider">或</p>
          <a class="btn btn--secondary ms-button" href="/auth/microsoft">
            <span class="ms-logo" aria-hidden="true" />
            使用 Microsoft 账户登录
          </a>
        </>
      )}
    </AuthShell>
  );
}

// ---------- 注册 ----------

export interface RegisterPageProps extends PageProps {
  error?: string;
  values?: { username?: string; email?: string };
}

export function RegisterPage({ ctx, error, values }: RegisterPageProps) {
  return (
    <AuthShell
      ctx={ctx}
      eyebrow="SIGN UP"
      title="注册"
      intro="注册后会收到一封含 6 位验证码的邮件。"
      error={error}
      footer={<a href="/login">已有账号，去登录</a>}
    >
      <Form action="/register" csrfToken={ctx.csrfToken} class="stack">
        <Field
          name="username"
          label="用户名"
          value={values?.username}
          hint="3–32 个字符，可用字母、数字、下划线与短横线"
          pattern="[A-Za-z0-9_\-]+"
          minlength={3}
          maxlength={32}
          autocomplete="username"
          required
          autofocus
        />
        <Field
          name="email"
          label="邮箱"
          type="email"
          value={values?.email}
          autocomplete="email"
          required
        />
        <Field
          name="password"
          label="密码"
          type="password"
          hint="至少 8 个字符"
          minlength={8}
          autocomplete="new-password"
          required
        />
        <Field
          name="passwordConfirm"
          label="确认密码"
          type="password"
          autocomplete="new-password"
          required
        />
        <Button variant="primary" pendingLabel="提交中…">
          注册
        </Button>
      </Form>
    </AuthShell>
  );
}

// ---------- 邮箱验证 ----------

export interface VerifyPageProps extends PageProps {
  email: string;
  error?: string;
  notice?: string;
}

export function VerifyPage({ ctx, email, error, notice }: VerifyPageProps) {
  return (
    <AuthShell
      ctx={ctx}
      eyebrow="VERIFY EMAIL"
      title="验证邮箱"
      intro="输入邮件里的 6 位验证码。验证码 5 分钟内有效。"
      error={error}
    >
      {notice && <Alert kind="info">{notice}</Alert>}

      <Form action="/verify" csrfToken={ctx.csrfToken} class="stack">
        <Field name="email" label="邮箱" value={email} readonly />
        <Field
          name="code"
          label="验证码"
          value=""
          inputmode="numeric"
          pattern="\d{6}"
          minlength={6}
          maxlength={6}
          autocomplete="one-time-code"
          class="field__input--code"
          required
          autofocus
        />
        <Button variant="primary" pendingLabel="验证中…">
          完成验证
        </Button>
      </Form>

      <Form action="/resend-verification" csrfToken={ctx.csrfToken} class="auth__resend">
        <input type="hidden" name="email" value={email} />
        <button class="link-button" type="submit">
          没收到？重新发送
        </button>
      </Form>
    </AuthShell>
  );
}

// ---------- 忘记密码 ----------

export function ForgotPage({ ctx, error }: PageProps & { error?: string }) {
  return (
    <AuthShell
      ctx={ctx}
      eyebrow="RESET PASSWORD"
      title="忘记密码"
      intro="输入注册邮箱，我们会发送一个 6 位验证码。"
      error={error}
      footer={<a href="/login">返回登录</a>}
    >
      <Form action="/forgot" csrfToken={ctx.csrfToken} class="stack">
        <Field name="email" label="邮箱" type="email" autocomplete="email" required autofocus />
        <Button variant="primary" pendingLabel="发送中…">
          发送验证码
        </Button>
      </Form>
    </AuthShell>
  );
}

// ---------- 重置密码 ----------

export interface ResetPageProps extends PageProps {
  email: string;
  error?: string;
}

export function ResetPage({ ctx, email, error }: ResetPageProps) {
  return (
    <AuthShell
      ctx={ctx}
      eyebrow="RESET PASSWORD"
      title="设置新密码"
      intro="输入邮件里的验证码并设置新密码。"
      error={error}
      footer={<a href="/forgot">重新获取验证码</a>}
    >
      <Form action="/reset" csrfToken={ctx.csrfToken} class="stack">
        <Field name="email" label="邮箱" value={email} readonly />
        <Field
          name="code"
          label="验证码"
          inputmode="numeric"
          pattern="\d{6}"
          minlength={6}
          maxlength={6}
          autocomplete="one-time-code"
          class="field__input--code"
          required
          autofocus
        />
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
        <Button variant="primary" pendingLabel="提交中…">
          设置新密码
        </Button>
      </Form>
    </AuthShell>
  );
}
