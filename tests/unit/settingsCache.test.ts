/**
 * 设置缓存的失效语义。
 *
 * 用一个可控的假 repository 而不是真数据库：这里要测的是「加载在飞的时候被
 * invalidate 掉」这个时序，真库的往返太快，窗口不可控。
 */
import { describe, expect, it } from 'vitest';
import { SettingsService } from '../../app/services/settingsService.js';
import type { SettingsRepository } from '../../app/repositories/settingsRepository.js';
import type { AppSettings } from '../../app/types/domain.js';

function settings(clientId: string): AppSettings {
  return {
    registrationEnabled: false,
    oauthEnabled: false,
    oauthMicrosoft: { clientId, tenant: 'common' }
  };
}

/** load() 挂起，直到测试显式放行——用来制造「加载在飞」的窗口。 */
function deferredRepository() {
  let release: ((value: AppSettings) => void) | undefined;
  let loads = 0;

  const repository = {
    load: () => {
      loads += 1;
      return new Promise<AppSettings>((resolve) => {
        release = resolve;
      });
    },
    save: () => Promise.resolve()
  } as unknown as SettingsRepository;

  return {
    repository,
    loadCount: () => loads,
    release: (value: AppSettings) => {
      const resolve = release;
      if (!resolve) throw new Error('还没有进行中的 load()');
      release = undefined;
      resolve(value);
    }
  };
}

describe('设置缓存', () => {
  it('并发首读只打一次库', async () => {
    const fake = deferredRepository();
    const service = new SettingsService(fake.repository);

    const first = service.get();
    const second = service.get();
    fake.release(settings('A'));

    expect((await first).oauthMicrosoft.clientId).toBe('A');
    expect((await second).oauthMicrosoft.clientId).toBe('A');
    expect(fake.loadCount()).toBe(1);
  });

  it('invalidate 之后，进行中的那次加载不会把旧值写回缓存', async () => {
    /*
     * 这正是切库时的时序：
     *   请求 A get() → 查询打在旧库上 → 切库 → invalidate() 置空 →
     *   A 的查询返回。
     * 少了代次判断的话，A 会把切库前的设置重新装进 #cache，一直留到下次写入
     * 或进程重启——而 dbSwitchService 调用 invalidate() 的全部意义就是避免这个。
     */
    const fake = deferredRepository();
    const service = new SettingsService(fake.repository);

    const inflight = service.get();
    service.invalidate();
    fake.release(settings('切库前'));

    // 调用方仍然拿到它自己那次查询的结果，这没问题
    expect((await inflight).oauthMicrosoft.clientId).toBe('切库前');

    // 但缓存必须是空的：下一次 get() 要重新打库
    const next = service.get();
    fake.release(settings('切库后'));
    expect((await next).oauthMicrosoft.clientId).toBe('切库后');
    expect(fake.loadCount()).toBe(2);
  });

  it('save 不会复用保存前就已经在飞的那次加载', async () => {
    // save() 置空缓存后立刻 get()，若沿用 `??=` 会把保存前的 Promise 原样交回去，
    // 于是「保存设置」返回并缓存的是旧值
    const fake = deferredRepository();
    const service = new SettingsService(fake.repository);

    const stale = service.get();
    const saved = service.save({ registrationEnabled: true });

    // 先放行保存前那次，再放行 save 自己触发的那次
    fake.release(settings('保存前'));
    await stale;
    fake.release(settings('保存后'));

    expect((await saved).oauthMicrosoft.clientId).toBe('保存后');
    expect(fake.loadCount()).toBe(2);
  });
});
