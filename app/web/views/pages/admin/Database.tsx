import type { ConnectionProbe } from '../../../../services/dbSwitchService.js';
import type { DbConnectionConfig } from '../../../../db/dialects.js';
import type { PageProps } from '../../../../types/view.js';
import { Field, Form } from '../../components/Form.js';
import { Icon } from '../../components/Icon.js';
import { Alert, Button, Card } from '../../components/ui.js';
import { BaseLayout } from '../../layouts/BaseLayout.js';

export interface AdminDatabaseProps extends PageProps {
  current: {
    summary: string;
    driver: string;
    migrationVersion: string | null;
    rowCounts: Record<string, number | null>;
  };
  /** 上一次「测试连接」的结果，测试即渲染，不落地任何状态。 */
  probe?: ConnectionProbe;
  probeError?: string;
  /** 表单回填值，避免测试连接后要重新输入。 */
  form?: Partial<Record<string, string>>;
}

const DRIVERS: { value: DbConnectionConfig['driver']; label: string; hint: string }[] = [
  { value: 'sqlite', label: 'SQLite', hint: '单文件，零配置，适合单机部署' },
  { value: 'postgres', label: 'PostgreSQL', hint: '需要可访问的实例与账号' },
  { value: 'mysql', label: 'MySQL', hint: '需要可访问的实例与账号' }
];

/**
 * 数据库设置。
 *
 * 与站点设置分开是因为危险等级不同：这里的操作会搬迁全部数据并让所有人重新登录。
 * 驱动切换用 radio + CSS :has() 控制字段显隐，无需 JavaScript。
 */
