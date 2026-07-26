import { upsertRow } from '../db/upsert.js';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/domain.js';
import { BaseRepository } from './base.js';

type SettingsKey = keyof AppSettings;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 设置以 key/value 行存储，每个顶层字段一行，值是 JSON 文本。
 *
 * 读取时逐字段与默认值合并，缺失或损坏的行退回默认——单个字段写坏
 * 不该让整个站点起不来。旧实现在这里的做法是 catch 后把所有开关静默关掉，
 * 且不留日志；这里改为按字段降级并告警。
 */
export class SettingsRepository extends BaseRepository {
  async load(): Promise<AppSettings> {
    const rows = await this.db.selectFrom('settings').selectAll().execute();
    const stored = new Map(rows.map((row) => [row.setting_key, row.setting_value]));

    return {
      registrationEnabled: this.#readBoolean(stored, 'registrationEnabled'),
      oauthEnabled: this.#readBoolean(stored, 'oauthEnabled'),
      oauthMicrosoft: this.#readMicrosoft(stored)
    };
  }

  /** 只写调用方给出的字段，其余保持不变。 */
  async save(patch: Partial<AppSettings>): Promise<void> {
    const entries = Object.entries(patch) as [SettingsKey, unknown][];
    if (entries.length === 0) return;

    const driver = this.driver;
    await this.db.transaction().execute(async (trx) => {
      for (const [key, value] of entries) {
        if (value === undefined) continue;
        const serialized = JSON.stringify(value);
        await upsertRow(
          trx.insertInto('settings').values({ setting_key: key, setting_value: serialized }),
          driver,
          ['setting_key'],
          { setting_value: serialized }
        ).execute();
      }
    });
  }

  #parse(stored: Map<string, string>, key: SettingsKey): unknown {
    const raw = stored.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`设置项 ${key} 的存储值不是合法 JSON，已退回默认值。`);
      return undefined;
    }
  }

  #readBoolean(stored: Map<string, string>, key: 'registrationEnabled' | 'oauthEnabled'): boolean {
    const value = this.#parse(stored, key);
    return typeof value === 'boolean' ? value : DEFAULT_SETTINGS[key];
  }

  #readMicrosoft(stored: Map<string, string>): AppSettings['oauthMicrosoft'] {
    const value = this.#parse(stored, 'oauthMicrosoft');
    if (!isPlainObject(value)) return { ...DEFAULT_SETTINGS.oauthMicrosoft };
    const clientId = value['clientId'];
    const tenant = value['tenant'];
    return {
      clientId: typeof clientId === 'string' ? clientId : DEFAULT_SETTINGS.oauthMicrosoft.clientId,
      /*
       * 与 clientId 同一个形状：只有「存的根本不是字符串」才退回默认值。
       *
       * 原来这里对空串也退回默认，而当时的默认值是 'common'——于是「在面板上把
       * 租户清空」这个动作根本存不下来，读回来又变成 'common'，把 MS_OAUTH_TENANT
       * 挡在外面。空串是合法的「未配置」，必须能原样存取。
       */
      tenant: typeof tenant === 'string' ? tenant : DEFAULT_SETTINGS.oauthMicrosoft.tenant
    };
  }
}

export const settingsRepository = new SettingsRepository();
