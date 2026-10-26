import type { Role } from './permissions.js';
import { HttpError } from '../errors.js';

// Password rules, the same ones the legacy screens already show as live hints (Change password, Staff):
//  - admins and managers: at least 12 characters (a passphrase of a few words is fine)
//  - cashiers: at least 8 characters, and not only digits
//  - nobody: a very common password, their own name/email/phone/username, the shop's name, or a keyboard/number run
export const MIN_LENGTH: Record<Role, number> = { admin: 12, manager: 12, cashier: 8 };
export const MAX_LENGTH = 200;

// The most common passwords, plus the ones people in a shop environment actually pick. Compared after lower-casing and stripping
// trailing digits/symbols, so "Password123!" is caught as "password".
const COMMON = new Set(`
password passw0rd p@ssword p@ssw0rd pass pass1234 passcode passkey password1 secret secret123 letmein welcome welcome1 welcome123
admin admin123 administrator root toor changeme changeme123 changeme1 default guest user test testing test123 demo qwerty qwertyuiop
qwerty123 qwertyui asdfgh asdfghjkl asdf1234 zxcvbnm zxcvbn 1q2w3e4r 1qaz2wsx qazwsx abc123 abcd1234 abcdef abcdefgh abcdefghi iloveyou
iloveu monkey dragon master shadow sunshine princess football baseball soccer liverpool arsenal chelsea manutd manchester barcelona
realmadrid gor mahia gormahia kenya kenya123 nairobi nairobi123 mombasa kisumu nakuru eldoret thika kiambu safaricom mpesa mpesa123
airtel jambo jambo123 karibu karibu123 asante harambee mungu mungu123 jesus jesus123 godisgood blessed blessed123 god123 hakuna
matata hakunamatata urbantrends urbantrend urbantrends123 urban urban123 trends trends123 shop shop123 store store123 cashier cashier123
manager manager123 pos pos123 posadmin sales sales123 business business123 money money123 login login123 logmein trustno1 whatever
batman superman spiderman pokemon starwars naruto internet computer computer1 google facebook whatsapp instagram tiktok youtube
michael jennifer jordan hunter buster tigger soccer1 ashley bailey charlie donald freedom hello hello123 hellohello iloveyou1 lovely
love123 mother family friends friend ninja summer winter spring autumn december january monday sunday london paris
`.split(/\s+/).filter(Boolean));

const RUNS = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiopasdfghjklzxcvbnm', '1q2w3e4r5t6y7u8i9o0p'];

const normalise = (pw: string) => pw.toLowerCase().replace(/[^a-z0-9@$]/g, '');
const stripTail = (pw: string) => normalise(pw).replace(/[0-9@$]+$/g, '');
function isRun(pw: string): boolean {
  const p = pw.toLowerCase();
  if (/^(.)\1+$/.test(p)) return true; // aaaaaaaaaaaa
  const chunk = p.replace(/[^a-z0-9]/g, '');
  return chunk.length >= 6 && RUNS.some((r) => r.includes(chunk)); // 123456789012, qwertyuiop
}

export interface PasswordContext { role?: Role; username?: string; email?: string | null; displayName?: string | null; phone?: string | null }

/** Plain-language problems with a password. Empty means it is acceptable. */
export function passwordProblems(password: unknown, ctx: PasswordContext = {}): string[] {
  const problems: string[] = [];
  const pw = typeof password === 'string' ? password : '';
  const min = MIN_LENGTH[ctx.role ?? 'cashier'] ?? MIN_LENGTH.cashier;

  if (pw.length < min) problems.push(`Use at least ${min} characters${min >= 12 ? ' (a few random words in a row works well)' : ''}.`);
  if (pw.length > MAX_LENGTH) problems.push(`Use ${MAX_LENGTH} characters or fewer.`);
  if (pw && /^\d+$/.test(pw)) problems.push('A password made only of digits is too easy to guess.');

  const lower = pw.toLowerCase();
  const n = normalise(pw);
  if (n && (COMMON.has(n) || COMMON.has(stripTail(pw)))) problems.push('That password is very common. Choose something less predictable.');
  if (pw && isRun(pw)) problems.push('Avoid repeated characters and runs like 123456 or qwerty.');
  if (/urban\s*-?trend/i.test(pw)) problems.push("Don't use the shop's name in the password.");

  const personal: string[] = [];
  if (ctx.username) personal.push(ctx.username);
  if (ctx.email) personal.push(String(ctx.email).split('@')[0]!);
  if (ctx.displayName) personal.push(...String(ctx.displayName).split(/\s+/));
  if (ctx.phone) personal.push(String(ctx.phone).replace(/\D/g, '').slice(-9));
  for (const part of personal) {
    const p = part.toLowerCase();
    if (p.length >= 5 && lower.includes(p)) { problems.push('Do not include your name, username, email or phone number.'); break; }
  }
  return problems;
}

/** Throws a 422 listing every problem. */
export function assertStrongPassword(password: unknown, ctx: PasswordContext = {}): void {
  const problems = passwordProblems(password, ctx);
  if (problems.length) throw new HttpError(422, 'WEAK_PASSWORD', `Choose a stronger password. ${problems.join(' ')}`, { problems });
}
