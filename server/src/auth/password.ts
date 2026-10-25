import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../errors.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

// scrypt ships with Node, so there is no native module to compile on Railway. Format: scrypt$N$r$p$salt$hash (base64).
const N = 16_384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compared against when the username does not exist, so "no such user" takes as long as "wrong password".
export const DUMMY_HASH = await hashPassword('not-a-real-password-just-for-timing');

export function checkPasswordRules(password: string, username: string): void {
  if (password.length < 10) throw new HttpError(422, 'PASSWORD_TOO_SHORT', 'A password needs at least 10 characters.');
  if (password.length > 200) throw new HttpError(422, 'PASSWORD_TOO_LONG', 'That password is too long.');
  if (password.toLowerCase().includes(username.toLowerCase())) throw new HttpError(422, 'PASSWORD_CONTAINS_USERNAME', 'A password cannot contain your username.');
  if (new Set(password).size < 4) throw new HttpError(422, 'PASSWORD_TOO_SIMPLE', 'Use a less repetitive password.');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no look-alike characters
/** A one-time password for a new or reset account. The person must change it at first login. */
export function temporaryPassword(): string {
  const bytes = randomBytes(14);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10)}`;
}
