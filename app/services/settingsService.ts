import { config } from '../config/env.js';
import { settingsRepository, type SettingsRepository } from '../repositories/settingsRepository.js';
import type { AppSettings } from '../types/domain.js';

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

  constructor(private readonly repository: SettingsRepository = settingsRepository) {}

  async get(): Promise<AppSettings> {
    if (this.#cache) return this.#cache;
    // 并发首读共享同一次查询，避免击穿
    this.#inflight ??= this.repository
      .load()
      .then((settings) => {
        this.#cache = settings;
        return settings;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  async save(patch: Partial<AppSettings>): Promise<AppSettings> {
    await this.repository.save(patch);
    this.#cache = null;
    return this.get();
  }

  invalidate(): void {
    this.#cache = null;
  }

  /**
   * Microsoft 登录是否真的可用：三个条件缺一不可。
   * client_secret 只认环境变量——密钥不该出现在数据库或后台表单里。
   */
  async isMicrosoftEnabled(): Promise<boolean> {
    const settings = await this.get();
    if (!settings.oauthEnabled) return false;
    const clientId = settings.oauthMicrosoft.clientId || config.microsoft.clientId;
    return clientId.length > 0 && config.microsoft.clientSecret.length > 0;
  }

  /** 合并后的 Microsoft 配置：数据库优先，环境变量兜底。 */
  async microsoftConfig(): Promise<{ clientId: string; tenant: string; clientSecret: string }> {
    const settings = await this.get();
    return {
      clientId: settings.oauthMicrosoft.clientId || config.microsoft.clientId,
      tenant: settings.oauthMicrosoft.tenant || config.microsoft.tenant,
      clientSecret: config.microsoft.clientSecret
    };
  }
}

export const settingsService = new SettingsService();
