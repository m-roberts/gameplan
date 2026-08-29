import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function opaqueToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token, secret) {
  if (!secret) throw new Error('a token hashing secret is required');
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function newId() {
  return randomUUID();
}

export function hashesEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
