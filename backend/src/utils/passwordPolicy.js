const ApiError = require('./ApiError');

// Password rules (see also the live hints in the frontend, pages/ChangePassword + Staff):
//  - admins and managers: at least 12 characters (a passphrase of a few words is fine)
//  - cashiers: at least 8 characters, and not only digits
//  - nobody: a very common password, their own name/email, the shop's name, or a keyboard/number run
//  - 72 characters at most: the hashing algorithm silently ignores anything after that
const MIN_LENGTH = { admin: 12, manager: 12, cashier: 8 };
const MAX_LENGTH = 72;

// The most common passwords, plus the ones people in a shop environment actually pick. Compared after
// lower-casing and stripping trailing digits/symbols, so "Password123!" is caught as "password".
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

function normalise(pw) {
  return String(pw).toLowerCase().replace(/[^a-z0-9@$]/g, '');
}
function stripTail(pw) {
  return normalise(pw).replace(/[0-9@$]+$/g, '');
}
function isRun(pw) {
  const p = String(pw).toLowerCase();
  if (/^(.)\1+$/.test(p)) return true;                       // aaaaaaaaaaaa
  const chunk = p.replace(/[^a-z0-9]/g, '');
  return chunk.length >= 6 && RUNS.some((r) => r.includes(chunk));   // 123456789012, qwertyuiop
}

/** Returns a list of plain-language problems; empty means the password is acceptable. */
function passwordProblems(password, { role = 'cashier', email, name, phone } = {}) {
  const problems = [];
  const pw = typeof password === 'string' ? password : '';
  const min = MIN_LENGTH[role] || MIN_LENGTH.cashier;

  if (pw.length < min) problems.push(`Use at least ${min} characters${min >= 12 ? ' (a few random words in a row works well)' : ''}.`);
  if (pw.length > MAX_LENGTH) problems.push(`Use ${MAX_LENGTH} characters or fewer.`);
  if (pw && /^\d+$/.test(pw)) problems.push('A password made only of digits is too easy to guess.');

  const lower = pw.toLowerCase();
  const n = normalise(pw);
  if (n && (COMMON.has(n) || COMMON.has(stripTail(pw)))) problems.push('That password is very common. Choose something less predictable.');
  if (pw && isRun(pw)) problems.push('Avoid repeated characters and runs like 123456 or qwerty.');
  if (/urban\s*-?trend/i.test(pw)) problems.push("Don't use the shop's name in the password.");

  const personal = [];
  if (email) personal.push(String(email).split('@')[0]);
  if (name) personal.push(...String(name).split(/\s+/));
  if (phone) personal.push(String(phone).replace(/\D/g, '').slice(-9));
  for (const part of personal) {
    const p = String(part).toLowerCase();
    if (p.length >= 5 && lower.includes(p)) { problems.push('Do not include your name, email or phone number.'); break; }
  }
  return problems;
}

/** Throws a 400 listing every problem. */
function assertStrongPassword(password, ctx) {
  const problems = passwordProblems(password, ctx);
  if (problems.length) {
    throw new ApiError(400, `Choose a stronger password. ${problems.join(' ')}`, { problems }, 'WEAK_PASSWORD');
  }
}

module.exports = { passwordProblems, assertStrongPassword, MIN_LENGTH, MAX_LENGTH };
