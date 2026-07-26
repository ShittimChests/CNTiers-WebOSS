import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { CODE_LENGTH } from '../config/constants.js';

/** 随机十六进制令牌，用于 CSRF token、OAuth state 等。 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** PKCE code_verifier（RFC 7636），base64url 无填充。 */
export function generatePkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE code_challenge = BASE64URL(SHA256(verifier))。 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * 定长比较。长度不同直接返回 false —— 这会泄漏长度，但对验证码/令牌
 * 这类固定长度的秘密无实际影响，而 timingSafeEqual 要求等长入参。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 均匀分布的 N 位数字验证码（避免 Math.random 的可预测性）。 */
export function generateNumericCode(length: number = CODE_LENGTH): string {
  let out = '';
  while (out.length < length) {
    // 每次取 1 字节，丢弃 >= 250 的值以消除模偏置（250 = 25 * 10）
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 250) continue;
      out += String(byte % 10);
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * 从会话密钥派生用途隔离的子密钥。同一个 SESSION_SECRET 既签会话又护验证码，
 * 直接复用会让两处共享同一密钥材料；HKDF 让它们互不影响。
 */
export function deriveKey(secret: string, purpose: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', `subtier:${purpose}`, length));
}

/**
 * 验证码落库前的单向处理。6 位码空间只有 10^6，裸 SHA256 可秒级枚举，
 * 用带密钥的 HMAC 使「数据库只读泄露」无法离线还原验证码。
 */
export function hmacCode(key: Buffer, code: string): string {
  return createHmac('sha256', key).update(code).digest('hex');
}
