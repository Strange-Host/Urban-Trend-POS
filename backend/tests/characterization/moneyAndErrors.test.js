const fs = require('fs');
const path = require('path');
const { cleanupTestDb } = require('../setup');

afterAll(() => cleanupTestDb());

// Guard rail for restructure stage R4 ("money and error hygiene").
//   - Money is converted with utils/money.js, never with value * 100 or (cents / 100).toFixed(2).
//   - There is one HTTP error type, ApiError. Nothing else in src/ defines its own Error subclass.

const SRC = path.join(__dirname, '..', '..', 'src');
const IGNORED = ['db/baseline.js'];                       // frozen 0001 baseline
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))
  .filter((f) => !IGNORED.includes(f.rel));

const hits = (re, except = []) => files.filter((f) => !except.includes(f.rel) && re.test(f.text)).map((f) => f.rel);

describe('money stays in integers', () => {
  it('no Math.round(x * 100): text becomes cents through money.toCents / requireCents', () => {
    expect(hits(/Math\.round\([^;\n]*\*\s*100\s*\)/, ['utils/money.js'])).toEqual([]);
  });
  it('no (cents / 100).toFixed(...): cents become text through money.formatMoney', () => {
    expect(hits(/\/\s*100\s*\)\s*\.toFixed\(/)).toEqual([]);
  });
  it('no parseFloat on an amount: only rates and hours may use it', () => {
    // Allowed: percentages and hours, which are not money. A new use needs a reason, so it is listed here.
    const allowed = ['services/payroll.service.js', 'utils/discounts.js'];
    expect(hits(/\bparseFloat\(/, [...allowed, 'utils/money.js', 'services/paymentCallbackAdapters.js'])).toEqual([]);
  });
});

describe('one error type', () => {
  it('only ApiError (and the migrator, which runs before the app) extends Error', () => {
    expect(hits(/class\s+\w+\s+extends\s+Error/, ['utils/ApiError.js', 'db/migrator.js'])).toEqual([]);
  });
  it('services and controllers do not hand-build errors with a status code', () => {
    expect(hits(/Object\.assign\(new Error[^)]*\)\s*,\s*\{\s*(statusCode|status)\b/)).toEqual([]);
  });
});
