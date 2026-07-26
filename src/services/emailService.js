const crypto = require('node:crypto');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const VERIFY_TTL_MS = 5 * 60 * 1000;
const RESET_TTL_MS = 5 * 60 * 1000;
const MAIL_COOLDOWN_MS = 30 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

function codeEmailShell({ eyebrow, heading, intro, code, footnote }) {
  const safe = (v) => escapeHtml(v);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0d1f33;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#edf3ff;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <div style="background:linear-gradient(180deg,rgba(118,215,255,0.13),rgba(118,215,255,0.04));border:1px solid rgba(118,215,255,0.22);border-radius:18px;padding:28px;">
      <p style="color:#a4f3ff;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 8px 0;font-size:12px;">${safe(eyebrow)}</p>
      <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.2;color:#edf3ff;">${safe(heading)}</h1>
      <p style="margin:0 0 16px 0;color:#9eb0c9;line-height:1.65;">${safe(intro)}</p>
      <div style="margin:24px 0;text-align:center;background:rgba(7,17,31,0.55);border:1px solid rgba(118,215,255,0.32);border-radius:14px;padding:20px 24px;">
        <p style="margin:0 0 6px 0;color:#9eb0c9;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;">验证码 / VERIFICATION CODE</p>
        <p style="margin:0;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:36px;font-weight:700;letter-spacing:0.4em;color:#a4f3ff;">${safe(code)}</p>
      </div>
      <p style="margin:0;color:#9eb0c9;font-size:13px;line-height:1.6;">5 分钟内有效，仅可使用一次。请将代码输入到打开的页面中完成验证。</p>
      <hr style="border:none;border-top:1px solid rgba(130,159,196,0.22);margin:24px 0;"/>
      <p style="margin:0;color:#6f819b;font-size:12px;">${safe(footnote)}</p>
    </div>
  </div>
</body></html>`;
}

async function deliver({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY 未配置');
  // 不再把某个具体地址写成兜底默认值：配置缺失时应当明确报错，
  // 而不是悄悄用别人的域名发信（新站的 app/config/env.ts 也是这个语义）
  const fromAddress = process.env.EMAIL_FROM;
  if (!fromAddress) throw new Error('EMAIL_FROM 未配置');
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress, to: [to], subject, html, text })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend API ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function sendVerificationCode({ to, code, recipientName }) {
  const subject = "CN Subtiers 邮箱验证码";
  const html = codeEmailShell({
    eyebrow: 'SUBTIER STAFF',
    heading: `${recipientName || '玩家'}，欢迎加入`,
    intro: '在打开的注册页面输入下方 6 位验证码完成邮箱验证。',
    code,
    footnote: '如果不是你本人请求的注册，忽略本邮件即可。'
  });
  const text = `CN Subtiers 邮箱验证码：${code}\n\n5 分钟内有效，仅可使用一次。如果不是你本人请求，忽略本邮件即可。`;
  return deliver({ to, subject, html, text });
}

async function sendPasswordResetCode({ to, code, recipientName }) {
  const subject = "CN Subtiers 密码重置验证码";
  const html = codeEmailShell({
    eyebrow: 'SUBTIER STAFF',
    heading: `${recipientName || '玩家'}，重置你的密码`,
    intro: '在打开的密码重置页面输入下方 6 位验证码，并设置新密码。',
    code,
    footnote: '如果不是你本人请求的，请直接忽略本邮件。'
  });
  const text = `CN Subtiers 密码重置验证码：${code}\n\n5 分钟内有效，仅可使用一次。如果不是你本人请求，忽略本邮件即可。`;
  return deliver({ to, subject, html, text });
}

module.exports = {
  sendVerificationCode,
  sendPasswordResetCode,
  generateCode,
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  MAIL_COOLDOWN_MS,
  MAX_CODE_ATTEMPTS
};
