import { HttpError } from '../errors.js';

// A register PIN is a short shortcut, so the only protection it has is that it is not obvious: 4 to 6 digits, and none of the
// first things anyone would try. There is no default PIN anywhere.
const COMMON = new Set(['1234', '4321', '0000', '1212', '2580', '1004', '2000', '1122', '6969', '123456', '654321', '000000', '121212', '112233']);

export function isWeakPin(pin: string): boolean {
  if (COMMON.has(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true; // 1111, 777777
  const d = pin.split('').map(Number);
  const step = d[1]! - d[0]!;
  return Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1]! === step); // 2345, 9876
}

export function assertValidPin(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) throw new HttpError(422, 'PIN_FORMAT', 'A register PIN must be 4 to 6 digits.');
  if (isWeakPin(pin)) throw new HttpError(422, 'PIN_TOO_WEAK', 'That PIN is too easy to guess (like 1234, 0000 or 1111). Choose another.');
}
