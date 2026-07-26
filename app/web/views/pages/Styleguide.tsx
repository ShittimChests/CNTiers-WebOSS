import type { RankedEntry } from '../../../types/domain.js';
import type { PageProps } from '../../../types/view.js';
import { MATERIALS } from '../../shared/tiers.js';
import { Board } from '../components/Board.js';
import { Checkbox, Field, Form, Select } from '../components/Form.js';
import { Icon, type IconName } from '../components/Icon.js';
import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  LinkButton,
  Pagination,
  RankMedal,
  TestServerTag,
  TierBadge,
  XpBar
} from '../components/ui.js';
import { BaseLayout } from '../layouts/BaseLayout.js';

interface StyleguideProps extends PageProps {
  ranks: string[];
  entries: RankedEntry[];
}

const ICONS: IconName[] = [
  'crown',
  'medal-2',
  'medal-3',
  'flask',
  'search',
  'menu',
  'close',
  'sort',
  'sort-asc',
  'sort-desc',
  'check',
  'warn'
];

export function StyleguidePage({ ctx, ranks, entries }: StyleguideProps) {
  const maxPoints = Math.max(...entries.map((entry) => entry.points), 1);

  return (
    <BaseLayout title="组件库" ctx={ctx}>
      <div class="stack sg">
        <h1>组件库</h1>
        <p class="sg-note">
          开发态专用页面。这里覆盖设计系统的全部组件，用于对比度核查与键盘走查。
        </p>

        <Card title="段位徽章" eyebrow="材质色阶">
          <p class="sg-note">
            段位在后台是自由文本，匹配忽略大小写、空格与 Subtier 前缀；认不出的一律退回石质档，
            徽章文字始终可见，颜色只是辅助。
          </p>
          <div class="cluster">
            {ranks.map((rank) => (
              <TierBadge key={rank} rank={rank} />
            ))}
          </div>
          <p class="sg-note">材质档位：{MATERIALS.join(' → ')}</p>
        </Card>

        <Card title="积分槽" eyebrow="签名元素">
          <p class="sg-note">
            分段式经验槽。数值走 <code>&lt;progress&gt;</code> 的属性而非内联样式，
            因此 CSP 不需要放开 style-src。
          </p>
          <div class="sg-rows">
            {[1240, 980, 500, 120, 0].map((points) => (
              <div key={points} class="cluster">
                <span class="sg-num">{points}</span>
                <XpBar value={points} max={1240} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="按钮">
          <div class="cluster">
            <Button variant="primary" type="button">
              主要操作
            </Button>
            <Button variant="secondary" type="button">
              次要操作
            </Button>
            <Button variant="danger" type="button">
              删除
            </Button>
            <Button variant="ghost" type="button">
              取消
            </Button>
            <Button variant="secondary" type="button" disabled>
              不可用
            </Button>
            <Button variant="secondary" type="button" small>
              小尺寸
            </Button>
            <LinkButton href="#" variant="secondary">
              链接样式
            </LinkButton>
          </div>
        </Card>

        <Card title="表单字段">
          <Form action="#" method="get" class="stack">
            <Field name="sg-text" label="玩家名" hint="1–32 个字符" required />
            <Field name="sg-mail" label="邮箱" type="email" autocomplete="email" />
            <Field
              name="sg-code"
              label="验证码"
              inputmode="numeric"
              pattern="\d{6}"
              maxlength={6}
              class="field__input--code"
              hint="邮件里的 6 位数字"
            />
            <Field name="sg-bad" label="有错误的字段" error="这个值不合法" value="abc" />
            <Field name="sg-ro" label="只读字段" value="player@example.com" readonly />
            <Select
              name="sg-select"
              label="下拉选择"
              value="b"
              options={[
                { value: 'a', label: '选项 A' },
                { value: 'b', label: '选项 B' }
              ]}
            />
            <Checkbox name="sg-check" label="开放注册" checked hint="关闭后注册页返回 404" />
            <div class="cluster">
              <Button variant="primary" pendingLabel="提交中…">
                保存修改
              </Button>
            </div>
          </Form>
        </Card>

        <Card title="提示与空态">
          <div class="stack">
            <Alert kind="success">修改已保存</Alert>
            <Alert kind="error">验证码不正确，还有 3 次尝试机会</Alert>
            <Alert kind="info">邮件已发送，请查收</Alert>
            <EmptyState>还没有任何条目。新增第一条榜单记录试试。</EmptyState>
          </div>
        </Card>

        <Card title="标记与图标">
          <div class="stack">
            <div class="cluster">
              <Chip label="Sword" tier="HT1" />
              <Chip label="Trident Box" tier="LT4" />
              <TestServerTag name="Pico Test #3" />
            </div>
            <div class="cluster">
              <span class="cluster">
                <RankMedal position={1} /> 第一名
              </span>
              <span class="cluster">
                <RankMedal position={2} /> 第二名
              </span>
              <span class="cluster">
                <RankMedal position={3} /> 第三名
              </span>
            </div>
            <div class="cluster sg-icons">
              {ICONS.map((name) => (
                <span key={name} class="sg-icon">
                  <Icon name={name} />
                  <code>{name}</code>
                </span>
              ))}
            </div>
          </div>
        </Card>

        <Card title="榜单行" eyebrow="桌面 / 移动同一份标记">
          <Board entries={entries} maxPoints={maxPoints} />
        </Card>

        <Card title="分页">
          <Pagination page={2} totalPages={5} hrefFor={(page) => `?page=${String(page)}`} />
        </Card>
      </div>
    </BaseLayout>
  );
}
