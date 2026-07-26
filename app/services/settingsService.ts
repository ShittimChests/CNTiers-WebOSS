import { config } from '../config/env.js';
import { settingsRepository, type SettingsRepository } from '../repositories/settingsRepository.js';
import type { AppSettings } from '../types/domain.js';

/**
 * Azure 的 `common` / `organizations` / `consumers` 是**受众选择器**，不是租户限制：
 * common 接受个人账户与任意组织，organizations 接受任意组织，consumers 只接受个人账户。
 * 真正把登录限制在一个租户里的，只有租户 ID 或域名。
 * 见 https://learn.microsoft.com/entra/identity-platform/v2-protocols
 *
 * 这个区分是 resolveTenant 的全部依据：既然这三个值都不构成限制，
 * 它们就不该把 MS_OAUTH_TENANT 里那个具体租户挡在外面。
 */
const PSEUDO_TENANTS = new Set(['common', 'organizations', 'consumers']);

/** 两处都没配时的最终默认值，与 Azure 自己的默认受众一致。 */
const DEFAULT_TENANT = 'common';

export type TenantSource = 'panel' | 'env' | 'default';

export interface TenantResolution {
  /** 实际拼进 authority URL 的值。 */
  value: string;
  /** 它来自哪里。后台设置页要如实说出来，否则被接管时面板上那个输入框就是在撒谎。 */
  source: TenantSource;
}

function isSpecificTenant(value: string): boolean {
  return value !== '' && !PSEUDO_TENANTS.has(value.toLowerCase());
}

/**
 * 合并面板与环境变量两处的租户配置。
 *
 * 规则一句话：**谁指定了具体租户就听谁的，面板优先；都没指定就保留受众选择器。**
 *
 * 刻意不是简单的 `panel || env`。原来就是那么写的，而它是坏的：面板值的未配置态
 * 曾经是 `'common'`（DEFAULT_SETTINGS 与 settingsSchema 各给了一份默认值，
 * `db:import` 还会从旧数据里再带一份进来），是个真值，于是 `||` 永远短路在左边——
 * MS_OAUTH_TENANT 从来没有生效过。旧站 `src/services/oauthService.js:21` 有同一个
 * 缺陷（配 `src/services/dataStore.js:18` 的同款默认值），重写时一起沿用了下来。
 *
 * 也刻意不是反过来的 `env || panel`。`.env.example` 里一直写着
 * `MS_OAUTH_TENANT=common`，照抄过的部署会用这个 `'common'` 把面板上那个具体租户
 * 覆盖掉——那是在**放宽**限制，比原来的缺陷更糟。
 *
 * 当前形状的不变量是**单调不放宽**：对任何一组输入，结果都不会比
 * 「面板值优先」那套旧行为更宽松（逐种组合的核对见 tests/unit/oauthTenant.test.ts）。
 * 这一条比「哪边优先」更重要——租户限制是安全控制项，改它只允许收紧。
 */
export function resolveTenant(panelTenant: string, envTenant: string): TenantResolution {
  const panel = panelTenant.trim();
  const env = envTenant.trim();

  if (isSpecificTenant(panel)) return { value: panel, source: 'panel' };
  if (isSpecificTenant(env)) return { value: env, source: 'env' };

  // 两边都只有受众选择器（或空）：保留面板上那个，其次环境变量，最后 common。
  // 不能在这里统一成 common——有人可能有意选了 organizations / consumers
  if (panel !== '') return { value: panel, source: 'panel' };
  if (env !== '') return { value: env, source: 'env' };
  return { value: DEFAULT_TENANT, source: 'default' };
}

/**
 * 站点设置的读写入口，带进程内缓存。
 *
 * 每个请求的 locals 中间件都要读一次设置，直落数据库太浪费；
 * 但缓存必须在写入后立刻失效，也必须在切库后失效（新库的设置可能不同）——
 * 后者由 dbSwitchService 调用 invalidate() 保证。
 */
export class SettingsService {
  #cache: AppSettings | null = null;
  #inflight: Promise<AppSettings> | null = null;
  /**
   * 失效代次。进行中的加载带着发起时的代次，回来时若代次已经变了就**不写缓存**。
   *
   * 没有它的话 invalidate() 拦不住一次已经在飞的读：
   *   请求 A get() → 查询打在旧库上 → 切库 → invalidate() 置空 →
   *   A 的查询返回 → 把切库前的设置又装回 #cache，一直留到下次写入或重启。
   * save() 是同一个形状的另一个入口：置空后调 get()，若此刻 #inflight 非空，
   * `??=` 会把那个**保存前**的 Promise 原样交回去，于是「保存」返回的是旧值。
   */
  #generation = 0;

  constructor(
    private readonly repository: SettingsRepository = settingsRepository,
    /**
     * 环境变量侧的 Microsoft 配置。可注入**仅仅**是为了让测试不必为它起子进程：
     * config 是模块加载时求值的冻结对象，测试里改 process.env 影响不到它，
     * 而这里要验的恰好是「环境变量能不能接管租户」。生产一律用 config.microsoft。
     */
    private readonly env: {
      clientId: string;
      clientSecret: string;
      tenant: string;
    } = config.microsoft
  ) {}

  async get(): Promise<AppSettings> {
    if (this.#cache) return this.#cache;
    const generation = this.#generation;
    // 并发首读共享同一次查询，避免击穿
    this.#inflight ??= this.repository
      .load()
      .then((settings) => {
        // 期间被 invalidate/save 过就只把结果交给调用方，不污染缓存
        if (generation === this.#generation) this.#cache = settings;
        return settings;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  async save(patch: Partial<AppSettings>): Promise<AppSettings> {
    await this.repository.save(patch);
    this.invalidate();
    return this.get();
  }

  invalidate(): void {
    this.#generation += 1;
    this.#cache = null;
    // 连同在飞的那次一起丢弃，否则下一个 get() 会复用它并拿到旧值
    this.#inflight = null;
  }

  /**
   * Microsoft 登录是否真的可用：三个条件缺一不可。
   * client_secret 只认环境变量——密钥不该出现在数据库或后台表单里。
   */
  async isMicrosoftEnabled(): Promise<boolean> {
    const settings = await this.get();
    if (!settings.oauthEnabled) return false;
    const clientId = settings.oauthMicrosoft.clientId || this.env.clientId;
    return clientId.length > 0 && this.env.clientSecret.length > 0;
  }

  /**
   * 合并后的 Microsoft 配置。
   *
   * clientId 用的是「面板优先、环境变量兜底」——它的未配置态是空串，`||` 能正常
   * 落到右边。tenant **不能**照抄这个形状，理由见 resolveTenant。
   */
  async microsoftConfig(): Promise<{ clientId: string; tenant: string; clientSecret: string }> {
    const settings = await this.get();
    return {
      clientId: settings.oauthMicrosoft.clientId || this.env.clientId,
      tenant: resolveTenant(settings.oauthMicrosoft.tenant, this.env.tenant).value,
      clientSecret: this.env.clientSecret
    };
  }

  /** 实际生效的租户及其来源，供后台设置页如实展示。 */
  async tenantInEffect(): Promise<TenantResolution> {
    const settings = await this.get();
    return resolveTenant(settings.oauthMicrosoft.tenant, this.env.tenant);
  }
}

export const settingsService = new SettingsService();
