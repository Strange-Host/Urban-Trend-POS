// The same password rules the server enforces (backend/src/utils/passwordPolicy.js), shown as live hints so people
// aren't surprised when a password is refused. The server still has the final word (it also blocks common passwords).
export const MIN_LENGTH = { admin: 12, manager: 12, cashier: 8 };

export function minLengthFor(role) {
  return MIN_LENGTH[role] || MIN_LENGTH.cashier;
}

export function passwordHint(role) {
  const min = minLengthFor(role);
  return min >= 12
    ? `At least ${min} characters. A few random words in a row (like "violet harbour tennis 42") is easy to remember and strong.`
    : `At least ${min} characters, and not only digits. Avoid names, your phone number and common passwords.`;
}

/** Quick client-side checks for a ✓/✗ list. Returns [{ ok, text }]. */
export function passwordChecks(password, role) {
  const min = minLengthFor(role);
  return [
    { ok: password.length >= min, text: `${min}+ characters` },
    { ok: password.length > 0 && !/^\d+$/.test(password), text: 'Not only digits' },
  ];
}
