'use strict';

const { createHash, createHmac } = require('node:crypto');

// Order references look like UT-7K49M2XQ: "UT-", seven letters/digits, one check character.
//
//   Unique by construction  a database sequence (1, 2, 3, ...) is passed through a keyed bijection, so no two
//                           sequence numbers can ever produce the same reference, and no collision check is needed.
//   Not guessable           the bijection scrambles the order: the reference after UT-AAAA... says nothing about the next.
//   Easy to type            32 characters, with look-alikes (0 O 1 I) removed, so nothing can be misread.
//   Typo-catching           the last character is a Luhn mod-32 check over the first seven.
//
// The scramble is a format-preserving Feistel cipher over 36 bits, "cycle-walked" down to the 35-bit (32^7) space.

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 characters: no 0, 1, I or O
const N = 32;
const SPACE = 2 ** 35; // 32^7 possible sequence values
const HALF_BITS = 18;
const HALF = 2 ** HALF_BITS;
const ROUNDS = 6;

const MIN_KEY_LENGTH = 32;

function assertKey(key) {
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) {
    throw new Error(`ORDER_REF_KEY must be set and at least ${MIN_KEY_LENGTH} characters long`);
  }
}

function roundFn(key, round, x) {
  const msg = Buffer.alloc(5);
  msg.writeUInt8(round, 0);
  msg.writeUInt32BE(x, 1);
  return createHmac('sha256', key).update(msg).digest().readUInt32BE(0) % HALF;
}

function feistelEncrypt(v, key) {
  let left = Math.floor(v / HALF);
  let right = v % HALF;
  for (let i = 0; i < ROUNDS; i++) {
    const next = (left ^ roundFn(key, i, right)) >>> 0;
    left = right;
    right = next;
  }
  return left * HALF + right;
}

function feistelDecrypt(v, key) {
  let left = Math.floor(v / HALF);
  let right = v % HALF;
  for (let i = ROUNDS - 1; i >= 0; i--) {
    const prev = (right ^ roundFn(key, i, left)) >>> 0;
    right = left;
    left = prev;
  }
  return left * HALF + right;
}

/** Bijection on [0, 2^35): each input maps to exactly one distinct output. */
function scramble(n, key) {
  assertKey(key);
  if (!Number.isInteger(n) || n < 0 || n >= SPACE) throw new RangeError(`sequence value ${n} is outside the reference space`);
  let v = n;
  do { v = feistelEncrypt(v, key); } while (v >= SPACE); // cycle-walk back into the domain
  return v;
}

function unscramble(v, key) {
  assertKey(key);
  if (!Number.isInteger(v) || v < 0 || v >= SPACE) throw new RangeError(`value ${v} is outside the reference space`);
  let n = v;
  do { n = feistelDecrypt(n, key); } while (n >= SPACE);
  return n;
}

function encode7(v) {
  let out = '';
  for (let i = 6; i >= 0; i--) out += ALPHABET[Math.floor(v / N ** i) % N];
  return out;
}

/** Luhn mod-32 check character for a string of ALPHABET characters. */
function checkChar(body) {
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const code = ALPHABET.indexOf(body[i]);
    if (code < 0) throw new Error(`"${body[i]}" is not a valid reference character`);
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return ALPHABET[(N - (sum % N)) % N];
}

/** The reference for a sequence number, e.g. 1 -> "UT-XXXXXXXX". */
function formatRef(sequenceValue, key) {
  const body = encode7(scramble(sequenceValue, key));
  return `UT-${body}${checkChar(body)}`;
}

const NEW_REF = new RegExp(`^(?:UT)?([${ALPHABET}]{8})$`);

/**
 * Accepts what a customer might actually type into the paybill account field: any case, with or without spaces,
 * the dash or the UT prefix. Returns the canonical "UT-XXXXXXXX", or null if it is not a valid reference
 * (wrong characters, wrong length, or a failed check character, i.e. a typo).
 */
function normalizeOrderRef(input) {
  const m = NEW_REF.exec(String(input).toUpperCase().replace(/[\s-]/g, ''));
  if (!m) return null;
  const body = m[1].slice(0, 7);
  return checkChar(body) === m[1][7] ? `UT-${m[1]}` : null;
}

/** Old-style codes such as UT000123 ("ut 000123" also accepted). They stay valid forever as aliases. */
function normalizeLegacyRef(input) {
  const s = String(input).toUpperCase().replace(/[\s-]/g, '');
  return /^UT[0-9]{6,}$/.test(s) ? s : null;
}

function isValidRef(ref) {
  return /^UT-/.test(ref) && normalizeOrderRef(ref) === ref;
}

/** Stored beside the first reference so a changed key is caught: a different key would silently re-scramble and could collide. */
function keyFingerprint(key) {
  assertKey(key);
  return createHash('sha256').update(`order-ref-key:${key}`).digest('hex').slice(0, 16);
}

module.exports = {
  ALPHABET, SPACE, MIN_KEY_LENGTH,
  scramble, unscramble, checkChar, formatRef,
  normalizeOrderRef, normalizeLegacyRef, isValidRef, keyFingerprint,
};
