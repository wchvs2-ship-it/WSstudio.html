import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const HASH_PATTERN = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

export function isPasswordHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('A senha precisa ter entre 12 e 256 caracteres.');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.match(HASH_PATTERN) : null;
  if (!parts || typeof password !== 'string' || password.length > 256) return false;
  const actual = scryptSync(password, Buffer.from(parts[1], 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}
