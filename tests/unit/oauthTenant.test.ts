/**
 * Microsoft 租户的合并规则。
 *
 * 这里守的是一个安全控制项而不是普通配置：`tenant=common` 表示接受任意 Azure 租户，
 * 配合 oauthService.loginWithMicrosoft 里「按 subject 找不到就退回按邮箱找」那条兜底，
 * 等于允许任何人在自己的租户里把某个用户的 `mail` 设成站内用户的邮箱后以其身份登录。
 * 于是「MS_OAUTH_TENANT 能不能真的锁住租户」是一条安全断言。
 *
 * 修复前它锁不住：面板值的未配置态是 'common'（DEFAULT_SETTINGS、settingsSchema、
 * legacyImport 各给了一份），而合并写的是 `panel || env`——真值永远短路在左边，
 * 环境变量从来没有机会。本文件里凡是 env 应当接管的用例，在修复前都会拿到 'common'。
 */
import { describe, expect, it } from 'vitest';
import { SettingsService, resolveTenant } from '../../app/services/settingsService.js';
import type { SettingsRepository } from '../../app/repositories/settingsRepository.js';
import type { AppSettings } from '../../app/types/domain.js';
import { DEFAULT_SETTINGS } from '../../app/types/domain.js';

const SPECIFIC = '11111111-2222-3333-4444-555555555555';
const OTHER_SPECIFIC = 'contoso.onmicrosoft.com';

/** 只认 tenant 的假 repository，其余字段无关。 */
function serviceWith(panelTenant: string, envTenant: string): SettingsService {
  const settings: AppSettings = {
    registrationEnabled: false,
    oauthEnabled: true,
    oauthMicrosoft: { clientId: 'client', tenant: panelTenant }
  };
  const repository = {
    load: () => Promise.resolve(settings),
    save: () => Promise.resolve()
  } as unknown as SettingsRepository;

  return new SettingsService(repository, {
    clientId: '',
    clientSecret: 'secret',
    tenant: envTenant
  });
}

describe('租户合并', () => {
  describe('环境变量能真正锁住租户', () => {
    it('面板是默认的 common 时，MS_OAUTH_TENANT 接管', async () => {
      // 修复前：panel('common') || env → 'common'，环境变量被永久遮蔽
      const config = await serviceWith('common', SPECIFIC).microsoftConfig();
      expect(config.tenant).toBe(SPECIFIC);
    });

    it('面板留空时，MS_OAUTH_TENANT 接管', async () => {
      const config = await serviceWith('', SPECIFIC).microsoftConfig();
      expect(config.tenant).toBe(SPECIFIC);
    });

    it('organizations / consumers 同样不构成租户限制，不该挡住环境变量', async () => {
      // 三个伪租户都是「受众选择器」，只有租户 ID / 域名才是限制
      for (const pseudo of ['organizations', 'consumers']) {
        const config = await serviceWith(pseudo, SPECIFIC).microsoftConfig();
        expect(config.tenant, `面板值 ${pseudo}`).toBe(SPECIFIC);
      }
    });

    it('大小写不同的 common 也算伪租户', async () => {
      const config = await serviceWith('COMMON', SPECIFIC).microsoftConfig();
      expect(config.tenant).toBe(SPECIFIC);
    });

    it('db:import 带进来的 common 不会把环境变量挡住', async () => {
      // 旧站 settings.json 里 tenant 几乎必然是 'common'（src/services/dataStore.js:18），
      // 导入会忠实沿用；它必须不构成遮蔽，否则切换上线后这个变量又是死的
      const config = await serviceWith('common', SPECIFIC).microsoftConfig();
      expect(config.tenant).toBe(SPECIFIC);
    });
  });

  describe('绝不放宽既有限制', () => {
    it('面板配了具体租户时，环境变量里的 common 不得覆盖它', async () => {
      // .env.example 长期写着 MS_OAUTH_TENANT=common，照抄过的部署很多。
      // 若把优先级简单反转成 env || panel，这里就会退回 'common' —— 放宽了限制
      const config = await serviceWith(OTHER_SPECIFIC, 'common').microsoftConfig();
      expect(config.tenant).toBe(OTHER_SPECIFIC);
    });

    it('两边都是具体租户时以面板为准（与既有语义一致）', async () => {
      const config = await serviceWith(OTHER_SPECIFIC, SPECIFIC).microsoftConfig();
      expect(config.tenant).toBe(OTHER_SPECIFIC);
    });

    it('单调不放宽：任何组合都不比「面板值优先」的旧行为更宽松', () => {
      const values = ['', 'common', 'organizations', 'consumers', SPECIFIC, OTHER_SPECIFIC];
      const unrestricted = new Set(['', 'common', 'organizations', 'consumers']);

      for (const panel of values) {
        for (const env of values) {
          const now = resolveTenant(panel, env).value;
          // 旧行为：panel || env，且 env 的 zod 默认值是 'common'
          const before = panel || env || 'common';

          // 只要旧行为限制到了某个具体租户，新行为必须限制到**同一个**租户
          if (!unrestricted.has(before)) {
            expect(now, `panel=${panel || '(空)'} env=${env || '(空)'}`).toBe(before);
          }
          // 新行为绝不会从「已限制」退回「不限制」
          if (!unrestricted.has(before)) {
            expect(unrestricted.has(now), `panel=${panel || '(空)'} env=${env || '(空)'}`).toBe(
              false
            );
          }
        }
      }
    });
  });

  describe('都没指定具体租户时', () => {
    it('两边全空退回 common', () => {
      expect(resolveTenant('', '')).toEqual({ value: 'common', source: 'default' });
    });

    it('保留面板上有意选的受众选择器，不统一成 common', () => {
      expect(resolveTenant('organizations', '')).toEqual({
        value: 'organizations',
        source: 'panel'
      });
      expect(resolveTenant('', 'consumers')).toEqual({ value: 'consumers', source: 'env' });
    });
  });

  describe('来源要能如实报出来（后台设置页据此展示）', () => {
    it('被环境变量接管时 source 是 env', async () => {
      expect(await serviceWith('common', SPECIFIC).tenantInEffect()).toEqual({
        value: SPECIFIC,
        source: 'env'
      });
    });

    it('面板值生效时 source 是 panel', async () => {
      expect(await serviceWith(OTHER_SPECIFIC, SPECIFIC).tenantInEffect()).toEqual({
        value: OTHER_SPECIFIC,
        source: 'panel'
      });
    });

    it('两边都没配时 source 是 default', async () => {
      expect(await serviceWith('', '').tenantInEffect()).toEqual({
        value: 'common',
        source: 'default'
      });
    });
  });

  describe('未配置态', () => {
    it('DEFAULT_SETTINGS 里的 tenant 必须是空串', () => {
      /*
       * 这条看着像恒真断言，但它守的是一个真实发生过的缺陷：这里一旦写回 'common'，
       * `panel || env` 就永远短路在左边，MS_OAUTH_TENANT 又变成死旋钮，
       * 而上面那些用例里只有「面板是默认值」那几条会挂——很容易被误判成用例写错了。
       */
      expect(DEFAULT_SETTINGS.oauthMicrosoft.tenant).toBe('');
    });

    it('空白字符不算配置', async () => {
      const config = await serviceWith('   ', SPECIFIC).microsoftConfig();
      expect(config.tenant).toBe(SPECIFIC);
    });
  });
});
