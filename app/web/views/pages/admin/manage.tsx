import type { TenantResolution } from '../../../../services/settingsService.js';
import type { Category, User } from '../../../../types/domain.js';
import type { PageProps } from '../../../../types/view.js';
import { Checkbox, Field, Form } from '../../components/Form.js';
import { Icon } from '../../components/Icon.js';
import { Button, Card, EmptyState } from '../../components/ui.js';
import { BaseLayout } from '../../layouts/BaseLayout.js';

/** 细分项目、站点设置与用户管理三个后台页面。 */

// ---------- 细分项目 ----------

export interface AdminCategoriesProps extends PageProps {
  categories: Category[];
}

export function AdminCategoriesPage({ ctx, categories }: AdminCategoriesProps) {
  return (
    <BaseLayout title="细分项目" ctx={ctx}>
      <div class="stack admin">
        <div>
          <p class="eyebrow">ADMIN</p>
          <h1>细分项目</h1>
          <p class="admin__meta">
            项目是独立记录，改名后所有条目上的定级会自动跟随；删除会一并清掉相关定级。
          </p>
        </div>

        <Card title="新增项目">
          <Form action="/admin/categories/add" csrfToken={ctx.csrfToken} class="stack admin__form">
            <Field
              name="name"
              label="项目名"
              hint="字母、数字、空格、下划线与短横线"
              pattern="[A-Za-z0-9 _\-]+"
              maxlength={48}
              required
            />
            <Button variant="primary" pendingLabel="添加中…">
              添加项目
            </Button>
          </Form>
        </Card>

        <Card title={`现有项目（${String(categories.length)}）`}>
          {categories.length === 0 ? (
            <EmptyState>还没有细分项目。</EmptyState>
          ) : (
            <ul class="category-list">
              {categories.map((category) => (
                <li key={category.id} class="category">
                  <span class="category__name">{category.name}</span>

                  <Form
                    action="/admin/categories/rename"
                    csrfToken={ctx.csrfToken}
                    class="category__rename"
                  >
                    <input type="hidden" name="from" value={category.name} />
                    <label class="visually-hidden" for={`rename-${category.id}`}>
                      {`${category.name} 的新名称`}
                    </label>
                    <input
                      class="field__input"
                      id={`rename-${category.id}`}
                      name="to"
                      type="text"
                      placeholder="新名称"
                      pattern="[A-Za-z0-9 _\-]+"
                      maxLength={48}
                      required
                    />
                    <Button variant="secondary" small pendingLabel="保存中…">
                      改名
                    </Button>
                  </Form>

                  <Form
                    action="/admin/categories/delete"
                    csrfToken={ctx.csrfToken}
                    confirm={`删除「${category.name}」会同时移除所有条目在该项目上的定级，确认继续？`}
                  >
                    <input type="hidden" name="name" value={category.name} />
                    <Button variant="danger" small>
                      删除
                    </Button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </BaseLayout>
  );
}

// ---------- 站点设置 ----------

export interface AdminSettingsProps extends PageProps {
  settings: {
    registrationEnabled: boolean;
    oauthEnabled: boolean;
    oauthMicrosoft: { clientId: string; tenant: string };
  };
  /** client_secret 只认环境变量，这里只报告是否就绪。 */
  microsoftSecretPresent: boolean;
  microsoftReady: boolean;
  /** 实际生效的租户及其来源——面板里填的未必是生效的那个。 */
  tenantInEffect: TenantResolution;
}

/** 租户来源的人话说明。 */
const TENANT_SOURCE_NOTE: Record<TenantResolution['source'], string> = {
  panel: '来自本页设置',
  env: '来自环境变量 MS_OAUTH_TENANT，已接管本页填写的值',
  default: '默认值，未做租户限制'
};

export function AdminSettingsPage({
  ctx,
  settings,
  microsoftSecretPresent,
  microsoftReady,
  tenantInEffect
}: AdminSettingsProps) {
  return (
    <BaseLayout title="站点设置" ctx={ctx}>
      <div class="stack admin admin--narrow">
        <div>
          <p class="eyebrow">SUPER ADMIN</p>
          <h1>站点设置</h1>
        </div>

        <Form action="/admin/settings" csrfToken={ctx.csrfToken} class="stack">
          <Card title="注册">
            <Checkbox
              name="registrationEnabled"
              label="开放注册"
              checked={settings.registrationEnabled}
              hint="关闭后注册页返回 404，导航里也不再出现注册入口。"
            />
          </Card>

          <Card title="Microsoft 登录">
            <div class="stack">
              <Checkbox
                name="oauthEnabled"
                label="启用 Microsoft 登录"
                checked={settings.oauthEnabled}
              />
              <Field
                name="oauthClientId"
                label="Client ID"
                value={settings.oauthMicrosoft.clientId}
                maxlength={128}
                hint="来自 Azure 应用注册"
              />
              <Field
                name="oauthTenant"
                label="Tenant"
                value={settings.oauthMicrosoft.tenant}
                maxlength={64}
                placeholder="common"
                hint="留空、common、organizations、consumers 都表示不限制租户；填具体租户 ID 或域名才是限制。"
              />

              <p class="admin__hint">
                当前生效的租户：<code>{tenantInEffect.value}</code>（
                {TENANT_SOURCE_NOTE[tenantInEffect.source]}）。
              </p>

              <p class="admin__hint">
                Client secret 只从环境变量 <code>MS_OAUTH_CLIENT_SECRET</code> 读取，不在此处填写、
                也不会写入数据库。当前状态：
                {microsoftSecretPresent ? ' 已配置' : ' 未配置'}。
              </p>

              <p class={microsoftReady ? 'status status--ok' : 'status status--warn'}>
                <Icon name={microsoftReady ? 'check' : 'warn'} />
                {microsoftReady
                  ? 'Microsoft 登录已就绪'
                  : '尚未就绪：需要同时满足开关已开、Client ID 已填、环境变量里有 secret'}
              </p>
            </div>
          </Card>

          <div class="cluster">
            <Button variant="primary" pendingLabel="保存中…">
              保存设置
            </Button>
          </div>
        </Form>

        <Card title="数据库">
          <p class="admin__hint">数据库连接与切换在独立页面操作。</p>
          <p>
            <a href="/admin/database">前往数据库设置</a>
          </p>
        </Card>
      </div>
    </BaseLayout>
  );
}

// ---------- 用户管理 ----------

export interface AdminUsersProps extends PageProps {
  users: User[];
  /** 当前操作者，用于标出"这是你自己"。 */
  currentUserId: string;
}

export function AdminUsersPage({ ctx, users, currentUserId }: AdminUsersProps) {
  return (
    <BaseLayout title="用户管理" ctx={ctx}>
      <div class="stack admin">
        <div>
          <p class="eyebrow">SUPER ADMIN</p>
          <h1>用户管理</h1>
          <p class="admin__meta">共 {users.length} 个账号</p>
        </div>

        <Card>
          <ul class="user-list">
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              const isSuper = user.role === 'SuperAdmin';

              return (
                <li key={user.id} class="user">
                  <div class="user__identity">
                    <span class="user__name">{user.username}</span>
                    <span class={`role-pill role-pill--${user.role.toLowerCase()}`}>
                      {user.role}
                    </span>
                    {!user.emailVerified && <span class="user__flag">未验证</span>}
                    {user.oauthProvider === 'microsoft' && (
                      <span class="user__flag user__flag--ms">Microsoft</span>
                    )}
                  </div>

                  <div class="user__meta">
                    <span>{user.email}</span>
                    <span>{user.createdAt.slice(0, 10)}</span>
                  </div>

                  <div class="user__actions">
                    {isSuper ? (
                      <span class="admin__hint">超级管理员不可修改</span>
                    ) : isSelf ? (
                      <span class="admin__hint">这是你自己</span>
                    ) : (
                      <>
                        {user.role === 'User' ? (
                          <Form action={`/admin/users/${user.id}/promote`} csrfToken={ctx.csrfToken}>
                            <Button variant="secondary" small pendingLabel="处理中…">
                              提升为管理员
                            </Button>
                          </Form>
                        ) : (
                          <Form action={`/admin/users/${user.id}/demote`} csrfToken={ctx.csrfToken}>
                            <Button variant="secondary" small pendingLabel="处理中…">
                              降为普通用户
                            </Button>
                          </Form>
                        )}
                        <Form
                          action={`/admin/users/${user.id}/delete`}
                          csrfToken={ctx.csrfToken}
                          confirm={`确认删除 ${user.username}？其会话会立即失效，操作无法撤销。`}
                        >
                          <Button variant="danger" small>
                            删除
                          </Button>
                        </Form>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </BaseLayout>
  );
}
