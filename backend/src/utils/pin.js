const ApiError = require('./ApiError');

// A register PIN is a short shortcut, so the only protection it can have is that
// it is not obvious. 4-6 digits, and none of the first things anyone would try.
const COMMON = new Set(['1234', '4321', '0000', '1212', '2580', '1004', '2000', '1122', '6969', '123456', '654321', '000000', '121212', '112233']);

function isWeakPin(pin) {
  const p = String(pin);
  if (COMMON.has(p)) return true;
  if (/^(\d)\1+$/.test(p)) return true; // 1111, 777777
  const d = p.split('').map(Number);
  const step = d[1] - d[0];
  return Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step); // 2345, 9876
}

// Throws ApiError(400) unless the PIN is acceptable. Pass undefined/'' to skip (PIN is optional).
function assertValidPin(pin) {
  if (pin === undefined || pin === null || pin === '') return;
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
    throw new ApiError(400, 'A register PIN must be 4 to 6 digits.');
  }
  if (isWeakPin(pin)) {
    throw new ApiError(400, 'That PIN is too easy to guess (like 1234, 0000 or 1111). Choose another.');
  }
}

module.exports = { assertValidPin, isWeakPin };
