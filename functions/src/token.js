// Stateless, HMAC-SHA256 signed session tokens.
// Format: v1.<base64url(JSON payload)>.<base64url(signature)>
// Payload: { u: user id, iat: issued-at, exp: expiry, at: time of the original login } (unix seconds)
import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken({ user, authTime, now, ttlSeconds, maxAgeSeconds }, secret) {
  const iat = Math.floor(now / 1000);
  const at = authTime ?? iat;
  const exp = Math.min(iat + ttlSeconds, at + maxAgeSeconds);
  const payload = Buffer.from(JSON.stringify({ u: user, iat, exp, at })).toString('base64url');
  const data = `${VERSION}.${payload}`;
  return { token: `${data}.${sign(data, secret)}`, expiresAt: exp * 1000 };
}

/** Returns the payload or null (bad format, bad signature, expired, unknown user). */
export function verifyToken(token, secret, { now, users, maxAgeSeconds }) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const nowSec = Math.floor(now / 1000);
  if (!payload || !users.includes(payload.u)) return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= nowSec) return null;
  if (!Number.isInteger(payload.at) || payload.at + maxAgeSeconds <= nowSec) return null;
  return payload;
}

/** Constant-time comparison of a submitted access code with the configured secret. */
export function secretEquals(submitted, configured) {
  if (typeof submitted !== 'string' || typeof configured !== 'string' || !configured) return false;
  // Hash both sides first so the comparison length never depends on the input.
  const key = 'asia2026-access-code';
  const a = createHmac('sha256', key).update(submitted).digest();
  const b = createHmac('sha256', key).update(configured).digest();
  return timingSafeEqual(a, b);
}
