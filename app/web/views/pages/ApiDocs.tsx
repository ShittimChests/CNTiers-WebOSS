import type { ComponentChildren } from 'preact';
import { API_CACHE_SECONDS, API_LIMITS, RATE_LIMITS } from '../../../config/constants.js';
import type { PageProps } from '../../../types/view.js';
import { Card } from '../components/ui.js';
import { BaseLayout } from '../layouts/BaseLayout.js';

export interface ApiDocsProps extends PageProps {
  /** 用请求自身的 host 拼，示例里的 curl 可直接复制运行。 */
  baseUrl: string;
}

interface Param {
  name: string;
  type: string;
  detail: string;
}

/** 公开 API 的说明。内容与 app/web/routes/apiV1.ts 的实现一一对应。 */
export function ApiDocsPage({ ctx, baseUrl }: ApiDocsProps) {
  return (
    <BaseLayout
      title="开放 API"
      ctx={ctx}
      description="CNTiers 的公开只读 JSON 接口说明。"
    >
      <div class="stack docs">
        <div>
          <p class="eyebrow">API v1</p>
          <h1>开放 API</h1>
          <p class="docs__lead">
            只读 JSON 接口，公开访问、允许跨域，无需鉴权。按 IP 限流
            {RATE_LIMITS.api.max} 次 / 分钟，成功响应缓存 {API_CACHE_SECONDS} 秒。
          </p>
        </div>

        <Card title="通用约定">
          <ul class="docs__list">
            <li>
              全部响应为 <Code>application/json; charset=utf-8</Code>。
            </li>
            <li>
              成功响应带 <Code>Cache-Control: public, max-age={String(API_CACHE_SECONDS)}</Code>。
            </li>
            <li>
              错误响应统一为 <Code>{'{ "error": "<码>", "message": "<说明>" }'}</Code>。
            </li>
            <li>
              错误码：<Code>invalid_query</Code> (400)、<Code>not_found</Code> /{' '}
              <Code>gamemode_not_found</Code> (404)、<Code>rate_limited</Code> (429)、
              <Code>internal_error</Code> (500)。
            </li>
            <li>被限流时返回 429 并带 <Code>Retry-After</Code> 响应头（单位：秒）。</li>
            <li>项目名与玩家名的查找都不区分大小写，响应里回的是规范大小写。</li>
          </ul>
        </Card>

        <Endpoint
          method="GET"
          path="/api/v1/gamemodes"
          summary="列出全部细分项目名，按字母序。"
          baseUrl={baseUrl}
          example={`{
  "gamemodes": ["Axe", "Crystal", "Sword"]
}`}
        />

        <Endpoint
          method="GET"
          path="/api/v1/rankings"
          summary="总榜，按名次升序。"
          baseUrl={baseUrl}
          query="?limit=20&offset=0"
          params={[
            {
              name: 'limit',
              type: `整数 ${String(API_LIMITS.rankingsLimit.min)}–${String(API_LIMITS.rankingsLimit.max)}`,
              detail: `每页条数，默认 ${String(API_LIMITS.rankingsLimit.default)}`
            },
            { name: 'offset', type: '整数 ≥ 0', detail: '跳过的条数，默认 0' }
          ]}
          example={`{
  "total": 132,
  "limit": 20,
  "offset": 0,
  "players": [
    { "name": "SharkIrene", "points": 1240, "rank": "SubtierGrandmaster", "position": 1 }
  ]
}`}
        />

        <Endpoint
          method="GET"
          path="/api/v1/rankings/{gamemode}"
          summary="某个细分项目的定级榜，按 tier 分成 5 个桶。"
          baseUrl={baseUrl}
          pathExample="/api/v1/rankings/Sword"
          query="?count=10&offset=0"
          params={[
            {
              name: 'count',
              type: `整数 ${String(API_LIMITS.gamemodeCount.min)}–${String(API_LIMITS.gamemodeCount.max)}`,
              detail: `每个桶返回的条数，默认 ${String(API_LIMITS.gamemodeCount.default)}。注意是**每桶**，因此一次调用最多返回 count × ${String(API_LIMITS.tierBuckets)} 人`
            },
            { name: 'offset', type: '整数 ≥ 0', detail: '每个桶内跳过的条数，默认 0' }
          ]}
          notes={[
            '桶键为 "1"–"5"，对应 tier 的数字部分；没有人的桶返回空数组。',
            '桶内排序：HT 先于 LT，然后按积分降序，最后按名字升序。',
            '存储值无法解析为 HT/LT + 1–5 时该条被跳过。'
          ]}
          example={`{
  "gamemode": "Sword",
  "count": 10,
  "offset": 0,
  "tiers": {
    "1": [
      { "name": "SharkIrene", "points": 1240, "rank": "SubtierGrandmaster",
        "position": 1, "tier": "HT1" }
    ],
    "2": [], "3": [], "4": [], "5": []
  }
}`}
        />

        <Endpoint
          method="GET"
          path="/api/v1/players/{name}"
          summary="单个玩家，含其在每个项目的定级。"
          baseUrl={baseUrl}
          pathExample="/api/v1/players/SharkIrene"
          notes={[
            'categories 会列出**每一个**已知项目，该玩家未定级的为 null。',
            '存储值无法解析时同样返回 null。'
          ]}
          example={`{
  "name": "SharkIrene",
  "points": 1240,
  "rank": "SubtierGrandmaster",
  "position": 1,
  "categories": { "Axe": null, "Crystal": "HT3", "Sword": "HT1" }
}`}
        />

        <Card title="稳定性">
          <p>
            v1 的响应字段只增不改：已有字段的名称、类型与语义不会变动。
            如需破坏性调整，会以 v2 路径发布。
          </p>
        </Card>
      </div>
    </BaseLayout>
  );
}

function Code({ children }: { children: ComponentChildren }) {
  return <code class="docs__code">{children}</code>;
}

interface EndpointProps {
  method: string;
  path: string;
  summary: string;
  baseUrl: string;
  pathExample?: string;
  query?: string;
  params?: Param[];
  notes?: string[];
  example: string;
}

function Endpoint({
  method,
  path,
  summary,
  baseUrl,
  pathExample,
  query,
  params,
  notes,
  example
}: EndpointProps) {
  const curlPath = `${pathExample ?? path}${query ?? ''}`;

  return (
    <Card>
      <div class="docs__endpoint">
        <p class="docs__route">
          <span class="docs__method">{method}</span>
          <code>{path}</code>
        </p>
        <p>{summary}</p>

        {params && params.length > 0 && (
          <div class="docs__table-wrap">
            <table class="docs__table">
              <thead>
                <tr>
                  <th scope="col">参数</th>
                  <th scope="col">取值</th>
                  <th scope="col">说明</th>
                </tr>
              </thead>
              <tbody>
                {params.map((param) => (
                  <tr key={param.name}>
                    <td>
                      <code>{param.name}</code>
                    </td>
                    <td>{param.type}</td>
                    <td>{param.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {notes && notes.length > 0 && (
          <ul class="docs__list">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

        <p class="docs__label">请求</p>
        <pre class="docs__pre">
          <code>{`curl '${baseUrl}${curlPath}'`}</code>
        </pre>

        <p class="docs__label">响应</p>
        <pre class="docs__pre">
          <code>{example}</code>
        </pre>
      </div>
    </Card>
  );
}
