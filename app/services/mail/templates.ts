/**
 * 邮件 HTML 模板。
 *
 * 这里的内联样式是必需的，与站点的 CSP 纪律无关 —— 邮件客户端普遍不支持
 * 外部样式表，也会剥离 <style> 块。配色与站点设计 token 手工对齐
 * （黑曜石底 + 附魔金），改站点主题时记得同步这里。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface CodeEmailInput {
  eyebrow: string;
  heading: string;
  intro: string;
  code: string;
  footnote: string;
}

export function codeEmailHtml({ eyebrow, heading, intro, code, footnote }: CodeEmailInput): string {
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html lang="zh-CN"><body style="margin:0;padding:0;background:#0F0C16;font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',Helvetica,Arial,sans-serif;color:#EFECF7;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <div style="background:#171226;border:1px solid #2F2749;border-radius:8px;padding:28px;">
      <p style="color:#F2C14E;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 8px 0;font-size:12px;">${e(eyebrow)}</p>
      <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;color:#EFECF7;font-weight:700;">${e(heading)}</h1>
      <p style="margin:0 0 16px 0;color:#B3ACC9;line-height:1.75;">${e(intro)}</p>
      <div style="margin:24px 0;text-align:center;background:#0F0C16;border:1px solid #443A66;border-radius:4px;padding:20px 24px;">
        <p style="margin:0 0 6px 0;color:#B3ACC9;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;">验证码 / VERIFICATION CODE</p>
        <p style="margin:0;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:36px;font-weight:700;letter-spacing:0.4em;color:#F2C14E;">${e(code)}</p>
      </div>
      <p style="margin:0;color:#B3ACC9;font-size:13px;line-height:1.7;">5 分钟内有效，仅可使用一次。请将代码输入到打开的页面中完成验证。</p>
      <hr style="border:none;border-top:1px solid #2F2749;margin:24px 0;"/>
      <p style="margin:0;color:#8A83A6;font-size:12px;">${e(footnote)}</p>
    </div>
  </div>
</body></html>`;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export function verificationMail(code: string, recipientName: string): RenderedMail {
  return {
    subject: 'CNTiers 邮箱验证码',
    html: codeEmailHtml({
      eyebrow: 'SUBTIER STAFF',
      heading: `${recipientName || '玩家'}，欢迎加入`,
      intro: '在打开的注册页面输入下方 6 位验证码完成邮箱验证。',
      code,
      footnote: '如果不是你本人请求的注册，忽略本邮件即可。'
    }),
    text: `CNTiers 邮箱验证码：${code}\n\n5 分钟内有效，仅可使用一次。如果不是你本人请求，忽略本邮件即可。`
  };
}

export function passwordResetMail(code: string, recipientName: string): RenderedMail {
  return {
    subject: 'CNTiers 密码重置验证码',
    html: codeEmailHtml({
      eyebrow: 'SUBTIER STAFF',
      heading: `${recipientName || '玩家'}，重置你的密码`,
      intro: '在打开的密码重置页面输入下方 6 位验证码，并设置新密码。',
      code,
      footnote: '如果不是你本人请求的，请直接忽略本邮件。'
    }),
    text: `CNTiers 密码重置验证码：${code}\n\n5 分钟内有效，仅可使用一次。如果不是你本人请求，忽略本邮件即可。`
  };
}