export function AdminDatabasePage({
  ctx,
  current,
  probe,
  probeError,
  form = {}
}: AdminDatabaseProps) {
  const selectedDriver = form['driver'] ?? current.driver;

  return (
    <BaseLayout title="数据库" ctx={ctx}>
      <div class="stack admin admin--narrow">
        <div>
          <p class="eyebrow">SUPER ADMIN</p>
          <h1>数据库</h1>
          <p class="admin__meta">
            默认使用 SQLite，零配置即可运行。切换到 PostgreSQL 或 MySQL 时会把现有数据搬过去。
          </p>
        </div>

        <Card title="当前连接">
          <dl class="db-facts">
            <div>
              <dt>连接</dt>
              <dd>{current.summary}</dd>
            </div>
            <div>
              <dt>结构版本</dt>
              <dd>{current.migrationVersion ?? '未迁移'}</dd>
            </div>
            {Object.entries(current.rowCounts).map(([table, count]) => (
              <div key={table}>
                <dt>{table}</dt>
                <dd>{count === null ? '表不存在' : `${String(count)} 行`}</dd>
              </div>
            ))}
          </dl>
        </Card>

        {probeError && <Alert kind="error">{probeError}</Alert>}

        {probe && (
          <Card title="测试结果">
            <p class="status status--ok">
              <Icon name="check" />
              连接成功：{probe.summary}
            </p>
            <dl class="db-facts">
              <div>
                <dt>结构版本</dt>
                <dd>{probe.migrationVersion ?? '未迁移（将自动创建）'}</dd>
              </div>
              <div>
                <dt>是否空库</dt>
                <dd>{probe.isEmpty ? '是，可以迁移数据过去' : '否，已有业务数据'}</dd>
              </div>
              {Object.entries(probe.rowCounts).map(([table, count]) => (
                <div key={table}>
                  <dt>{table}</dt>
                  <dd>{count === null ? '表不存在' : `${String(count)} 行`}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}

        <Card title="目标连接">
          <Form action="/admin/database/test" csrfToken={ctx.csrfToken} class="stack db-form">
            <fieldset class="admin__fieldset db-drivers">
              <legend>驱动</legend>
              {DRIVERS.map((driver) => (
                <label key={driver.value} class="db-driver">
                  <input
                    type="radio"
                    name="driver"
                    value={driver.value}
                    checked={selectedDriver === driver.value}
                  />
                  <span class="db-driver__label">{driver.label}</span>
                  <span class="db-driver__hint">{driver.hint}</span>
                </label>
              ))}
            </fieldset>

            <fieldset class="admin__fieldset db-sqlite">
              <legend>SQLite</legend>
              <Field
                name="file"
                label="文件名"
                value={form['file'] ?? 'subtier.db'}
                hint="必须位于 data/ 目录内，扩展名 .db / .sqlite"
                maxlength={128}
              />
            </fieldset>

            <fieldset class="admin__fieldset db-server">
              <legend>PostgreSQL / MySQL</legend>
              <div class="admin__grid">
                <Field name="host" label="主机" value={form['host'] ?? '127.0.0.1'} maxlength={255} />
                <Field name="port" label="端口" type="number" value={form['port'] ?? ''} />
                <Field name="database" label="数据库名" value={form['database'] ?? ''} maxlength={64} />
                <Field name="user" label="用户名" value={form['user'] ?? ''} maxlength={64} />
              </div>
              <Field
                name="password"
                label="密码"
                type="password"
                hint="留空表示沿用已保存的密码；此处永不回显"
                maxlength={255}
              />
              <label class="db-ssl">
                <input type="checkbox" name="ssl" value="on" checked={form['ssl'] === 'on'} />
                使用 SSL
              </label>
              <label class="db-ssl">
                <input
                  type="checkbox"
                  name="sslInsecure"
                  value="on"
                  checked={form['sslInsecure'] === 'on'}
                />
                跳过证书校验（自签证书、私有 CA，或按 IP 连接时才需要）
              </label>
            </fieldset>

            <div class="cluster">
              <Button variant="secondary" pendingLabel="测试中…">
                测试连接
              </Button>
            </div>
          </Form>
        </Card>

        <Card title="执行切换">
          <p class="admin__hint">
            切换会让**所有人重新登录**（会话不跨库搬迁）。任何一步失败都会保持使用当前数据库，
            不会留下半成品状态。
          </p>
          <ul class="docs__list">
            <li>
              <strong>迁移并切换</strong>：目标必须是空库。会把当前全部数据复制过去并逐表核对行数。
            </li>
            <li>
              <strong>直接切换</strong>：目标已经是本应用的库且结构版本一致，不复制数据。
              用于切回之前用过的库。
            </li>
          </ul>

          <Form
            action="/admin/database/switch"
            csrfToken={ctx.csrfToken}
            confirm="切换数据库会让所有用户重新登录，确认继续？"
            class="stack db-form"
          >
            {/* 目标连接参数与测试表单一致，这里回填上次填过的值 */}
            <input type="hidden" name="driver" value={selectedDriver} />
            <input type="hidden" name="file" value={form['file'] ?? 'subtier.db'} />
            <input type="hidden" name="host" value={form['host'] ?? ''} />
            <input type="hidden" name="port" value={form['port'] ?? ''} />
            <input type="hidden" name="database" value={form['database'] ?? ''} />
            <input type="hidden" name="user" value={form['user'] ?? ''} />
            {/* 两个表单是独立提交的，这排镜像少一项就会出现「测试通过、切换失败」 */}
            <input type="hidden" name="ssl" value={form['ssl'] ?? ''} />
            <input type="hidden" name="sslInsecure" value={form['sslInsecure'] ?? ''} />

            <Field
              name="password"
              label="密码"
              type="password"
              hint="PostgreSQL / MySQL 需要再输入一次"
              maxlength={255}
            />
            <Field
              name="confirmName"
              label="确认"
              hint="输入目标数据库名（SQLite 填文件名）以确认"
              required
            />

            <div class="cluster">
              <Button variant="primary" name="mode" value="migrate" pendingLabel="迁移中…">
                迁移并切换
              </Button>
              <Button variant="secondary" name="mode" value="direct" pendingLabel="切换中…">
                直接切换
              </Button>
            </div>
          </Form>
        </Card>
      </div>
    </BaseLayout>
  );
}
