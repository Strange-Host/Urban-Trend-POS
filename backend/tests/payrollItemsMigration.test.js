const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
require('./setup'); // sets the env the child processes inherit (secrets, test mode)

// A database created before pay types existed has payroll_items with CHECK (commission = units_sold * rate) and no
// commission_type column. Migration must rebuild it WITHOUT disturbing a locked run: every figure carried over, the
// run's recorded checksum still verifying, the lock triggers back in place, and percentage pay now accepted.
const backend = path.join(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `utpos-migrate-${process.pid}-${Date.now()}.db`);
const run = (script) => execFileSync(process.execPath, ['-e', script], {
  cwd: backend, env: { ...process.env, DATABASE_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

afterAll(() => { for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); });

describe('payroll_items migration', () => {
  it('rebuilds an old-shaped table, keeps a locked run intact, and then accepts percentage pay', () => {
    // 1. A current database, then step payroll_items back to its old shape and lock a run in it.
    run(`
      require('./src/db/migrate');
      require('./src/db/seed');
      const db = require('./src/config/db');
      const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payroll_items'").get().sql;
      const old = cur
        .replace(/^\\s*CREATE TABLE (IF NOT EXISTS )?payroll_items/i, 'CREATE TABLE payroll_items')
        .split('\\n').filter((l) => !/commission_type\\s+TEXT|percent_bp\\s+INTEGER/.test(l)).join('\\n')
        .replace("CHECK (commission_type <> 'fixed' OR commission = units_sold * rate)", 'CHECK (commission = units_sold * rate)');
      db.pragma('foreign_keys = OFF');
      for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('payroll_items','payroll_item_lines')").all()) db.exec('DROP TRIGGER "' + t.name + '"');
      db.exec('DROP TABLE payroll_items'); db.exec(old);
      db.pragma('foreign_keys = ON');
      const admin = db.prepare("SELECT id FROM users LIMIT 1").get().id;
      const runId = db.prepare("INSERT INTO payroll_runs (store_id, period_start, period_end, created_by) VALUES (1,'2026-09-01','2026-09-30',?)").run(admin).lastInsertRowid;
      const itemId = db.prepare("INSERT INTO payroll_items (run_id, staff_id, staff_name, days_worked, retainer, units_sold, achieved_sales, target, achievement_bp, tier, rate, commission, late, absence, missing_hours, advances, loss_deductions, gross, deductions, net, payable, shortfall) VALUES (?, ?, 'Old Staff', 20, 600000, 10, 900000, 5000000, 1800, '<70%', 3000, 30000, 0, 0, 0, 0, 0, 630000, 0, 630000, 630000, 0)").run(runId, admin).lastInsertRowid;
      db.prepare("INSERT INTO payroll_item_lines (item_id, kind, ref_date, ref_text, quantity, amount) VALUES (?, 'commission_order', '2026-09-05', 'UT000001', 10, 30000)").run(itemId);
      const runs = require('./src/services/payrollRuns.service');
      const items = [{ staffId: admin, daysWorked: 20, retainer: 600000, unitsSold: 10, achievedSales: 900000, target: 5000000, achievementBp: 1800, tier: '<70%', rate: 3000, commission: 30000,
        late: 0, absence: 0, missingHours: 0, advances: 0, lossDeductions: 0, gross: 630000, deductions: 0, net: 630000, payable: 630000, shortfall: 0,
        lines: [{ kind: 'commission_order', refDate: '2026-09-05', refText: 'UT000001', quantity: 10, amountCents: 30000 }] }];
      const checksum = runs.fingerprint(runs.canonicalItems({ from: '2026-09-01', to: '2026-09-30' }, items));
      db.prepare("UPDATE payroll_runs SET status='approved', approved_by=?, approved_at=datetime('now'), checksum=? WHERE id=?").run(admin, checksum, runId);
      console.log(JSON.stringify({ runId }));
    `);

    // 2. Migrate it with the new code.
    const out = run(`require('./src/db/migrate');`);
    expect(out).toMatch(/payroll_items rebuilt; 1 payroll line\(s\) carried over/);

    // 3. Inspect the result.
    const report = JSON.parse(run(`
      require('./src/db/migrate');
      const db = require('./src/config/db');
      const runs = require('./src/services/payrollRuns.service');
      const admin = db.prepare("SELECT id FROM users LIMIT 1").get().id;
      const res = {};
      res.verify = runs.verifyRun({ runId: 1, storeId: 1 });
      res.item = db.prepare('SELECT staff_name, commission, rate, commission_type, percent_bp FROM payroll_items WHERE run_id = 1').get();
      res.lines = db.prepare('SELECT COUNT(*) AS n FROM payroll_item_lines').get().n;
      res.triggers = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'payroll_item%_locked'").get().n;
      res.fkViolations = db.pragma('foreign_key_check').length;
      try { db.prepare("UPDATE payroll_items SET commission = 1 WHERE run_id = 1").run(); res.lock = 'NOT LOCKED'; } catch (e) { res.lock = e.message; }
      // percentage pay is now storable (commission is not units x rate) in a draft
      const draft = db.prepare("INSERT INTO payroll_runs (store_id, period_start, period_end, created_by) VALUES (1,'2026-10-01','2026-10-31',?)").run(admin).lastInsertRowid;
      try {
        db.prepare("INSERT INTO payroll_items (run_id, staff_id, staff_name, days_worked, retainer, units_sold, achieved_sales, target, achievement_bp, tier, rate, commission, commission_type, percent_bp, late, absence, missing_hours, advances, loss_deductions, gross, deductions, net, payable, shortfall) VALUES (?, ?, 'Pct', 1, 30000, 2, 1000000, 5000000, 2000, '<70%', 0, 30000, 'percentage', 300, 0,0,0,0,0, 60000, 0, 60000, 60000, 0)").run(draft, admin);
        res.percentage = 'ok';
      } catch (e) { res.percentage = e.message; }
      try {
        db.prepare("INSERT INTO payroll_items (run_id, staff_id, staff_name, days_worked, retainer, units_sold, achieved_sales, target, achievement_bp, tier, rate, commission, late, absence, missing_hours, advances, loss_deductions, gross, deductions, net, payable, shortfall) VALUES (?, ?, 'Bad', 1, 30000, 2, 1000000, 5000000, 2000, '<70%', 100, 999, 0,0,0,0,0, 30999, 0, 30999, 30999, 0)").run(draft, admin + 1000);
        res.fixedStillChecked = 'NOT CHECKED';
      } catch (e) { res.fixedStillChecked = /CHECK|constraint|FOREIGN/i.test(e.message) ? 'checked' : e.message; }
      console.log('@@' + JSON.stringify(res));
    `).split('@@').pop());

    expect(report.verify).toMatchObject({ locked: true, intact: true });
    expect(report.item).toEqual({ staff_name: 'Old Staff', commission: 30000, rate: 3000, commission_type: 'fixed', percent_bp: 0 });
    expect(report.lines).toBe(1);
    expect(report.triggers).toBe(6); // 3 on payroll_items + 3 on payroll_item_lines
    expect(report.fkViolations).toBe(0);
    expect(report.lock).toMatch(/locked/);
    expect(report.percentage).toBe('ok');
    expect(report.fixedStillChecked).toBe('checked');
  });
});
