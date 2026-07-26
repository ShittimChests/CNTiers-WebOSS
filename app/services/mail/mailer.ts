import { config } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { passwordResetMail, verificationMail, type RenderedMail } from './templates.js';

/**
 * 发信接口。抽出来是为了让测试注入 FakeMailer——注册流程的测试不该
 * 依赖外部 HTTP 服务，也不该真的发邮件。
 */
export interface Mailer {
  sendVerificationCode(to: string, code: string, recipientName: string): Promise<void>;
  sendPasswordResetCode(to: string, code: string, recipientName: string): Promise<void>;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend 的 HTTP API，手写 fetch 不引 SDK（延续本项目既有取舍：
 * 两个外部集成都只用到一个端点，SDK 的收益不抵依赖成本）。
 */
export class ResendMailer implements Mailer {
  async sendVerificationCode(to: string, code: string, recipientName: string): Promise<void> {
    await this.#deliver(to, verificationMail(code, recipientName));
  }

  async sendPasswordResetCode(to: string, code: string, recipientName: string): Promise<void> {
    await this.#deliver(to, passwordResetMail(code, recipientName));
  }

  async #deliver(to: string, mail: RenderedMail): Promise<void> {
    if (!config.mail.isConfigured) {
      throw new AppError('mail_not_configured');
    }

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.mail.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: config.mail.from,
          to: [to],
          subject: mail.subject,
          html: mail.html,
          text: mail.text
        })
      });
    } catch (cause) {
      // 网络层失败：DNS、超时、连接被拒
      throw new AppError('mail_send_failed', { cause });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // 4xx 多半是 EMAIL_FROM 的域名未在 Resend 验证，日志里要能看出来
      console.error(`[mail] Resend 返回 ${String(response.status)}: ${detail.slice(0, 300)}`);
      throw new AppError('mail_send_failed', {
        meta: { status: response.status }
      });
    }
  }
}

export interface SentMail {
  to: string;
  code: string;
  kind: 'verify' | 'reset';
}

/** 测试与本地开发用：不发信，只记录。 */
export class FakeMailer implements Mailer {
  readonly sent: SentMail[] = [];

  sendVerificationCode(to: string, code: string): Promise<void> {
    this.sent.push({ to, code, kind: 'verify' });
    return Promise.resolve();
  }

  sendPasswordResetCode(to: string, code: string): Promise<void> {
    this.sent.push({ to, code, kind: 'reset' });
    return Promise.resolve();
  }

  lastCode(kind?: SentMail['kind']): string | undefined {
    const pool = kind ? this.sent.filter((mail) => mail.kind === kind) : this.sent;
    return pool[pool.length - 1]?.code;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export const mailer: Mailer = new ResendMailer();
