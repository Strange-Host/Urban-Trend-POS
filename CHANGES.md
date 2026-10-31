# Priority 5: reports and polish

**Profit and loss (item 12).** `GET /api/reports/pnl` returns the P&L summary, a category breakdown, a branch comparison and
forecast vs actual. `services/reportsPnl.service.js` `profitLoss()` is now the one definition of revenue, cost and profit
(`/reports/profit-summary` calls it, numbers unchanged); the category and branch rows are tested to add back up to it. The
sale-level discount cannot be split by category, so it shows as its own row. Branch comparison: an admin sees every active
store, anyone else only their own. Forecasts live in the new `sales_forecasts` table (a monthly revenue target and expense
budget, `PUT /api/reports/forecasts/:month`, permission `reports.forecast`, admin and manager by default). "Operating
expenses" in the comparison means delivery + telesales pay + business expenses, i.e. everything except cost of goods. The
current month is month-to-date and also shows whether revenue is on pace. Totals cover only months that have a forecast.

**Missing reports (item 13).** Discounts (`/reports/discounts`: totals, share of list value, by staff, by day, largest),
VAT (`/reports/vat`), branch comparison (`/reports/branch-comparison`) and sales-agent performance
(`/reports/agent-performance`: leads assigned/converted/lost, orders, collected online revenue, till revenue, average
order, discounts given, commission). All five reports, and the P&L, download as Excel or PDF from
`GET /api/reports/export/:report?format=xlsx|pdf` (`pnl`, `discounts`, `vat`, `branches`, `agents`), built from the same
service calls as the screens. New Reports page in the sidebar.

**VAT is an estimate.** Local checkout adds no tax (see "Tax removed from local checkout"), so the system holds no VAT
figure. The report treats prices as VAT-inclusive at `vat_rate_percent` (Settings, default 16) and computes
`gross x rate / (100 + rate)`. Its base is exactly the P&L revenue. It is labelled as an estimate on screen and in the exports.

**Smaller items (item 14).**
- PDF invoices: `GET /api/orders/:id/invoice.pdf` and `/api/sales/:id/invoice.pdf`, built from the receipt data (same store
  scoping). New `business_pin` (KRA PIN) setting is printed on them. Buttons on Orders and Sales history.
- Percentage discount limit: `max_discount_percent` caps a cashier's total discount (line + sale-wide) as a share of list
  value, for till sales and orders. Managers and admins are not held to it. 0 = no limit (the default).
- "Lost": leads with status `cancelled` are now labelled Lost. Display only, the stored status is unchanged. Rescheduled is
  left as it is.

**Delivery rates (item 15).** New `delivery_areas` table (area, fee in cents, optional courier). A customer's town sets the
order's delivery fee and suggested courier on order creation, item merge and online-order import; a town that matches no
area uses the old flat/percent rule, and `delivery_use_area_rates` = 0 switches the table off. Matching tries the whole
text, then each comma/dash-separated part, then the longest area name contained in it. Manage under Finance > Delivery
rates, or load the rate card with `npm run import-delivery-areas -- rates.csv` (area, fee in KES, courier, notes). An import
is all-or-nothing and updates existing areas instead of duplicating them. The rows themselves still need to be loaded from
the Joyfull Cargo PDF.

New backend dependencies: `exceljs`, `pdfkit`.

Known: the online-order revenue in the P&L sums line totals, so an order-level discount (`orders.discount_total`) is not
taken off, while a till sale's sale-level discount is. Left as it was; changing it would shift reported figures.

# Priority 3: payroll gaps (pay cycle, commission rules, clock-out check)

**Pay cycle.** A pay period is one calendar month at most (commission targets and tiers start again each month); runs can be
generated with `{ month: 'YYYY-MM' }`. Each run carries a `pay_date`, the `payroll_pay_day` setting (default 3) of the following
month, recomputed at approval. `GET /api/payroll/cycle` reports the month being worked and whether the month just finished is
calculated, locked, paid or overdue. Paying a run is now **signed off**: the paying admin types their own full name (checked
against their account) and sends the run's checksum; the run is re-verified before money is released, and
`signed_off_by/at/name` are recorded. The profit report costs labour month by month, so a range spanning months still works.

**Commission rules.**
- *Reversal*: when an order that already earned commission leaves "dispatched, paid" (payment refunded, returned) a
  `loss_deduction` payroll adjustment linked by `reverses_order_id` takes that commission back, once (unique index), dated so it
  lands in a pay period no locked run covers. A sweep at draft generation catches any route the hooks do not see. Locked runs
  are never edited. An order whose commission was reversed does not earn it again.
- *Pay types per employee* (admin only, `GET/PUT /api/payroll/pay-terms`): `fixed` (own amount per unit, or the store tiers),
  `percentage` (basis points of each secured order) or `combined`. Everyone defaults to fixed on the tiers, so nothing changes
  until set. `payroll_items` gained `commission_type`/`percent_bp`; its `commission = units_sold * rate` check now applies to
  fixed pay only. Existing databases are rebuilt by `migrate.js` (data and locked-run checksums carried over unchanged).
- *Signatures*: a requisition or advance is signed by the requester (typed name, checked against their account) when asked, and
  again on receipt (`PATCH /api/requisitions/:id/acknowledge`, requester only, once approved). The requisitions page can now
  raise a salary advance.

**Clock-out check.** Confirmed: unpaid dispatched parcels, unconfirmed COD orders and leads. Added: Nairobi parcels called out
separately, shop cash still held, and unmatched payments shown (shop-wide, informational). A note for the manager always reaches
the managers, even when nothing is open, and the clock-out / close-till prompt is now always shown so a note can be typed.
Late fee confirmed: nothing at or before 08:00:00 shop time, one hour's fee from 08:00:01, rounded up per hour (tests pin the boundaries).

Tests: `backend/tests/payrollPriority3.test.js`, `payrollItemsMigration.test.js`; frontend `PayTerms.test.jsx`, `HandoverModal.test.jsx`.

---

# Priority 2: main-store inventory control

Receiving, suppliers, issue logs, inter-branch transfers with approval, and outlet opening/closing counts with a
who-did-what log. Backend in `controllers/stock*.controller.js`, `suppliers.controller.js`, `stores.controller.js`,
`services/stock.service.js`; page `pages/StockControl.jsx` (Stock > Stock control). Tests: `tests/priorityTwo.test.js`,
`tests/stockControlMigration.test.js`.

**Database** (all additive; existing data is kept): `stores.is_main` (the oldest store becomes the main store on upgrade);
new tables `suppliers`, `stock_receipts`, `stock_receipt_items`, `stock_issues`, `stock_transfers`, `stock_transfer_items`,
`stock_counts`, `stock_count_items`. `inventory_movements` is rebuilt (rows and indexes carried over) to accept the new
reasons `receipt`, `issue`, `transfer_out`, `transfer_in`, `stocktake`, so every stock change is still in the ledger the
reconciliation job checks. No table here holds a buying price.

1. **Receiving** (`POST /api/stock/receipts`, main store only). Lines are an existing product + quantity, or a NEW product
   (name, quantity, selling price, image link, category or a new **sub-category**). Stock goes in at once, one `receipt`
   movement per line, all-or-nothing. A new product from the storekeeper is the same pending proposal as in the catalog:
   inactive, no buying price (anything typed is ignored), managers notified; the approver adds the buying price when
   approving. A storekeeper may add a sub-category inside an existing category but not a top-level one; an existing
   sub-category of the same name is reused. Duplicate names/SKUs/barcodes are refused.
2. **Suppliers** (`/api/suppliers`): add and list for anyone who can receive (a supplier can also be created while
   receiving); rename / switch off needs `products.manage`.
3. **Issue log** (`POST /api/stock/issues`): damaged, expired, lost, used in the shop, returned to supplier, other (note
   required). Cannot take stock below zero. Losses notify managers.
4. **Transfers** (`/api/stock/transfers`): request -> a different manager approves -> two movements (`transfer_out` /
   `transfer_in`) in one transaction. Stock is re-checked at approval; a second approval is refused. Reject needs a reason;
   the requester can withdraw. Admins may approve their own, like elsewhere.
5. **Outlet counts** (`/api/stock/counts`): opening and closing, one per branch/day/kind. The variance against the
   system's figure is fixed at submission. A different person approves or rejects; approving can post the variances as
   `stocktake` adjustments. `GET /counts/day-summary` ties the two counts together using the ledger (opening count + real
   flows between = expected closing; the rest is missing or surplus). A rejected count can be redone.
6. **Who did what** (`GET /api/stock/activity`): every non-sale stock movement, count submission/review and transfer
   step with the person's name, plus a per-person tally; reviewers only.
7. **Branches**: `GET/POST/PUT /api/stores` (create/edit are admin only; the main store cannot be switched off). An admin
   can list and add staff in another branch (`store_id` on `GET`/`POST /api/staff`; Staff page has a branch picker).

New permissions: `stock.receive`, `stock.transfer` (admin, manager, store), `stock.count` (also cashier),
`stock.review` (admin, manager: approve transfers and counts, see the activity log).

Not done: a buying price on the receipt line itself (the buying price is set when the product is approved); editing or
removing outlet staff from the main admin account (do it from that branch's own admin); automatic stock-take scheduling.

# Sign-in rate limit kept in the database

Ported in spirit from the `update` branch's `auth/rateLimit.ts`. The per-address limit on the endpoints someone can guess
their way through (password, PIN, one-time code, unlock: `POST /api/auth/login`, `/pin-login`, `/verify-otp`, `/resend-otp`,
`/unlock`) used `express-rate-limit`'s in-memory store, so a restart (a deploy, a crash, pm2 bringing the process back) gave
every address a fresh allowance. It now counts in the new `rate_limits` table through `utils/sqliteRateLimitStore.js`, so the
count survives a restart and is shared by any process using the same database file. The allowance is unchanged (20 per 15
minutes, shared by those five endpoints) and the per-account lockout still applies beside it. Old windows are swept hourly,
from inside a request that is already writing. If the counter cannot be written the request is let through instead of
turning every sign-in into an error.

Deliberately **not** moved: the blanket API limiter, checkout, sync and webhook limiters stay in memory. They are hot paths
where a database write per request is not worth it, and a restart resetting them is harmless.

Note: this app is meant to run as ONE process (`ecosystem.config.js` pins `instances: 1`, because a SQLite file has a single
writer), so the "shared across instances" half of this only matters if that ever changes. The part that matters today is
that a restart no longer resets the sign-in count.

# Nightly integrity job

Ported from the `update` branch's `integrity/checks.ts`, `job.ts` and `cli.ts` (`backend/src/integrity/checks.js`,
`job.js`, `scripts/integrity-check.js`). The database already refuses to break the data rules; this proves it by looking
at the data itself, and catches the case where the guards were bypassed (a restored backup, a hand-run script, a dropped
trigger). Detect-only: it never changes data. It replaces nothing: `GET /api/orders/integrity` still works, and its
line-versus-subtotal check is now one of the job's checks.

**Checked** (the rules that do not need a ledger): **2** an order's paid amount equals its payments plus organization
collections (never a free-standing counter); **6** payments never exceed what is owed, and paid is never negative;
**7** protection triggers are in place; **8** every commissioned order is still fully secure and became secure within its
run's period, every commission line is recorded, and a statement secures what it settled; **9** a locked payroll run still
hashes to its approval fingerprint; **10** order references are present, unique (ignoring case) and well formed (`UT000123`);
**11** every parcel dispatched with a courier organization has a package fee line, no fee sits on an undispatched parcel,
and the fee is owed to the order's courier; **12** payout lines are exactly one fee or one cost, match their records, and
add up to their payout's totals. Plus: an order's lines add up to its subtotal.

**Not ported, reported as not applicable in every report**: rules 1, 3, 4 and 5 all compare a record against the double-entry
ledger, which the SQLite version does not have. A rider's zero package fee records nothing by design, so rule 11 holds only
organizations (whose fee is mandatory) to it.

**The job**: runs every night at 02:00 shop time (`scheduleNightlyIntegrity`, started from `server.js`), stores each run in
the new `integrity_runs` table, and skips one if another finished in the last 20 hours, so a restart does not repeat it. A
failure is logged, and raises an admin alert (in-app, plus email when set up) that stays until a later clean run clears it.
`npm run integrity` runs it once, right now, ignoring the 20-hour skip: exit 0 when clean, exit 1 listing each problem
(`--json` prints the full report).

# Locked payroll runs, and commission only on secure money

Ported from the `update` branch's `payroll/runs.ts` and `payroll/commission.ts` (`services/payrollRuns.service.js`,
`services/commission.service.js`). Until now payroll was computed live and kept no snapshot, so a past month's pay moved
whenever settings or records changed, and commission was paid on any `dispatched_paid` order. Amounts are integer cents;
periods are shop dates. New tables (`schema.sql`): `payroll_runs`, `payroll_items`, `payroll_item_lines`, `commissioned_orders`.

1. **Rule 8, secure money.** An order earns commission only when its whole total is secure: non-cash payments on receipt;
   shop cash only once its custody record is **deposited**; courier-organization money only for the part a statement
   settled (`org_statement_lines.secured`). Refunded or failed payments never count. It counts in the pay period in which
   it became secure (the later of dispatch and its last secure money). Achievement is in basis points (no floats). This
   also applies to the existing live `GET /api/payroll/summary`.
2. **Rule 9, locked runs.** `POST /api/payroll/runs {from,to}` calculates the period and saves a **draft** snapshot
   (itemised lines: retainer days, commissioned orders, late/absence/missing hours, advances, losses); regenerating the
   same period replaces the draft. `POST /api/payroll/runs/:id/approve` (admin) recalculates and refuses with `RUN_STALE`
   if anything changed since the draft, then **locks** the run: figures frozen, a sha256 `checksum` recorded, every
   commissioned order written to `commissioned_orders` (primary key: an order can never earn twice). `POST
   /api/payroll/runs/:id/pay` (admin; `mpesa`/`bank` need `payment_ref`) marks it paid. Also `GET /runs`, `/runs/:id`,
   `/runs/:id/verify` (re-hashes the stored figures against the checksum).
3. **The database enforces the lock** with triggers, since SQLite has no exclusion constraints: items, lines and
   commissioned orders are frozen once the run is approved; a run only moves draft -> approved -> paid and each step
   changes only its own columns; locked runs cannot be deleted; two locked runs cannot cover the same day.

4. **Payroll page.** Money > Team > Payroll now has two tabs. **Pay runs** (new, `pages/PayrollRuns.jsx`): pick a period and
   calculate a draft, open a run to see each person's gross, deductions and payable (expand for the itemised lines), then
   *Approve and lock* (asks for confirmation) and *Mark as paid* (M-Pesa and bank need a reference). A stale draft explains
   itself and offers *Recalculate*; a locked run shows "Fingerprint verified", or an alert if the stored figures no longer
   match. Managers see Approve and Mark as paid but they are disabled, because the server allows only admins. **Live summary**
   is the previous page, unchanged apart from its description.

Not changed: a deduction dated inside an already-locked
period is not carried forward, so lock a period only once it is over.

# Rider payables: package fees, approved costs, payouts

Ported from the `update` branch's `couriers/payables.ts` (`services/courierPayables.service.js`). It covers **riders**;
courier organizations keep their own rules (see the organizations entry): their fee is required at dispatch and netted
off their statements, and these endpoints answer 409 for them. Amounts are integer cents. New tables (`schema.sql`):
`courier_costs`, `rider_payouts`, `rider_payout_items`; the fee goes in the existing `package_fees`.

1. **Package fee**: `POST /api/orders/:id/dispatch` with `{ "package_fee": 15000 }`. A rider fee needs a named courier on
   the order, is written in the same transaction as the dispatch (a refused fee cancels the dispatch), and is owed
   whether or not the customer collects: a returned parcel does not cancel it. A 0 fee, or none, records nothing for a
   rider (`package_fees` rows of 0 need a reason, which only organizations give). Bad amounts answer 422.
2. **Extra costs** (`return_trip`, `fuel`, `airtime`, `handling`, `repair`, `other`): `POST /api/couriers/:id/costs`, then
   `POST /api/couriers/costs/:id/approve` or `/reject` (a reason is required). The approver must be a different person
   from the one who entered it, checked in the service and again by a CHECK constraint. Only approved costs are owed.
3. **Payouts**: `POST /api/couriers/:id/payouts` with `method` (`mpesa`, `bank`, `cash`; mpesa and bank need
   `payment_ref`) and optionally `items` to settle only some. The total is the sum of the items. A payout returns
   `fee_lines` and `cost_lines` separately, and is mirrored into `expenses` as two rows (categories "Courier package fees"
   and "Courier costs"). Each item can be paid once (UNIQUE on `rider_payout_items`). These are separate from
   `courier_payouts`, which only records organization fees netted on a remittance.
4. **Reading**: `GET /api/couriers/payables` (overview), `/:id/payables` (balance with fees and costs separate, plus
   unpaid items), `/costs?status=pending`, `/payouts`, `/payouts/:id`.

New permissions: `couriers.costs.record` (everyone), `couriers.costs.approve` and `couriers.pay` (admin and manager;
grantable per person). No screens yet: this is the API and the data only.

Not changed: the till's expected cash ignores every cash expense today, so a cash payout does not reduce it either.

# Money at risk: the manager's daily list of where money or goods may be going missing

New page **Money > Money at risk** (`/money-at-risk`, API `GET /api/orders/at-risk`), ported from the `update` branch's
`orders/atRisk.ts` onto the SQLite backend. Each line has what it is, the order, how many days it has been waiting, whose
it is and the amount; oldest first, with tiles per kind that filter the list. Needs the new `atrisk.view` permission
(admin and manager by default, grantable per person like the others).

Five kinds are built, all from tables that already exist:

1. **No outcome**: dispatched, nothing paid, not on its way back, for 3+ days.
2. **Balance owed**: part paid and the rest still owed, 2+ days after the last payment.
3. **Unmatched payment**: money received that matched no order. Flagged from the moment it lands; it leaves the list when
   it is matched or ignored on the Reconciliation page.
4. **Parcel returning**: on its way back for 3+ days (the amount is the value of the goods).
5. **Till left open**: a till session still open after 20 hours.

Thresholds can be overridden with `dispatched_no_outcome_days`, `delivered_unpaid_days`, `returning_days` and
`session_open_hours`. This app has no "delivered" event, so a payment is the only outcome it can see: kinds 1 and 2 are
read from the order's payment status, not from a delivery record.

**Update:** three more kinds, so 8 of the 9 on the update branch are built (cash held arrived with custody; the last two once
rider payables and courier organizations existed):

6. **Cash held** (custody, see its own entry): shop cash still in a staff member's hands for 2+ days.
7. **Courier unpaid**: one line per rider for what we owe and have not paid (package fees, owed whether or not the customer
   collected, plus approved costs; pending and rejected costs are not owed), aged by their oldest unpaid item once it is
   7+ days old. Organizations are not listed here: their fee is netted off their statement.
8. **Organization overdue**: a courier organization holding customer money past its overdue-after-days setting, for the
   overdue amount, aged from its oldest collection. The detail says when it is also paused for new collect-on-delivery
   parcels. It drops off once a remittance settles the oldest money.

New threshold override: `courier_unpaid_days` (also `cash_held_days`). The page shows the new kinds as tiles and filters.
Still not built: **till variance unsigned**, which needs a manager sign-off on cash sessions, a feature that does not exist here.

# Backups: remembered schedule, verified copies, mandatory passphrase, in-app alerts; Resend removed

**Resend removed.** Outgoing email is SMTP only again. Settings > Email lost the method switch and the Resend
fields; `mail_provider`, `resend_from` and the encrypted `resend_api_key_enc` rows are deleted by the migration on the
next start (so the key is no longer sitting in the database or its backups). **Email stops until SMTP is configured**
if Resend was the only method set up, and SMTP only works from Railway's Pro plan.

Fixes to the backup plan:

1. **The schedule survives restarts.** The two `setInterval` timers restarted from zero on every boot (and did not
   run at boot), so a server redeployed more often than every 6h/24h could go without backups. One scheduler now
   checks every 10 minutes (and 45 s after boot), runs whatever is overdue, and remembers the last success in the
   `settings` table (`last_local_backup`, `last_backup_email`). A failed run is retried hourly, not every tick.
2. **Off-site copies need `BACKUP_PASSPHRASE`.** The silent fallback to a key derived from `ENCRYPTION_KEY` is gone
   (that key lives on the same machine, so losing the machine lost the key). A missing or too-short (<12) passphrase
   is a clear error and an alert, never a quiet fallback. `restore-backup.js` can still open backups made under the
   old fallback. The email text now says `ENCRYPTION_KEY` must be kept separately.
3. **Backups are verified.** Each new local backup gets a SQLite `quick_check` (and must be a POS database); a bad one
   is deleted, never pushes a good one out of retention, and is reported. Each off-site copy is decrypted again and
   checked before it is sent.
4. **Permissions.** Backup folder `0700`, files `0600` (existing ones tightened at boot), temp copies `0600`. The
   database and backups are on the same persistent volume, so this is hardening, not off-site protection: the
   encrypted email copy is what covers losing the volume.
5. **Alerts no longer depend on email.** Backup failures, off-site failures and inventory drift also create an in-app
   notice for every active admin (bell). A failure streak alerts once, then once a day; the notice clears when it is fixed.
6. **Smaller fixes.** Temp encrypted copy always removed (it leaked if encryption failed); one backup at a time (a
   manual click joins a running one); one scheduler pass makes one backup and emails that same file; the Backups
   screen shows the last local result and warns when the passphrase is missing.

**Tests:** `emailResend.test.js` replaced by `emailSmtp.test.js`; new `backups.test.js`; additions to
`backupEncryption.test.js`. Backend suite 493 passing (48 files) on the real better-sqlite3; frontend build, lint
(no new warnings) and tests pass. **NOT verified:** a real SMTP server, the Settings screens in a browser, behaviour on Railway.

**Deploy notes (Railway):** set `BACKUP_PASSPHRASE` under Variables **before** deploying, or no off-site copy is sent
until you do (admins are told in the bell). `ENCRYPTION_KEY` must also be saved somewhere outside the server.

# Email through Resend (HTTPS) for hosts that block SMTP

**Why:** on Railway's Free/Trial/Hobby plans every outgoing SMTP port (25, 465, 587, 2525) is blocked, so backup
emails, failure alerts and the Settings test email all failed with "Could not connect to the mail server".

- **New email method: Resend.** Settings > Email now has a method switch (Resend / SMTP). Resend sends over HTTPS
  (port 443), so it works on every host and plan. Existing SMTP setups are untouched and are never silently switched.
- **One send path.** `mail.service.js` now exposes `sendMail({ to, subject, text, attachments })`; the backup
  email, failure alerts and the test button all use it, so they can never disagree about how mail leaves.
- **API key stored encrypted** (`resend_api_key_enc`, same AES-GCM as the SMTP password); never returned by any
  endpoint, hidden from the generic `/api/settings` too, audit log records only "changed/removed".
- **Environment fallback for Railway Variables:** `RESEND_API_KEY`, `RESEND_FROM`, `MAIL_PROVIDER`. A saved Settings
  key wins over the environment. With a `RESEND_API_KEY` and no SMTP host the app picks Resend automatically.
- **Plain-language errors** for a wrong key, a free account sending to a non-sign-up address (Resend only delivers to
  the account's own address until a domain is verified), an unverified "send from" domain, rate limit, no internet,
  timeout, and a backup too large (guard at ~28 MB). The SMTP "could not connect" message now also says Railway
  Hobby blocks SMTP and points to Resend.
- Default sender is `Urban Trends POS <onboarding@resend.dev>` until a domain is verified and a "Send from" is saved.
- Backups settings hint no longer tells you to edit `.env` and restart.

**Tests:** `emailResend.test.js` (17 new). Backend suite 476 passing (47 files) via the node:sqlite shim
(better-sqlite3 cannot compile in the sandbox). Frontend build + lint clean (0 errors). **NOT verified:** a real
Resend account (HTTP calls are mocked with the documented request shape), the Settings screen in a browser.

**Deploy notes (Railway):** attach a Volume for `backend/data` and set `JWT_SECRET` and `ENCRYPTION_KEY` as service
Variables, otherwise the database, backups and the encrypted API key are lost on redeploy.

# Optional modules: HR & back office and control extras can be switched off (v29)

For a lean launch. Two switches in **Settings > Business > Optional modules**, both **off by default** (new and
upgraded installs). Nothing is deleted - switch back on and it is all there. No schema change.

- **HR & back office** (hidden when off): Attendance, Payroll, Onboarding, Requisitions.
- **Control extras** (hidden when off): permission overrides and two-factor set-up (Staff > Access), order
  disputes, the "prepay only / watch" badges.
- **Really off, not just hidden:** the menu items, the pages (by URL too) and the API (404 `MODULE_DISABLED`).
- **Lead/order assignment kept working:** it only ever picked staff who had clocked in, so with Attendance off
  every new lead would have stayed unassigned (and cashiers only see leads assigned to them). While HR is off
  all active cashiers count as present; with HR on it is unchanged.
- **Safety rule:** permission overrides and 2FA already set stay enforced while Control extras is off - hiding
  the screen never hands access back (tested: a manager's revoked `reports.view` stays revoked).
- Switch changes are audit-logged; only an admin can change them; everyone signed in can read them (the menu needs it).
- Also: the Settings toggle responds instantly and rolls back if the save fails.

**Not hidden on purpose:** Staff, Activity log (security), returns/inspection, Couriers, Shift handover, and the
profit report's payroll lines (empty while payroll is unused).

**Tests:** `modules.test.js` (14 new; the shared test setup turns both modules ON so the older tests still cover
those features). Backend suite 411 passing (43 files). **Verified in a browser** (Chromium, real backend, default-off
database): the four HR items and the dispute/Access/badge controls are absent, direct URLs to hidden pages redirect
home, a cashier's empty Team group disappears, toggling from Settings shows/hides items live and survives reload,
phone layout of the card has no overflow. **NOT verified:** real devices; a database that already holds payroll,
attendance or dispute data was not tried with the modules off.

# Safety fixes: default PIN, oversell, report dates, refunds (v28)

Backend + a small Staff-form change. **Schema:** two triggers added at the end of `schema.sql` (applied
automatically by `migrate`/start; nothing to run by hand). Closes four of the "not ready to deploy" blockers.

## 1. Default admin PIN `1234` (security)
**Problem:** the seeded admin had PIN `1234`, and `POST /api/auth/pin-login` (userId + PIN, no password) gave a
full admin session. The frontend never used that route, so it was only a backdoor.
- Seed creates no PIN. **Startup removes `1234` from any admin account** (existing installs; logs one notice).
- PINs must be 4-6 digits and not obvious (1234, 0000, 1111, 2345, 654321...) - checked on create and edit.
- **PIN login is cashier-only**: admin/manager accounts get 403 `PIN_LOGIN_CASHIERS_ONLY` even with a PIN.
- Docs no longer advertise a default PIN. *Behaviour change:* if you used a PIN for a manager, they now use email + password.

## 2. Overselling
**Problem:** checkout (and online-order dispatch) checked stock line by line, so the same product on two lines
(3 + 3 with 4 in stock) passed and stock went to -2.
- Stock is checked against the **total per product**; the decrement is itself conditional (`quantity >= ?`).
- **DB triggers** refuse any update that takes `inventory.quantity` below zero (a row already negative from old
  data can still be restocked towards zero). Store-copied stock (Shopify/Woo, reconciliation) is clamped at 0
  first, since a store may report negative.
- Manual stock adjustment requires whole numbers.

## 3. Report dates and "today"
**Problem:** `created_at BETWEEN '2026-10-12' AND '2026-10-12'` compared a timestamp to a bare date, so a
single-day report returned **nothing** and any range lost its last day; days were cut at UTC midnight, so a
sale at 1:30 am Nairobi time counted for yesterday.
- New `utils/storeTime.js`: the shop's calendar day (default `Africa/Nairobi`, UTC+3; `STORE_TIMEZONE`
  overrides). Reports, dashboard, trend, payroll commission windows, attendance "today", follow-up due dates,
  shift/lead logic all use it. `from`/`to`/`date` are inclusive whole days; malformed values -> 400.
- **Profit:** sale-level discounts are now deducted from revenue; a part-paid online order counts only the
  collected share (revenue and cost of goods both x amount_paid/total) - the same "sold = collected" rule the
  dashboard uses. *Numbers will change vs v27 for periods with discounts or part-paid orders.*
- **Payroll late fee:** clock-in was read as an hour since UTC midnight (08:00 Nairobi = 5), so nobody was ever
  late; and exactly 08:00:00 / exactly 8 h worked were mis-charged by float noise. Now shop-clock, whole seconds.

## 4. Refunds
**Problem:** refunding an order payment only flipped the payment record; `orders.amount_paid` and the status
stayed, so the order kept showing "paid".
- `POST /api/payments/:id/refund` now (same transaction) reduces `amount_paid` and, while the parcel is out,
  moves the order back dispatched_paid -> partial -> unpaid (with status history). A returned/cancelled order keeps its status.
  Double refund is still 409. The status machine gained those backwards moves (refund path only).

## Tests
`pinSecurity`, `oversell`, `shopTime`, `orderRefund` (new, 28 tests; each group fails on the v27 code - checked by
swapping the old files back in). Two older tests used the UTC date for "today"; now the shop date.
**Verified:** backend suite 397 passing (42 files, node:sqlite shim); frontend build + lint ok; fresh install
(no PIN, 2 triggers, no warnings) and upgrade from a v25 database (PIN removed, triggers added, starts clean).
**NOT verified:** real `better-sqlite3` driver (run `npm test` on your machine); the refund path against a real
M-Pesa/KCB reversal; money the shop already refunded in the OLD system is not retro-corrected.

## Still open from the audit
Refresh-token reuse, till actions not audit-logged / no discount caps, cashier can delete leads, manager can
approve own advance, absence fees never created, offline queue per browser, `prepay_required` unenforced,
`nodemailer` advisory, unencrypted emailed backups, no CI/Dockerfile, stock-master decision for store-linked products.

# Settings page organised for phones and tablets (v27)

Frontend only - no backend, database or API changes.

**Problem:** Settings was one ~9,000 px column of ten stacked cards with no way to jump between them, and a long
unbreakable URL (the KCB callback address) made the whole page 30 px wider than a phone screen.

- **Tabs:** Business (business & receipt, how customers pay) | Payments (M-Pesa/KCB gateways, KCB advanced) |
  Messaging (customer SMS, website form leads) | Stores (income sources, live sync) | Server (public address,
  outgoing email, backups). Content is unchanged, just grouped; the longest tab on a phone is now ~3,000 px.
  The open tab is kept in the address (`/settings?tab=stores`), so refresh, back and links work; an unknown
  tab name falls back to Business. ShopifySync's "turn on live sync" link now opens the Stores tab.
- **Long values wrap:** URLs, secrets and paths in `<code>`/`<pre>` break instead of widening the page.
- **Less wasted width on phones:** card padding 20 -> 16 px, nested cards 16 -> 12 px; button rows wrap.
- **Tab strips** scroll the selected tab into view (arriving by link on "Server" no longer hides it).
- **Bug fixed (all screen sizes):** a connected-store row printed a stray "0" under the shop domain
  (`has_access_token` is the number 0 and `0 && <element>` renders "0"). Now `!!source.has_access_token`.

**Verified** (headless Chromium, real backend on the node:sqlite shim, two sample stores): all five tabs show no
sideways overflow at 390, 768 and 1366 px; tab click updates the URL, reload and direct links keep the tab; no
stray "0"; the live-sync link points at `?tab=stores`; the earlier page audits still pass at 390/768/1440 px;
`vite build` ok, `oxlint` 0 errors (same 15 warnings).
**NOT verified:** real phone/tablet or Safari; the forms were checked for layout, not for saving real
credentials; the Payments tab (M-Pesa + KCB + sandbox test payment) is still long on a phone.

# Notification panel fixed + phone/tablet layout (v26)

Frontend only - no backend, database or API changes.

## 1. Notification bell hidden behind the page (the Terminal)
**Cause:** the dropdown was drawn inside the sidebar. The sidebar is its own stacking layer, so the panel's
`z-index` only competed *inside* the sidebar and positioned page content (the Terminal's product cards and
shift bar) painted on top of it. Reproduced in a browser: on the Terminal, page content covered all 9 points
sampled across the panel; the other 15 pages were unaffected.
**Fix:** the panel is now rendered on `document.body` (React portal), above everything. Outside-click, Escape,
"Mark all as read" and click-through-to-page were re-tested.

## 2. Phones and tablets
- **Tables (18 of them):** below 640 px a table becomes labelled cards (one card per row, "TOTAL  KES 900"
  on each line). Before, columns were cut off with no sign they scrolled - e.g. Sales history never showed the
  total on a phone, Leads hid the status, Orders lost columns. From 640 px up it stays a table; one that is
  wider than the screen scrolls sideways and shows a shadow on the side that has more. Column names are copied
  onto cells by `components/useStackedTableLabels.js`; a table opts in with class `stack-sm`.
- **Orders:** the pager was a cell of the two-column grid and could push the detail panel out of place - fixed.
  Below 1280 px the order detail is a slide-up sheet (opens when you pick an order, "Close" button);
  from 1280 px it is the side panel as before.
- **Terminal:** at 768 px a 384 px cart sat beside the products, leaving ~336 px for three columns, so cards
  overflowed and the barcode box scrolled the area sideways. The slide-up cart now applies up to 1280 px;
  side-by-side cart from 1280 px (desktop unchanged).
- **Navigation:** the sidebar is a drawer below 1024 px (was 768 px, which left a tablet in portrait ~528 px of
  content). Top bar and drawer respect the phone notch (`safe-area-inset`), page height uses `dvh` so mobile
  browser bars no longer cut the bottom off.
- Page padding: Products, Categories, Cash sessions and Shopify sync used a fixed 32 px; now 16 px on phones.
- Tab bars (Finance, Catalog, channel filters) scroll sideways instead of widening the page; taller tap targets.
- Product / Category dialogs had no side margin and no height limit; they now fit short phones and scroll.

## Verified (headless Chromium against the real backend on the node:sqlite shim, with sample data)
No sideways page overflow on any of the 16 pages at 390, 768, 1024 and 1440 px; bell unobstructed on all 16
pages at 1366, 768 and 390 px; order sheet opens/closes at 390 and 1024 px and is the side panel at 1440 px;
cart sheet opens at 390 and 768 px; Add-product/lead/payment/staff/requisition dialogs fit 360x560.
`vite build` and `oxlint` (0 errors, same 15 warnings as before) pass. Backend suite unchanged (369 passing).
`frontend/scripts/` holds the browser checks used (Python + Playwright; not part of `npm test`).

## NOT verified
- No real phone or tablet, no Safari/iOS (notch spacing, `dvh`) - Chromium only.
- Settings, Employees, Payroll and Attendance were checked for overflow but not read screen by screen.
- Touch behaviour was emulated, not tested by hand. No automated frontend tests exist yet.

# Pagination fixed everywhere, Pull-products button, live sync (v25)

## 1. Pagination - why you only saw "a section"
Every list endpoint is paged (25 per page by default, 100 at most), but only Products had page
controls - so Orders, Leads, Staff, Expenses, Payments, Requisitions, Staff logs, Reconciliation,
Sales history and Cash sessions silently showed ONLY THE FIRST 25 (Sales history/Cash sessions: 50)
and nothing said there was more. New shared `Pager` ("Showing 1-25 of 312", Prev/Next, numbered pages,
25/50/100 per page) now sits under all of them; filters/search/tabs reset to page 1; the list stays on
screen while the next page loads. A short list says "Showing all N ...".

Related truncation found and fixed while auditing every API-backed list:
- **Pickers asked for "200 products" but the API caps a page at 100**, so product #101+ never appeared
  in dropdowns (Requisitions' product picker had only the first 25). Pickers that must offer EVERYONE/
  EVERYTHING (products, active staff in Leads/Payroll/Employees, route pickers in Settings) now walk
  all pages (`api/fetchAll.js`).
- **Totals computed from only the visible rows**: Orders "outstanding" added up the 25 on screen, and
  Reconciliation "unallocated" the 25 shown. Both are now computed by the server across the WHOLE
  filtered set (`summary` in the response) and are the same on every page.
- **Real bug found by the new tests: the Cash sessions list always answered HTTP 500** (an ambiguous
  `store_id` in a join), so Finance > Cash sessions never loaded. Fixed.
- Still capped by design (not user lists): dashboard top-N tables, search-as-you-type boxes (first 10-20
  matches), and the product audit trail LIMIT 100 in `GET /inventory/movements`.
Tests: +7 (every paged endpoint returns the same {data,total,page,totalPages} shape; 60 orders page
across 3 pages with no repeats/gaps; summary totals; filter matrix produces no server errors).

## 2. Shopify sync page: a Pull products button that works
The page already had a "Sync from Shopify" button, but it called the old single-shop route that reads
`SHOPIFY_SHOP`/`SHOPIFY_ACCESS_TOKEN` from a server file - for anyone who connected the store the normal way
(Settings > Income sources) it just failed with "not set". It now pulls from the connected stores: pick one
or "All connected stores" (one failing does not hide the others; per-store results are listed). The page
shows each store's live-sync state and last-pulled time, and refreshes itself every 15 s.
API: `GET /integrations/shopify/connections`, `POST /integrations/shopify/sync { income_source_id? }`.
The old env-based path is kept only as a fallback when nothing is connected.

## 3. Live sync with Shopify and WooCommerce
**Webhooks (fast path).** Settings > Income sources > each store > "Turn on live sync" registers six change
types with the store at `https://<your public address>/api/integrations/webhooks/<shopify|woocommerce>/<id>`
(Shopify: orders create/updated/cancelled, products create/update/delete; WooCommerce: order and product
created/updated/deleted). Needs the public https address (Settings > Server & public address).
- Every delivery is verified against the store's own HMAC-SHA256 signature over the raw body
  (Shopify: the app's Client secret + the shop-domain header; WooCommerce: a per-store secret we generate,
  stored encrypted). Bad signature -> 401, nothing changes. An authentic delivery is always answered 200
  (a data problem is recorded, not retried for days until the store deletes the subscription).
- New/changed orders update Sales history, add still-to-ship orders to the Orders page (switchable), and
  notify the team (bell). A cancellation voids the sale and cancels a still-waiting order, but never one
  already dispatched. A late, OLDER delivery cannot drag a newer state backwards (`sales.external_updated_at`).
  Re-sent deliveries are recognised by delivery id. Large payloads (up to 10 MB) are accepted.
- Product changes flow into the Shopify sync review list (approval stays yours); a product deleted in the
  store only raises a warning - nothing is removed from the POS.
- A read-only WooCommerce key cannot create webhooks: the app says so and shows the Delivery URL + Secret to
  add by hand. Partial failures (e.g. missing read_orders) are reported topic by topic.
**Safety-net poll (reliable path).** Every minute the server checks whether each connected store's interval
has elapsed (Settings: 5 / 10 / 15 / 30 / 60 min or never; default 10) and asks "what changed since I last
looked?" (orders updated since the last check -> Sales history and the Orders page; catalogue hourly). It
catches anything a webhook missed and keeps stores without live sync reasonably current. A failing store is
recorded (`last_poll_error`, shown in Settings) and does not stop the others.
**Screens refresh themselves:** Orders, Sales history, the Shopify sync review list and the bell poll every
15 s while open, so a live-synced order appears without a reload.
New: tables `income_source_webhooks`, `webhook_events` (30-day log); income_sources columns
live_sync_enabled / webhook_secret / last_webhook_at / last_poll_at / last_poll_error.
Tests: +30 (`liveSync.test.js`). Suite 369 passing.

**Honest limits**
- "Instantaneous" means seconds, and depends on the store sending the message and your address being
  reachable from the internet; the poll covers the gaps.
- Stock is copied FROM the store when a product is pulled or changes; it is not pushed back to Shopify, inventory-only
  changes are not subscribed to, and dispatching a pulled online order deducts POS stock again until the next copy.
- No real Shopify/WooCommerce store was available: registration and deliveries are tested against mocks
  (including real HMAC signatures). Turn it on for one store and place a test order before relying on it.

# Orders page: channel tabs (v24)

The Orders page now has the same channel split as Sales history: **All channels / Local store /
Shopify / WooCommerce**. "Local store" = orders created in the POS or from leads
(`channel = manual`); Shopify and WooCommerce (`wordpress`) are the ones brought in by
"Pull online orders". Each imported order also carries a small Shopify / WooCommerce badge
(hover shows which connection it came from), and the empty state says what to do per channel.
API: `GET /api/orders?channel=manual|shopify|wordpress` (anything else is a 400); rows now include
`income_source_name`.

**Bug fixed on the way:** orders had a unique key on (channel, external order id), so two
WooCommerce sites that both have an order #700 would have collided and the second site's order
failed to import. The key is now per connection (`idx_orders_external`); the old index is dropped
automatically on upgrade (verified against a database that had it).

Tests: +2; suite 332 passing.

# Orders-page Shopify pull + all server settings in the app (v23)

**Why the Orders page was empty.** It was by design but invisible: the Shopify sync
(Sync sales) writes to **Sales history**, a reporting record - it has never created anything on
the **Orders page**, which is the shop's fulfilment workflow (confirm COD -> dispatch -> courier
-> payment -> returns). Nothing on the Orders page could import from a store, so it stayed
empty however many orders you synced.

**New: "Pull online orders"** (top right of the Orders page; admin/manager by default via the
new `orders.pull_online` permission). Brings the orders that still NEED SHIPPING from a
connected Shopify or WooCommerce store into the Orders page, with customer, items, a UT code
and the right payment state:
- already-paid -> prepaid, with its payment recorded, and when dispatched it goes straight to
  `dispatched_paid` (dispatch now does this for any order that is already paid in full);
- unpaid / cash-on-delivery -> a normal COD order that must be confirmed before dispatch;
- already fulfilled or cancelled on the store -> skipped (that is history, not work);
- cancelled on the store while still `awaiting_dispatch` -> cancelled here on the next pull;
- safe to repeat (unique per store connection + order id); one bad order (e.g. no phone number)
  fails alone with its reason and the rest import.
- **No double counting:** each online order now exists as a sale (Sales history) AND an order,
  linked by `orders.sale_id`. The three revenue/profit/top-product report queries and the
  "cash collected today" query exclude linked orders, so revenue is counted once, from the sale.
  If Sync sales runs after a pull (or before), the second record links to the first.
- API: `GET /api/orders/online-sources`, `POST /api/orders/pull-online { income_source_id, days? }`.
- Needs the product SKU in Shopify to match a POS product; a line with an unknown SKU imports
  but dispatching it stops with "Insufficient stock" (no stock for an unknown item).

**Server settings moved out of backend/.env into Settings (admin only, no restart):**
- **Settings > Server & public address** - the public web address (was `APP_BASE_URL`; required
  for M-Pesa URL registration) with a "Check this address" test, and the allowed website
  addresses (was `CORS_ORIGIN`; read on every request, so changes apply instantly).
- **Settings > Email (outgoing mail)** - SMTP host/port/SSL/user/password/from (was `SMTP_*`)
  with Gmail/Outlook quick-fill and a "Send test email" button that turns provider errors
  ("535 ... not accepted") into advice (Gmail App Password). The password is stored ENCRYPTED,
  is write-only (no endpoint returns it, not even encrypted), and the audit log records that it
  changed, never what it is. Backup emails and failure alerts use it via one shared `mail.service`.
- **Settings > Payment gateways > KCB connection details** - sandbox/production addresses and
  token path (was `KCB_*`), normally left empty.
- A value saved in Settings wins; an existing `.env` value still works as the fallback, so older
  installs keep working untouched. The generic `PUT /api/settings` refuses these keys so it can't
  bypass their validation (https-only for gateway callbacks; no "mpesa"/"safaricom" in the
  public address; origins must carry a scheme; ports 1-65535; etc.).
- `backend/.env` now only contains the auto-generated secret keys; there is nothing in it to edit.

Tests: +38 (`onlineOrdersPull*.test.js` 19, `systemConfig.test.js` 19); suite 330 passing.
Not verified: a real Shopify store (mocked), real SMTP delivery (mocked transport).

# Shopify / WooCommerce order history fixed (v22)

**Why order history didn't load** - four separate faults, all in the order-sync path:

1. **Imported sales were filed under the wrong store (the main one).** When an income
   source had no store set - and the Settings form never sets one - the sync silently
   created a brand-new store named after the source and filed every order there. Sales
   history, reports and the dashboard only show the signed-in user's own store, so the
   sync reported "Imported 25 of 25" while Sales history stayed empty. Sources now default
   to the creator's store, and any sales already imported under the stray store are moved
   onto the right one automatically on the next sync (no re-import needed).
2. **No way to ask for history.** Only the last 30 days were ever requested. The first sync
   now covers 60 days (exactly Shopify's own default window) and the Sync sales control on
   each source is a menu: new & changed / last 30 days / 90 days / 12 months / all history.
   API: `POST /income-sources/:id/sync-sales` with `{}`, `{ days: 1-3650 }` or `{ all: true }`.
3. **One bad order blocked everything.** All orders were imported in a single transaction, so
   one malformed order rolled back the whole batch and left the "last synced" time unmoved -
   the identical failure repeated on every sync and history never loaded. Each order is now
   imported on its own; failures are listed in the result and retried next sync, and the
   watermark only advances when everything succeeded (and is taken from when the sync
   STARTED, minus a 60 s margin, so an order created mid-download is never missed).
4. **Already-imported orders were ignored forever.** A cancellation, refund or price change in
   Shopify/WooCommerce never reached the POS, so cancelled orders kept counting as revenue.
   Incremental syncs now ask for orders created OR UPDATED since the last sync
   (`updated_at_min` / `modified_after`) and refresh status and total on existing sales.

**Shopify's 60-day rule (not a bug, but it looked like one).** Shopify shows an app only the
last 60 days of orders - any date filter, however old, is clamped to that - unless the app is
granted the `read_all_orders` scope. When you ask for a longer period and nothing older than
~60 days comes back, the sync result now says so and what to do. Test connection also checks
order access (reports the number of orders the app can see, warns if `read_orders` is
missing, and notes the 60-day limit until `read_all_orders` is granted).

**Also fixed:** placeholder products for order lines with no matching SKU used the first 12
BYTES of the product name as their SKU, so "Leather Office Chair Black" and "...Brown" merged
and every later sale of either was booked to whichever came first. Placeholders are now keyed on
a hash of the full name (old ones are reused only on an exact name match) and stay out of the POS.

Tests: +24 (`onlineSalesSync*.test.js`); suite is 292 passing. The sync tests are split across
two files because the sync endpoints share a real 20-requests/15-minutes rate limit.

**Not verified here:** no real Shopify store was available, so the Shopify calls themselves are
tested against mocks (request parameters, Link-header pagination, status handling). Run a real
"Load the last 12 months" and check the result line. Whether your Shopify app already has
`read_all_orders` is something only Shopify's dashboard can tell you.

# Zero-config startup (v21)

The server now configures itself. You no longer copy `.env.example`, edit
secrets, or see the "JWT_SECRET is not set" / "CORS_ORIGIN is not set" messages.

- **Secrets generate themselves.** On first run (server, `migrate`, `seed`,
  anything that opens the database) `config/env.js` creates `backend/.env` with a
  random `JWT_SECRET`, `ENCRYPTION_KEY`, `PAYMENT_WEBHOOK_SECRET` and
  `LEAD_INTAKE_SECRET` - unique per install, nothing secret ships in the zip.
  A second start changes nothing and prints nothing. Placeholder values copied
  from `.env.example` are replaced in place; real values, other lines and
  comments are never touched; a value supplied by pm2/systemd/Docker wins.
  The file is written atomically, owner-only (0600). If it cannot be written the
  server refuses to start with a plain explanation rather than run on secrets
  it couldn't save.
- **No more cwd traps.** `.env` and the default database/backups/logs location
  are resolved relative to `backend/`, not the folder the command was run from
  (previously `npm start` from another directory silently ignored `.env` and
  created a second, empty database).
- **CORS needs no setting.** With `CORS_ORIGIN` unset, the browser may call the
  API from this machine and from the shop's network (localhost, 10.x, 172.16-31.x,
  192.168.x, *.local) on any port - so a phone on the shop WiFi just works - and
  not from public websites. `CORS_ORIGIN`, if set, becomes an exact allow-list for
  a publicly hosted frontend. Production no longer refuses to start without it.
  A refused origin used to surface as a 500 with a stack trace; it is now a
  plain browser-side block plus ONE log line per origin saying how to allow it.
- **Frontend finds the backend by itself**: it uses the same host that served the
  page, port 4000 (`VITE_API_URL` is only for a backend elsewhere).
- **Lead-form secret** is shown to admins under Settings -> Website form leads
  ("Show secret" / "Copy") instead of needing a file on the server.
- Fresh databases get the v19/v20 columns in `CREATE TABLE`, so a new install no
  longer prints the "first pass hit no such column ... backfilling" lines (that
  note now only appears when upgrading an older database).
- Added `.gitignore` (`.env`, `*.bak`, `data/`, `logs/`, ...) and removed the
  stray `backend/.env.bak` that shipped in earlier zips (audit C1/C2).
- Tests: +20 (bootstrap, CORS policy, secret endpoint); suite is 258 passing.
  Verified end-to-end on a clean copy with no `.env`: migrate -> seed -> start
  with `NODE_ENV=production` from an unrelated working directory -> no warnings;
  LAN origin allowed, public origin blocked; restart prints nothing new.

**If you already have a `backend/.env`:** keep it - nothing in it is overwritten,
and any blank/placeholder secret is filled in. **If you start on an existing
database with no `.env`:** a NEW `ENCRYPTION_KEY` is created and the server
warns that SMS/gateway credentials saved earlier must be re-entered (they were
encrypted under a key that no longer exists).

# Legacy-POS Port, part 2: receipts, web-form leads, couriers, shift handover, permissions, 2FA (v20)

Phases 4-6 of the older-POS port plan (phase 3, notifications, shipped in v19).
Backend suite: 177 -> 238 tests, all passing. Frontend: `vite build` clean,
oxlint 0 errors / 9 warnings (same `exhaustive-deps` pattern as existing cards).

## Phase 4 - Receipts and dispatch slips

- `GET /api/orders/:id/receipt` and `GET /api/sales/:id/receipt` return a
  ready-to-print document composed SERVER-side: business name/phone/address/
  footer, items, totals, balance, courier, and - while money is still owed -
  "Paybill + Account" (prefix applied via `kcb_account_prefix`). Composed on the
  server because Settings is admin-only; a cashier must be able to print.
- Frontend `PrintReceipt`: 80 mm layout (prints fine on A4), buttons on the
  order panel, Sales history rows, and right after a till checkout. Everything is
  rendered as React text nodes - the older system's receipt pasted customer
  names into an HTML string and `document.write()`-ed it (stored XSS). Smoke-
  rendered with `<script>`/`<img onerror>` in the customer and product names:
  printed as plain characters.

## Phase 5 - Website-form lead intake

- `POST /api/integrations/leads/intake`, authenticated by an `X-Intake-Secret`
  HEADER (env `LEAD_INTAKE_SECRET`; fails closed with 503 if unset). The older
  system accepted anyone's POST. The secret is deliberately not in the URL, so it
  can never reach an access log.
- Understands the WPForms webhook shape (`formId`, `formName`, `wpEntryId`,
  `fields{...}`: Name / First+Last, Phone Number, Alternative Phone Number,
  Location / Delivery County, "Additional information...", colour/size variants -
  the same labels the older controller read) and a flat `{name, phone, ...}`.
- Idempotent on the form's own entry id (a retried delivery is a no-op that
  still answers 200). A phone that already has a lead NEVER creates a second
  one: the repeat enquiry is added to that lead's timeline and its owner gets a
  notification. Raw payload kept on the lead. No usable phone -> 400.
- `lead_form_routes` (Settings -> Website form leads) replaces the older
  "form name must equal product name" rule: form name -> product (+ optional
  fixed rep); unrouted forms still create leads and use equal distribution.
- Source is stored as `other` (or `shopify` when the payload says so) because
  `leads.source` has a CHECK constraint and rebuilding that table was not worth
  the risk; the form name is on the lead.

## Phase 6 - Smaller ports

**Couriers.** Named riders/agents (`couriers`, `orders.courier_id`). Picking a
named courier on an order also sets `courier_type`; picking only a type clears
the named courier. Never hard-deleted (past orders keep their rider). Finance ->
Couriers tab shows each rider's unpaid parcels and amount owed.

**Shift-close accountability.** `GET /api/shift/handover` lists the signed-in
person's open items (unconfirmed COD orders, unpaid/partial parcels, leads that
are new or past their follow-up date). Clock-out and cash-session close first
show them, accept an optional note, write a snapshot to the audit log
(`shift_handover`), and notify managers once per person per day - only when
something is actually open. Advisory, never blocking; if the lookup fails,
clock-out proceeds.

**Per-user permissions.** `config/permissions.js` is a catalogue of 18 delegable
keys whose DEFAULTS equal exactly the role lists that were hardcoded in the
routes (so nothing changes for anyone on upgrade). `requirePermission(key)`
replaced 44 `requireRole` guards on those routes; an admin can allow or block one
key for one person (Staff -> Access). Admin always passes and cannot be
restricted; you can't edit your own; unknown keys deny. Deliberately NOT
delegable: settings, backups, gateway/SMS credentials, staff management,
onboarding, income sources, telesales rebalancing, audit log, owner write-offs.
Sign-in responses now carry the effective list (`user.permissions`), used for
nav/route visibility on Dashboard, Catalog, Shopify sync, Reconciliation and
Payroll; the server re-checks every request regardless. Also: sign-in responses
no longer include `token_version`.

**Admin 2FA (SMS code).** Opt-in per account (Staff -> Access); nobody is
affected until an admin switches it on. After a correct password the user gets a
6-digit code and NO session until `POST /api/auth/verify-otp`. Built to avoid the
older OTP's problems: `crypto.randomInt` (not java.util.Random); stored in the DB
with a 5-minute expiry as an HMAC keyed with JWT_SECRET (never the code, never
logged, never in sms_outbox); bound to one login attempt by a random token (not
keyed by phone number); max 5 guesses per code, 3 resends with a 30 s cooldown,
5 challenges per hour; uniform error message; a code that couldn't be sent is
invalidated and login returns 503. PIN login is refused for 2FA accounts. Enabling
is refused unless the person has a valid mobile number AND SMS credentials are
saved (otherwise you'd lock them out). Break-glass if SMS ever fails:
`npm run disable-2fa -- <email>` on the server.

## Caveats - read before relying on it

- **Not browser-tested.** The backend is covered by tests; the frontend was
  built, linted and smoke-rendered (receipt/handover output checked), but no one
  has clicked through the new screens. Print one real receipt on your actual
  printer before trusting the layout.
- **2FA and Zettatel's reply format.** Success is judged by the same
  conservative `interpretResponse` as customer SMS (HTTP 2xx, no explicit failure
  marker). Send a test SMS and confirm Zettatel's real reply first. Do not enable
  2FA for the only admin until a code has reached a real phone, and keep shell
  access for `disable-2fa`.
- Enabling/disabling 2FA signs that account out everywhere (token_version bump).
- Permission changes take effect on the person's next request, but the nav in
  their open browser tab only refreshes on their next sign-in/refresh.
- The Dashboard's "unpaid parcels by courier" still groups by courier type; the
  per-rider figures live on the Couriers tab.
- Unchanged from the v18 audit and still open: the seeded admin PIN (S1) - 2FA
  removes PIN login for accounts that enable it, but the default is not changed.
- Test suite: needs a real `better-sqlite3` install; verification here ran
  against a `node:sqlite` shim. Please run `npm test` locally.

# Legacy-POS Port: KCB IPN, Customer SMS, Notifications (v19)

Ports the three highest-value capabilities of the older Spring Boot POS into
this codebase — as *contracts and behaviours*, not code. Plan and audit
rationale: see the legacy-vs-new comparison; item IDs below (S2, B16 ...)
refer to the two audits.

## Phase 1 — KCB callback matches KCB's real payload

- `adaptKcbCallback` now understands the Buni IPN envelope the live older
  system already receives: `requestPayload.additionalData.notificationData`
  (`businessKey`, `transactionID`, `transactionAmt` as a STRING, `debitMSISDN`,
  names, `currency`, `narration`). Before, it guessed flat field names
  (`accountNumber ?? BillRefNumber ?? narration`), so a real delivery would
  have fallen through to "unmatched". A flat-shaped body still works.
- The endpoint now replies with KCB's acknowledgement envelope (`header`
  ids echoed, `statusCode "0"`, `transactionInfo.transactionID`) — copied from
  the older system's working controller. Non-envelope callers keep the old
  `{ status, id }` reply.
- Idempotency key is `transactionID` (falls back to `messageID`). Amount
  parsing tolerates thousands separators ("1,500.00" was previously read as 1).
  A non-KES notification is recorded but forced into the manual-review queue.
- Account reference: KCB returns the full business key (`8025631#UT000123`).
  Matching already finds `UT######` anywhere in the string, so the prefix is
  tolerated; new settings `paybill_number` and `kcb_account_prefix` control
  what customers are TOLD (SMS today, receipts later). Both default blank —
  the older system showed paybill 522533 in SMS but 522522 on its receipt, so
  **confirm the real number** before filling it in.
- **Security fix (audit S2):** the request logger wrote `req.originalUrl`,
  which for provider callbacks contains the shared secret
  (`/callbacks/kcb/<secret>/callback`). The secret segment is now masked in
  every log line. Rotate the webhook secret if old logs were shared.

## Phase 2 — Customer SMS (Zettatel) via a durable outbox

- New tables `sms_credentials` (AES-256-GCM, same helper as the payment
  gateways) and `sms_outbox`. Business code only INSERTs a `queued` row inside
  its own DB transaction (a rolled-back order never texts); a 30-second timer
  sends with retry/backoff (1, 5, 15, 60 min, 5 attempts), recovers rows stuck
  in `sending`, and expires anything older than 24h rather than delivering it
  late. `dedupe_key` stops a redelivered webhook texting twice.
- Triggers: order created -> "order received" (product, delivery promise,
  paybill/account); payment recorded (webhook OR manual) -> "payment received"
  with remaining balance. Wording ported from the older system, with its
  hardcoded paybill / catalog URL / 24h promise turned into settings.
- Fixes over the older implementation: 15s request timeout (it had none);
  message bodies are never logged (it logged OTPs and bodies); the real
  provider reply is stored on every row; SMS failure can never fail an order.
- Master switch `sms_enabled` is **OFF by default**. Settings -> Customer SMS:
  save credentials, send a test, then switch on. Credentials may alternatively
  come from `ZETTATEL_USER_ID` / `ZETTATEL_PASSWORD` / `ZETTATEL_SENDER_ID`.
- **Unverified:** the older system never parsed Zettatel's reply, so the exact
  success/failure body is unknown. `interpretResponse` is deliberately
  conservative (HTTP 2xx and no explicit failure marker). After the first test
  send, read `sms_outbox.provider_response` (also shown in the UI) and tighten
  it. Zettatel `msgType` defaults to `unicode` (what the live system uses);
  `text` is selectable and cheaper but untested here.
- API: `GET/PUT/DELETE /api/sms/credentials` and `POST /api/sms/test` (admin),
  `GET /api/sms/status`, `GET /api/sms/outbox`, `POST /api/sms/outbox/:id/retry`
  (admin, manager).

## Phase 3 — In-app notification centre

- New `notifications` table, one row per recipient, so ownership is a plain
  `user_id` check: `GET /api/notifications`, `/unread-count`,
  `POST /:id/read`, `POST /read-all` — all strictly the caller's own rows
  (someone else's id is a 404, unlike the older system's unchecked mark-read).
- Delivered by polling (30s) rather than SSE: the older SSE channel never
  worked in its own frontend (`EventSource` cannot send an Authorization
  header, and the page read the wrong token key and env var).
- Events: lead assigned / reassigned / auto-rebalanced (to the new owner);
  lead follow-up due (the owner AND managers/admins — the older system told
  admins only); damaged return awaiting an owner decision (admin, urgent —
  replaces the "owner_notified_at is the notification for now" placeholder);
  unmatched payment (admin, manager); low stock / out of stock (admin,
  manager; once per low episode, re-armed when stock recovers).
- A 15-minute sweep (plus one 20s after boot) raises follow-up and low-stock
  notices and prunes old ones (read after 30 days, anything after 90).
- UI: bell with unread badge in the sidebar header and the mobile top bar;
  clicking a notice marks it read and opens the relevant page.

## Other changes

- Settings: new "How customers pay" and "Customer SMS" cards. `GeneralSettings`
  previously PUT the entire settings object, which would have overwritten
  SMS/payment changes made in other cards with stale values — it now sends
  only its own keys.
- `utils/phone.js`: `toMsisdn()` (Kenyan 07/01 numbers -> 2547/2541...; returns
  null rather than guessing).
- Tests: +51 (KCB adapter/endpoint 10, SMS 25, notifications 16). The suite
  also had 7 pre-existing failures unrelated to this work, now fixed:
  5 order tests and the payroll-advance test were stale since Phase 2 (they
  dispatched COD orders without the confirmation the gate requires; the advance
  was filed by the admin but asserted on the rep), the COD-expiry test used a
  negative window that SQLite reads as NULL (so no expiry was ever stored), and
  `crossStoreAuthorization` / `forcedPasswordChange` required `config/db`
  BEFORE `./setup`, so they opened the real `data/urban_trends.db` and wrote
  test users into it. **If you ran the suite before, check your dev database
  for `storeb@urbantrends.com` and `tempuser@urbantrends.com`.**
- Verification: backend suite run in full (126 tests -> 177, all passing). The sandbox
  could not compile `better-sqlite3`, so the suite ran against a shim that
  maps its API onto Node's built-in `node:sqlite` — please re-run
  `npm test` on a real install. Frontend: `vite build` clean, oxlint 0 errors
  (9 warnings, 3 new — the same `exhaustive-deps` pattern as existing cards).
  The new UI has not been clicked through in a browser.

# STK Push, Shopify/WooCommerce Dedup Fix, and Frontend Cleanup

Follow-up to the M-Pesa/KCB/WooCommerce phase — closed out every remaining
item from that session's "what's left" list except the dark/light theme
toggle (explicitly deferred by request) and P2/P3 audit items (original
doc not available in this session).

## M-Pesa STK push — now actually wired

Previously built (`initiateStkPush` in `config/mpesa.js`) but deliberately
left unconnected, since STK's callback payload has a different envelope
than C2B Confirmation and doesn't echo back `AccountReference` at all.
Fixed properly rather than reusing the C2B route incorrectly:
- New `stk_push_requests` table tracks each push (`checkout_request_id` →
  `account_reference`, phone, amount) at initiation time — verified
  against a real SQLite run.
- `adaptMpesaStkCallback()` parses Safaricom's actual `stkCallback`
  envelope; new `/callbacks/mpesa/:token/stk` route looks the pending
  request up by `CheckoutRequestID`, marks it completed/failed, and only
  calls `ingestNotification()` on success (a cancelled/timed-out push
  moved no money — nothing to reconcile).
- Settings gets a "Send test payment" companion: `POST
  /settings/payment-gateways/mpesa/stk-push`.

## Shopify/WooCommerce sync dedup — root cause found and fixed

Traced to `idx_products_variant_per_source`, which scopes uniqueness by
`COALESCE(income_source_id, 0)`. The legacy env-var Shopify sync
(`income_source_id = NULL`) and a properly configured Shopify income
source pointed at the *same physical shop* were two different keys —
approving the same Shopify variant from both staging queues created two
separate `products` rows for one real item. Fixed with a startup
migration (`migrateLegacyShopifyEnvToIncomeSource` in `db/migrate.js`):
gives the env-var shop a real `income_sources` row if it doesn't already
have one, and re-points every orphaned `income_source_id = NULL` Shopify
row (staging + products) to it. `shopify.controller.js`'s legacy routes
now resolve that same row instead of passing `undefined` through, so
there's only ever one `income_source_id` in play for that shop from here
on. Verified end-to-end against a real SQLite database: correct
reassignment of orphaned rows, purely-local products (no
`shopify_variant_id`) correctly left untouched, and running the migration
twice (simulating a restart) creates zero duplicate rows.

## Frontend cleanup

- **TabBar extraction**: `components/TabBar.jsx` replaces byte-identical
  duplicated markup in Finance.jsx/Catalog.jsx plus a third near-identical
  variant in SalesHistory.jsx's channel filter (two visual variants:
  `page` and `filter`, both taken from the real existing styles, not
  invented).
- **Route-based code splitting**: every page except Login and POSTerminal
  (the two on the most common path — unauthenticated entry and the
  landing page every shift hits first) now loads via `React.lazy`. Main
  bundle: 500KB → 350KB, split into 16 separate chunks. Verified with a
  real `vite build`.
- **Toast/dialog system**: `context/UIContext.jsx` — `useToast()`
  (non-blocking success/error/info, auto-dismissing) and `useDialog()`
  (promise-based `confirm()`/`prompt()`, including a radio-button
  "options" mode) replace all 25 native `alert`/`confirm`/`prompt` calls
  across 12 pages. One of the four `prompt()` calls (Orders.jsx's
  return-reason picker) was a disguised multiple-choice question wearing
  a "type 1, 2, or 3" free-text prompt — converted to the dialog's options
  mode instead of preserving that UX. Destructive actions (deactivate,
  delete, cancel) are marked `danger: true` for red confirm styling;
  non-destructive confirmations (generate password, mark good) use the
  default style — this distinction didn't exist with native `confirm()`.

## Verification

Same sandbox limitation as every backend phase — native `better-sqlite3`
can't be installed here (network egress). What WAS verified for real
this time: the STK tracking table and the dedup migration both ran
against actual SQLite (via Node's built-in `node:sqlite`, through a
verification-only shim, deleted before packaging — not shipped). The
entire frontend (all edited pages, the new TabBar and UIContext
components, App.jsx's lazy-loaded routes) was verified with a real `npm
install` + `vite build` + `oxlint` — 0 errors, 6 pre-existing warnings
unrelated to this session's changes, confirmed against Settings.jsx's
and AuthContext.jsx's pre-existing patterns.

# STK Push, Shopify Dedup Fix, Code Splitting, Toast/Dialog System

Closed out the rest of the backlog from the last two phases (dark/light
theme explicitly excluded per request).

## M-Pesa STK push — now actually wired

Last phase built `initiateStkPush` but left it unconnected — its callback
payload has a different envelope than C2B Confirmation (no
`AccountReference` at all), so pointing it at the same route would have
silently produced garbage. Fixed properly instead of papering over it:
- New `stk_push_requests` table tracks each push's account reference
  (product code) at initiation time, keyed by `CheckoutRequestID` —
  verified against a real SQLite run (node's built-in `node:sqlite`,
  since the sandbox still can't install `better-sqlite3`).
- `adaptMpesaStkCallback()` parses Safaricom's actual
  `Body.stkCallback.CallbackMetadata.Item[]` envelope.
- New `/callbacks/mpesa/:token/stk` route looks up the pending request by
  `CheckoutRequestID`, recovers the account reference, and feeds
  `ingestNotification()` — only for successful pushes; cancelled/timed-out
  ones are recorded as `failed` with no money to reconcile.
- Settings UI: a working "Send test payment via STK" action alongside the
  sandbox `simulate` one from last phase.

## Shopify/WooCommerce sync dedup — real bug, root-caused and fixed

Diagnosed exactly why this was flagged as unresolved since v5: the legacy
single-shop env-var sync (`income_source_id = NULL`) and a properly
configured Shopify income source treat the SAME physical shop as two
*different* keys under `idx_products_variant_per_source`
(`COALESCE(income_source_id, 0)` scoping). Running both against the same
shop created two separate `products` rows for the same item — a real
data-integrity bug, not a cosmetic one.

Fixed with a one-time startup migration
(`migrateLegacyShopifyEnvToIncomeSource` in `db/migrate.js`): if
`SHOPIFY_SHOP`/`SHOPIFY_ACCESS_TOKEN` are set and no matching
`income_sources` row exists yet, creates one and re-points every orphaned
`income_source_id = NULL` row (both `shopify_staging_products` and
`products`, scoped to `shopify_variant_id IS NOT NULL` so purely local
products are never touched) onto it. The legacy controller now resolves
to that same row (`shopify.service.js`'s `getLegacyEnvSource()`) instead
of passing `undefined` through — so from here on there's only ever one
`income_source_id` in play for that shop, whichever entry point triggers
the sync.

Verified for real: seeded a fresh SQLite DB with an orphaned product +
staging row, ran the migration, confirmed correct reassignment, then ran
it a second time (simulating a restart) and confirmed zero duplicate
`income_sources` rows — true idempotency, not just "didn't crash."

## Route-based code splitting

`App.jsx`'s 16 admin/back-office pages now load via `React.lazy` +
`Suspense`; Login and POSTerminal (the two pages every session actually
hits first) stay eager. Verified with a real `vite build`: main bundle
dropped from 500KB to 350KB, split into 16 separate chunks, and the
"chunk larger than 500kB" warning is gone.

## Toast/dialog system replacing all 25 native alert/confirm/prompt calls

New `context/UIContext.jsx`: `ToastProvider`/`useToast()` for
non-blocking success/error/info notifications (stacked, auto-dismissing,
replaces `alert()`), and `DialogProvider`/`useDialog()` with
promise-based `confirm()`/`prompt()` (replaces `confirm()`/`prompt()`
without freezing the tab). Destructive actions get a red confirm button
via `{ danger: true }`.

One genuine UX improvement along the way rather than a purely mechanical
swap: Orders.jsx's return-reason flow used to be a `prompt()` asking the
person to type "1, 2, or 3" against a numbered list — now it's a real
radio-button picker (`dialog.prompt({ options: [...] })`), since that's
what it always actually was.

Converted every call site across all 12 files (Requisitions, Orders,
PaymentReconciliation, Categories, Payments, Products, ShopifySync,
Expenses, Settings, Leads, SalesHistory, Staff) — confirmed zero native
`alert`/`confirm`/`prompt` calls remain anywhere in `src/pages` via a
final grep sweep, a clean production build, and a full `oxlint` pass (0
errors; the only warnings are pre-existing patterns already present
elsewhere in the codebase, not new).

## Explicitly not done (per request)

Dark/light theme toggle — still not started, unchanged from last phase.

# M-Pesa/KCB Real API Clients + WooCommerce Sync Fix

Closed the gap flagged in earlier phases: credentials were stored and
encrypted, but nothing actually talked to Safaricom or KCB. Also fixed a
real bug found while reviewing WooCommerce's already-built sync path.

## M-Pesa (Safaricom Daraja) — fully wired

- `config/mpesa.js`: OAuth (client-credentials, cached token), C2B
  `registerurl`, sandbox-only `simulate`, and `stkpush` (built but not
  yet wired to a callback route — see below).
- New raw callback routes, separate from the existing normalized
  `/api/integrations/payments/mpesa/webhook` (kept as-is for manual/
  internal testing): `/api/integrations/payments/callbacks/mpesa/:token/{validation,confirmation}`.
  Auth is the webhook secret embedded in the URL path itself (Safaricom
  doesn't support a custom auth header on these calls) —
  `middleware/webhookPathAuth.js`, checked via `paymentGatewayCredentials
  .findByWebhookToken()` with a `PAYMENT_WEBHOOK_SECRET` env fallback for
  the single-store case.
- `services/paymentCallbackAdapters.js` translates Safaricom's real
  Confirmation payload (`TransID`, `TransAmount`, `BillRefNumber`, `MSISDN`,
  ...) into the fields `ingestNotification()` already expects. Validation
  always accepts (matches the "never silently drop a payment" philosophy
  used elsewhere — anything that doesn't match still lands in the
  reconciliation queue instead of being rejected at the till).
- Settings UI: "Test connection" (real OAuth round-trip), "Register
  webhook URLs with Safaricom" (one click, builds the URLs from the new
  `APP_BASE_URL` env var), and a sandbox-only "Send test payment" form
  wired to `simulateC2B` — the actual way to test the whole pipeline
  end-to-end without a real phone or money.
- **Not done**: STK push isn't wired to a callback route yet — its
  callback payload has a different envelope than C2B Confirmation, so
  pointing it at the same route would silently produce garbage
  `ingestNotification()` calls instead of failing loudly. `simulateC2B`
  is the recommended way to test today; a dedicated STK callback handler
  is a clean follow-up if you end up preferring that flow over C2B.

## KCB — scaffold, explicitly not verified

`config/kcb.js` and the `/callbacks/kcb/:token/callback` route follow the
same shape as M-Pesa (OAuth, path-token auth, tolerant field-name
adapter), but KCB's Buni platform gates real docs behind an approved
developer account, so the base URL, token endpoint, and callback payload
shape are best-effort guesses, clearly flagged in code comments — not
verified against a live account. `adaptKcbCallback()` tries several
plausible field names and always keeps the full raw payload, so the first
real test transaction can be used to tighten it to the actual shape
instead of a rewrite. "Test connection" only checks that the OAuth
credentials authenticate (the one thing that's portable across products);
it deliberately doesn't attempt callback registration.

## WooCommerce — real bug found and fixed, not otherwise touched

Reviewed the already-built pull-based sync (product catalog + sales,
`income_sources` platform=`woocommerce`) end-to-end. It was already fully
wired (Settings UI → routes → services), but incremental sales sync had a
real bug: `last_sales_synced_at` is stored via SQLite's `datetime('now')`
("YYYY-MM-DD HH:MM:SS" — a space, no timezone), which is not valid
ISO8601. WooCommerce's `after` filter parses strictly and either ignores
or rejects that value depending on version, meaning every sync after the
first one likely re-fetched the full 30-day lookback window instead of
just what changed. Fixed by converting the stored timestamp to real
ISO8601 before it's sent (`salesSync.service.js`).

## Verification

Sandbox still blocks `better-sqlite3`'s native build (network egress), so
the real test suite couldn't be run here — same recurring limitation as
every backend phase in this project. What WAS verified for real this
time: the payload adapters (pure functions, no DB — ran directly against
realistic Safaricom/KCB-shaped sample payloads) and `findByWebhookToken`
(ran against a real SQLite file via Node's built-in `node:sqlite`, using
the app's actual `encrypt`/`decrypt` and the real service function —
confirmed correct token save→match, and correct rejection of wrong
token/wrong provider/empty token). The frontend changes were verified for
real via `npm install` + `vite build` + `oxlint` (clean, 0 new warnings).
The OAuth/HTTP client code itself (`config/mpesa.js`, `config/kcb.js`)
could not be exercised without real Safaricom/KCB credentials — that
still needs to happen against your actual sandbox account.

# Navigation Redesign & Visual Restyle (round 1)

Two things in one pass, at the user's direction: restyle first (rather
than theming first as originally recommended), and regroup the navigation,
which had grown to 16 flat items after Phase 5.

## Navigation

Grouped by **what you're doing**, not by which backend module a page
belongs to. Five groups plus three ungrouped items:

- *(pinned top)* **Terminal**, **Dashboard** — where a shift starts; never
  buried behind a disclosure triangle to save two lines
- **Sell** — Orders, Leads, Sales history
- **Stock** — Catalog, Shopify sync
- **Money** — Finance, Reconciliation, Requisitions
- **Team** — Attendance, Payroll, Staff, Onboarding, Activity log
- *(pinned bottom)* **Settings**

Two placements worth defending: **Attendance sits under Team, next to
Payroll**, because attendance data is literally what drives payroll
deductions — putting it in an Operations bucket would separate cause from
effect. **Reconciliation sits under Money, not next to Orders**, because
the person resolving an unmatched payment is doing bookkeeping, not
fulfilment.

Behaviour: groups collapse, collapse state persists per browser (a cashier
who only uses Sell shouldn't re-collapse four groups every morning), and
the group containing the current page is **always** expanded regardless of
saved state — landing on a page with no highlighted nav item anywhere
would be disorienting. Groups that are entirely role-hidden don't render
an empty header. "Staff logs" renamed "Activity log" — it logs actions,
not people, and the old name read like an HR feature sitting next to two
actual HR features.

## Visual restyle

New `components/DataUI.jsx` holds shared primitives so Orders,
Reconciliation and Attendance can't drift apart: `PageHeader` (the
monospace uppercase eyebrow + accent rule above a bold display title),
`DataTable`, `ContextPanel` + `TimelineEntry`, `ActionBar`, `StatusPill`,
`KpiTile`.

Applied so far: page headers with right-aligned monospace meta
(outstanding totals, present/absent counts), denser table rows, monospace
micro-label column headers replacing the old filled grey header bar, and
status pills unified through one component instead of three per-page
colour maps.

**The POS terminal is deliberately almost untouched** — light surface, big
tap targets, product grid all unchanged. The one change is the accent
action bar: item count and total on the left, Charge on the right,
promoted from mobile-only to every screen size. That's an ergonomic
change (one high-contrast block for the eye to land on) rather than a
cosmetic one, which is why it's the exception.

## Not done yet — deliberately

- **Dark/light theming is still not built.** Doing the restyle first was
  the user's call; the consequence is that the ~10–15 components
  hardcoding `bg-ink text-white` will need revisiting when theming
  lands, and some of the restyle work above will be touched twice. Flagging
  it so that's a known cost, not a surprise.
- **`ContextPanel`/`TimelineEntry`/`KpiTile`/`DataTable` are built but not
  yet wired into every page** — Orders keeps its hand-rolled detail panel
  for now. They're in place so the next pass is composition rather than
  more primitives.
- **Verified via `npm install` + `npx vite build` + `npx oxlint`: clean,
  zero errors, zero warnings.** Not clicked through in a browser — nav
  collapse persistence, active-group auto-expand, and the mobile drawer
  all need a real look before trusting them.

---

# Phase 5: Frontend for the Shipped-but-Invisible Backends

The last item on the fix/patch/upgrade plan. Everything here was already
built, tested, and reachable by API — it just had no UI, so in practice it
didn't exist for anyone who wasn't writing curl commands. Five new pages,
no backend changes at all.

**`/reconciliation` — Payment reconciliation** (admin/manager). The plan
called this the highest-value gap, and it was: unmatched M-Pesa/KCB
payments had no resolution path whatsoever without the API. Lists every
payment that arrived but couldn't be auto-matched, with a
search-by-name-or-phone panel to find the right order and match it by
hand — which is exactly the "two Marthas" / "the spouse paid" case from
the original requirements. Flags an exact-amount match when the
outstanding balance lines up. Ignoring requires a typed reason.

**`/orders` — Orders & courier** (all roles). The biggest module: the full
lifecycle in one screen. Action buttons are gated to exactly what the
backend state machine allows next, so the UI can't offer something the
server will reject — COD confirmation before dispatch, boda/G4S courier
choice, payment recording against outstanding balance, the three-step
return flow, manager-only inspection, admin-only write-off, and dispute
raise/resolve. A right-hand panel shows line items, balance, and full
timestamped history. Surfaces the customer risk flag ("prepay only")
where it is actually useful — next to the dispatch button.

**`/attendance` — Clock in/out** (all roles). The plan flagged this as
"quietly load-bearing" and that was exactly right: telesales
auto-distribution only assigns work to staff who have clocked in, and
*nothing in the app was writing attendance data*, so that logic was
effectively inert. Self clock-in/out for everyone; managers additionally
see the whole team's day and an absences callout, with an admin button to
trigger reassignment immediately rather than waiting for the cutoff sweep.

**`/payroll` — Pay summary** (admin/manager). Per-staff, per-period:
retainer, commission with tier and achievement %, each deduction
itemised, net payable. Plus loss-deduction entry. Expandable
attendance-deduction detail so a disputed number can actually be traced
to a date.

**`/employees` — Onboarding** (admin). Create a gated new hire, record
documents, capture the policy signature that activates the account. Says
plainly that the app stores links, not files.

## Notes

- **Nav grew from 11 to 16 items.** That is a lot for one sidebar, and it
  is worth grouping (Operations / People / Admin) — but grouping is a
  navigation redesign, and doing it now would collide with the frontend
  redesign being discussed separately. Left flat deliberately.
- **Employee signing is still admin-witnessed**, as built in Phase 7 — the
  UI reflects that honestly ("have the employee read the policy, then type
  their name") rather than implying a self-service flow that does not exist.
- **Verification:** `npm install`, `npx vite build` and `npx oxlint` all
  ran for real and came back clean (zero errors, zero warnings). Every
  field these pages render was checked against the actual backend
  serializers rather than assumed. But **no page here has been clicked
  through in a browser** — build-clean is not the same as works-correctly,
  especially for the Orders action gating, which has the most conditional
  branches of anything in this app. Walk one order end to end (create →
  confirm → dispatch → part-pay → return → inspect) before trusting it.

## The plan is now complete

Phases 0-3 (stability, access control, hardening, tooling), Phase 4 (the
two strategic decisions, plus offline mode built), and Phase 5 (this) are
all done. Every unresolved item that remains is one of the honest gaps
flagged in earlier entries — real KCB/M-Pesa credentials, the unconfirmed
commission tier numbers, self-service e-signature, and the standing fact
that the backend test suite has never actually been executed in this
environment.

---

# Offline Mode at the Register (Phase 4 decision — resolved)

Two of the plan's three Phase 4 strategic questions are now settled:

- **Deployment topology: one store.** So the "single SQLite file, no
  replication" concern is a non-issue — SQLite is a perfectly reasonable
  choice for a single-site register, and there's no multi-location blast
  radius to worry about. The multi-store scoping already in the schema
  (and the cross-store leaks fixed in Phase 1) stays as latent capability
  rather than an active requirement.
- **Offline mode at the register: yes, build it.** That's what this entry is.

## The guarantee this rests on: idempotency

The dangerous failure mode for any offline queue isn't losing a sale —
it's sending one twice. A register that retries a sale whose response got
lost would otherwise charge the customer once but record the sale twice
and deduct stock twice.

So the backend change came first: `sales.client_sale_id`, a client-
generated UUID, with a **unique partial index**
(`WHERE client_sale_id IS NOT NULL`, so ordinary online sales that don't
send one never collide). `checkout()` looks it up before doing anything
and returns the existing sale untouched if it's already there; it also
catches the unique-constraint violation from a genuine race (two retries
landing simultaneously) and returns the winner's sale. The id is generated
**before the first attempt**, not after a failure — that's what makes the
"request sent, response lost" case safe, not just the "never sent" case.

Verified directly against real SQLite: the same sale sent three times
produces exactly one sale row, one inventory movement, and one stock
deduction.

## Frontend

- **`useOfflineQueue.js`** (new) — persisted queue of unsent sales.
  Distinguishes connectivity failures (retry forever) from server
  rejections like insufficient stock (mark failed, stop retrying, surface
  to the cashier). Nothing is ever discarded automatically — a rejected
  sale where money already changed hands needs a human, and silently
  dropping it would be far worse than showing an error.
- **`useConnectivity.js`** (new) — tracks both `navigator.onLine` *and*
  whether our own API calls are actually succeeding, because a register on
  shop wifi whose router lost its upstream reports `onLine === true` while
  every request fails. Syncs on reconnect, plus a slow poll while anything
  is queued (covers the backend-restarted-but-network-never-dropped case,
  which fires no browser event at all).
- **`useCartStore.js`** — now persisted, so an in-progress basket survives
  a reload or crash instead of needing a re-scan.
- **`POSTerminal.jsx`** — queues on connectivity failure and shows a
  provisional receipt; keeps serving the cached product list while offline
  (`gcTime` raised to 24h) so items can still be rung up; prominent
  offline/sync/failed banners.

**localStorage here, deliberately** — the opposite call from Phase 2.3,
which moved the auth token *out* of it. A queued sale is business data the
customer is watching get rung up; an auth token is a credential. Surviving
a crash matters more for one, being unreadable to other scripts matters
more for the other.

## Honest limitations — please read before relying on this

- **Stock cannot be validated offline.** The register sells against
  whatever count it last cached. Overselling is possible, and when those
  sales sync, some may be rejected for insufficient stock — they'll show
  in the failed list for manual handling. This isn't a bug to fix later;
  it's inherent to selling without a server, and the UI says so plainly
  rather than hiding it.
- **Barcode lookup doesn't work offline** for products not already in the
  visible list — it's a per-code server call, not covered by the cached
  list. The error message says to tap the product instead.
- **Not verified in a real browser.** `npm install`, `npx vite build`, and
  `npx oxlint` all ran clean for real here (zero errors), and the backend
  idempotency was verified against real SQLite. But the actual offline
  behaviour depends on real browser events (`online`/`offline`),
  localStorage persistence across a real crash, and genuine network
  failure — none of which a build/lint pass exercises. **Test this
  manually before trusting it with real sales:** ring up a sale with
  devtools set to offline, confirm it queues and shows the provisional
  receipt; go back online and confirm it syncs to exactly one sale;
  hard-reload mid-cart and confirm the basket survives.

---

# Fix/Patch/Upgrade Plan: Phases 0-3 (Stability, Access Control, Hardening, Tooling)

Implements the audit-derived plan's first four phases. Checked the actual
state of the codebase against every item first (nothing here was assumed
fixed) — every Phase 0/1/2 item was confirmed genuinely unfixed before
work started; Phase 3 had one item already done (`npm audit` in CI) and
one that turned out to already be handled correctly on inspection (3.2).

## Phase 0 — stop the single point of total failure

- **0.1** `config/db.js`: added `busy_timeout = 5000` — a write that lands
  during brief lock contention now waits and retries instead of throwing
  `SQLITE_BUSY` immediately.
- **0.2** `server.js`: all three background `setInterval` bodies (COD
  expiry, telesales rebalance, reconciliation) now wrap their work in
  try/catch. Before this, an error inside any of them wasn't just
  unhandled — it wasn't even the kind of error Express's own error
  handling ever sees, since timer callbacks aren't part of any request.
- **0.3** `server.js`: added `process.on('uncaughtException'/
  'unhandledRejection')` — logs with full context and exits, on the
  reasoning that a process in an unknown state should restart clean
  rather than limp on. Only safe *because* of the next item.
- **0.4** New `backend/ecosystem.config.js` (pm2) and
  `backend/urban-trends-pos-backend.service` (systemd) — pick one. Neither
  is wired up automatically; see the new "Production deployment notes"
  section in `SETUP.md`.

## Phase 1 — access-control fixes (all five were genuinely exploitable)

- **1.1** `sales.service.js#getSaleWithItems`/`#voidSale` now require and
  filter by `storeId` — previously `WHERE id = ?` with no store check at
  all, letting any authenticated user view or void another store's sale.
- **1.2** Removed `sales.controller.js`'s `includeAllChannels=1` bypass
  (`1=1` in place of the store filter) — any authenticated user could set
  this query param and see every store's sales. The frontend
  (`SalesHistory.jsx`) turned out to send this unconditionally, not behind
  any role check; updated it to stop sending a flag that no longer does
  anything.
- **1.3** `cashSessions.service.js#getById` now filters by `storeId`.
- **1.4** `reports.controller.js`'s `salesByChannel`/`salesTrend`/
  `paymentMethods`/`topProductsByChannel` now all filter by
  `req.user.storeId` — previously aggregated across every store
  unconditionally, no store check anywhere in any of the four queries.
- **1.5** `payments.controller.js#create`'s sale-existence check is now
  store-scoped — previously let a payment record reference another
  store's sale (a data-integrity break as well as a boundary leak).
- **1.6** New `tests/crossStoreAuthorization.test.js` — a real second
  store + admin created directly via the DB (this app has no public
  "create store" endpoint), proving each of the five fixes above actually
  blocks cross-store access while confirming same-store access still
  works (no-regression checks alongside each fix).

## Phase 2 — medium hardening

- **2.1** Seeded admin no longer gets a hardcoded password. `seed.js`
  generates a random one-time password (printed once, production only —
  test runs still get the old fixed credential, or the entire test suite
  breaks), sets a new `must_change_password` flag, and `middleware/auth.js`
  now blocks every authenticated route except `/api/auth/{change-password,
  logout,me}` while that flag is set. New `POST /api/auth/change-password`
  clears it and bumps `token_version` (revoking the session that made the
  change — a fresh login with the new password is required). Frontend:
  new `ChangePassword.jsx` page, wired into `ProtectedRoute` so a
  must-change account lands there automatically instead of hitting a page
  that would just 403 on its first API call.
- **2.2** `auth.controller.js` login/PIN-login now always run
  `bcrypt.compareSync` against a real hash (a precomputed dummy one when
  the account doesn't exist) — previously `!user || !bcrypt.compareSync(...)`
  short-circuited before ever hashing for a nonexistent account, a timing
  difference real enough to enumerate valid emails/PINs without a correct
  password.
- **2.3** Access token moved out of `localStorage` entirely — it now
  lives in a module-level variable in `api/client.js`, invisible to
  anything that can read localStorage (any XSS anywhere on the page, a
  malicious extension). A hard reload loses that variable by design;
  `AuthContext` now does a silent `performRefresh()` on boot (same
  dedup'd refresh call the 401-retry path already used) to re-establish
  it from the httpOnly refresh cookie, with a brief `initializing` state
  so `ProtectedRoute` doesn't flash the login screen while that resolves.
- **2.4** New `alerting.service.js` — backup failures and email-backup
  failures (`backup.service.js`) and inventory drift (`server.js`'s
  reconciliation sweep) now also send a real email through the same SMTP
  setup/recipient list backups already use, not just a log line. Doesn't
  throw on its own failure (a broken mail server shouldn't turn a backup
  failure into a second, unhandled failure) — logged either way.

## Phase 3 — process & tooling

- **3.1** Already done — `.github/workflows/ci.yml` runs `npm audit
  --audit-level=high` for both backend and frontend.
- **3.2** Spot-checked `categories`/`expenses`/`payments`/`inventory`
  controllers' update/delete paths (beyond the `products.controller.js`
  example originally cited) — all already have a proper missing-row
  check before mutating. No changes needed; this one turned out to
  already be consistent.
- **3.3** New `config/limits.js` centralizes every rate-limit window/max
  and pagination default/cap that was previously an inline literal spread
  across `app.js` and four route files, plus `utils/paginate.js` and five
  controllers. Same values everywhere except one genuine fix caught along
  the way: `cashSessions.controller.js`'s `pageSize` had no upper bound at
  all (`|| 20` with nothing capping a client-supplied value) — now capped
  like every other list endpoint.
- **3.4** `SETUP.md` — new "Production deployment notes" section covering
  the Phase 0.4 supervisor configs and the in-memory rate-limiter store
  (resets on every restart; fine for one instance, would need a shared
  store like `rate-limit-redis` behind a load balancer).

## Verification

Backend: syntax-checked every changed file, then the same approach as
every other phase in this project — full `schema.sql` executed against
real SQLite, the `must_change_password` additive migration simulated
against a hand-built pre-2.1 `users` table, and the actual fixed queries
(store-scoped sale/session lookups, the four report aggregates, the
attendance-deduction hour math untouched by this pass) run directly
against real SQLite with two-store seeded data confirming isolation.
**Still needs `npm install && npm test` run for real** — same
`better-sqlite3` sandbox limitation as every backend phase before it.

Frontend: unlike the backend, this sandbox has no native-dependency
problem for the frontend — `npm install` and `npx vite build` both
actually ran and succeeded, and `npx oxlint` came back with zero errors
(one pre-existing warning pattern, unrelated to this change). This is a
real, not simulated, verification of the auth refactor's client-side half.

One thing that's *not* independently verifiable from here: the actual
end-to-end browser behavior of the silent-refresh-on-boot flow (2.3) and
the forced-password-change redirect chain (2.1) — both depend on real
cookie behavior in an actual browser, which a build/lint pass can't
exercise. Test both manually before trusting them: log in, hard-refresh
the page, confirm you're still logged in; and log in as a
`must_change_password` account, confirm you land on `/change-password`
automatically and can't navigate anywhere else until you change it.

---

# Settings Page: Payment Gateway Credentials UI & Editable Backup Recipients

The backend for M-Pesa/KCB credential storage and payment-gateway-specific
webhook secrets (`payment_gateway_credentials` table,
`paymentGatewayCredentials.service.js`, `PUT /api/settings/payment-gateways/
:provider`) and the `backup_email_recipients` Settings field already
existed from earlier work — this closes the gap that neither had a
frontend, so an admin had no way to actually use either without calling
the API directly.

**Settings → Payment gateways (M-Pesa & KCB):** a card per provider with
sandbox/production toggle, the plaintext identifying fields (Paybill/Till
number, KCB account number, M-Pesa initiator name), password-style inputs
for every secret (consumer key/secret, passkey, API key/secret, initiator
password for M-Pesa B2C) that show "•••• (unchanged)" rather than the real
value once set — same pattern as the existing Shopify/WooCommerce
connection form — and a per-provider webhook-secret override field. Each
card shows the exact webhook path to register with Safaricom/KCB
(`/api/integrations/payments/{provider}/webhook`) and states plainly that a
payment nothing can match lands in the reconciliation queue rather than
being dropped. "Configured" only requires the fields actually needed to
*receive* payments — the B2C-only fields (for sending money out, e.g.
supplier refunds) are optional and don't block that status.

**Settings → Backups:** the recipient list (comma-separated emails) is now
an editable field saved straight to Settings, no `.env` edit or restart
needed — matching what the backend already supported. SMTP transport
details (`SMTP_HOST` etc.) still require `.env`, since those are genuinely
server secrets, not a business setting; the page now says so explicitly
instead of implying the whole thing needs `.env`.

**Note on "money spent":** the M-Pesa credential fields include
`initiator_name`/`initiator_password`, which is what Safaricom's B2C API
(sending money out) needs — the fields exist and are storable, but there's
still no actual outbound API client calling B2C anywhere in this codebase.
Storing the credentials is necessary but not sufficient for "money spent
is mirrored automatically" — that needs a real B2C integration built
against Safaricom's actual API next, same category of gap as the KCB
webhook payload shape (Phase 3): the shape is ready, the live connection
isn't.

**Verified:** this is the first frontend change in this whole conversion,
and unlike every backend phase, the frontend has no native dependencies —
`npm install` and `npx vite build` both ran for real in this sandbox and
succeeded cleanly, and `npx oxlint` came back with zero errors (three
pre-existing-pattern warnings, matching a convention already used
elsewhere in this same file). This is a stronger check than every backend
phase has had so far. The backend side (credential storage, encryption,
webhook auth precedence) was already covered by earlier verification —
nothing there changed in this pass.

---

# Phase 9: Reporting — the Inventory Management "Home Screen"

The payoff phase — no new schema, just querying what Phases 1–8 already
built. Extends the existing `reports` module (which was entirely POS-only:
`sales`/`sale_items`/`payments`, nothing about online orders) with five
endpoints that answer, directly, the exact questions asked at the start of
this whole conversion:

- `GET /api/reports/dashboard-overview?date=` — combined POS+online
  revenue for the day, cash actually collected (both channels), an
  order-status breakdown, unpaid parcels grouped by courier with capital
  tied up, current stock value, and a low-stock count (full detail stays
  at the existing `GET /api/inventory/low-stock` — not duplicated here).
  Answers: *how much did we sell today, how much cash should we have
  received, which orders are unpaid/partial/returned/cancelled, which
  courier has unpaid parcels, how much stock do we have, how much stock
  should I reorder.*
- `GET /api/reports/unpaid-parcels?courier=` — the row-level detail behind
  the dashboard's courier grouping.
- `GET /api/reports/profit-summary?from=&to=` — revenue, cost of goods
  sold, delivery fees, labor cost, business expenses, and net profit, all
  combining POS + online. Answers: *what is the cost of stock sold, what
  is the actual profit after product cost, delivery, advertising, salaries
  and other expenses.*
- `GET /api/reports/top-products-by-profit` / `top-staff-by-profit` —
  same question as the original `top-products` report, but by margin
  (revenue minus cost) instead of just units, and combining both sales
  channels. Answers: *which products and salespeople generate the most
  profit.*

**Scope of "labor cost" in profit-summary, stated plainly:** only
telesales retainer + commission is tracked anywhere in this app (built in
Phase 6) — there's no admin/manager salary tracking at all, so their pay
isn't in this number. It reuses `payroll.service.js`'s own calculation
(looped per active cashier, since each staff member's commission tier
depends on their own achievement percentage) rather than duplicating that
math, so it inherits the same commission-tier caveat flagged in the Phase
6 entry below.

**Verified the same way as every phase**: every new query run directly
against real SQLite with realistic seeded data (a POS sale, a paid online
order, an unpaid dispatched order, an expense entry, and clocked-in
attendance) and checked against hand-computed expected values — including
the more complex `UNION ALL` query behind `top-products-by-profit`, which
is the one query in this phase most likely to have a subtle bug if it were
just eyeballed. **Still needs `npm install && npm test` run for real** —
same network limitation as every prior phase.

## All nine phases from the original implementation plan are now done.

The system has gone from a pure point-of-sale app to one that also runs
the full online/COD order lifecycle, courier and payment reconciliation,
returns/RMA, telesales distribution and payroll, employee onboarding, and
dispute handling — with reporting that reflects all of it in one place.
What's *not* done, listed honestly rather than buried: the KCB/M-Pesa
integration is unverified against real credentials (Phase 3), the
commission tier numbers are an unconfirmed guess (Phase 6), employee
e-signature is admin-witnessed rather than self-service (Phase 7), and
nothing in this whole build has actually been run through `npm test` in a
real Node environment — every phase was verified by hand-simulating its
SQL against real SQLite, which is a solid check but not a substitute for
the real test suite actually executing.

---

# Phases 5–8: Telesales Distribution, Payroll, Onboarding, Disputes

Four phases in one pass, since they share real infrastructure — the
attendance/clock-in system Phase 5 needed for "logged in and present" is
the same one Phase 6's deductions and Phase 8's absence detection build on
top of, so it made more sense to build it once, well, than three times,
thinly.

## Phase 5 — Telesales equal distribution + 10:00 AM rule

**New:** `staff_attendance` (one row per staff per day — `clock_in_at`/
`clock_out_at`). `POST /api/attendance/{clock-in,clock-out}` (self only —
clocking someone else in isn't attendance, it's fraud), `GET
/api/attendance/{today,absences-today}` (admin/manager).

**Distribution** (`telesalesDistribution.service.js`): "logged in AND
marked present" — this app has no separate presence toggle, so a clock-in
IS presence. A new lead/order with no explicit `assigned_staff_id` auto-
assigns to whichever eligible (clocked-in, active, `cashier`-role) staff
member currently has the fewest open items — actual load-balancing, not
round-robin by turn order. An explicit `assigned_staff_id` always wins;
auto-assign only fills the gap.

**The 10 AM rule and absence reassignment are the same mechanism:**
anything still open and assigned to someone who never clocked in today
gets reassigned once the configured cutoff hour (default 10, in Settings
as `telesales_cutoff_hour`) passes — checked every 15 minutes by a new
`setInterval` in `server.js`, plus `POST /api/telesales/rebalance`
(admin-only) for on-demand runs. Also sweeps up anything left unassigned
regardless of time (no eligible staff existed yet when it was created) —
no reason to make an orphaned lead wait for 10 AM once someone becomes
available.

## Phase 6 — Staff attendance & payroll

**Deliberately a calculation engine, not a posted ledger or a disbursement
system** — there's no bank integration or payout-processing infra to build
against, and the actual requirement (visibility into what's owed, tracked
sales vs. achievement) doesn't need one. `GET /api/payroll/summary?
staff_id=&from=&to=` computes fresh every call from `staff_attendance` +
`orders`: daily retainer (KSh 300/day logged in), commission (per-unit
rate tiered by sales-achievement-vs-target, only counting
`dispatched_paid` orders — commission on money never actually collected
isn't commission), and attendance deductions (absence/late/missing-hours,
all rates configurable in Settings).

**⚠️ Commission tier numbers are a best guess, not a confirmed spec** — the
original requirements gave two different versions of this table before
landing on the one implemented (`commission_below_70_percent_kes`/
`commission_at_70_percent_kes`/`commission_at_80_percent_kes` in Settings),
and that version has below-70%-and-at-70% paying the identical rate, which
reads like a typo. This was flagged back in the very first gap-analysis
document and still hasn't been confirmed — do that before relying on a
real payroll run.

**Salary advances**: `requisitions` gains a `type` ('shop_operational'/
'salary_advance') and `amount`; approving a `salary_advance` requisition
auto-posts a `payroll_adjustments` row (event-based, unlike the
calculated deductions above) — this is what "automatically deducted from
salary" means at the data layer. `POST /api/payroll/loss-deduction` covers
employee-caused losses that never went through a requisition.

## Phase 7 — Employee onboarding & e-signature

**New, opt-in path**: `POST /api/employees/onboard` creates a new hire
`is_active = 0` / `onboarding_status = 'pending_documents'` — completely
separate from the existing `POST /api/staff` endpoint, which is untouched
and still creates an immediately-active account for a quick internal hire.
`POST /api/employees/:id/documents` (national_id/cv/contract) auto-
advances to `pending_signature` once all three are present; `POST
/api/employees/:id/sign-agreement` signs the current policy version
(`employee_policy_version`/`employee_policy_text` in Settings) and flips
both `onboarding_status` to `active` and `is_active` to `1` together.

**Honest limitation**: signing is admin-witnessed, not employee self-
service. `is_active = 0` blocks login entirely in this app's auth model
(checked at both login and every subsequent request), so a not-yet-
activated new hire has no way to log in and view/sign the policy
themselves. A real deployment probably wants a lightweight unauthenticated
onboarding-token flow for that — not built here.

## Phase 8 — Dispute management & absence automation

**Disputes** live directly on `orders` (`dispute_status`/`dispute_reason`/
`dispute_outcome`/etc.) rather than a separate table — a dispute is
fundamentally about one order, and reusing the order's own audit trail
(`order_status_history`) for the open/resolve events was simpler than a
parallel one. `POST /api/orders/:id/dispute` (any staff can raise one),
`POST /api/orders/:id/dispute/resolve` (manager/admin — issuing a refund
call is a management decision) with outcome refund/redelivered/closed.

**Absence automation reuses Phase 5's rebalance sweep** — an absent staff
member (no clock-in today) having their open leads/orders reassigned IS
the same "assigned to someone not clocked in" condition the 10 AM rule
already handles; building a second mechanism would have just been the
same logic twice. `GET /api/attendance/absences-today` is the management-
visible list (again, no real notification channel exists — same honest
pattern as Phases 3 and 4).

## Verification

Same approach as every phase so far: full `schema.sql` executed against
real SQLite, the additive migration path simulated against a hand-built
"Phase 4 already applied" database (`users`, `requisitions`, `orders` all
missing the new columns beforehand — confirmed existing rows migrate
correctly and new CHECK constraints are actually enforced afterward), and
every core flow across all four phases — attendance-driven eligibility,
auto-assignment, the payroll commission/deduction formulas (including the
julianday-based hour math, checked against real SQLite's floating-point
behavior), onboarding's full document→signature→activation sequence, and
dispute open/resolve — run step-by-step as raw SQL matching every expected
value. **Still needs `npm install && npm test` run for real** in an
environment that can build `better-sqlite3` — same network limitation as
every prior phase.

## What's left from the original plan

Phase 9 (reporting dashboard rebuild) is the only phase not yet started —
and per the original plan, it's mostly a matter of querying what Phases
1–8 already built (stock states, unpaid/dispatched breakdowns, profit
after costs, staff/product performance) rather than new data-model work.

---

# Phase 4: Return Reason Codes & Owner Write-Off/Disposal Decision

Builds on Phase 1's return/inspection flow (already had the
`returned_in_transit → returned_awaiting_inspection → returned_resellable |
returned_damaged` state machine and manager-only inspection gate — this
phase doesn't touch that). Adds the two pieces the RMA requirements
specifically called out that weren't built yet: structured return reason
codes, and a resolvable owner decision for damaged stock.

**New on `orders`:** `return_reason` ('rejected'/'damaged'/'wrong_item') —
captured on `POST /api/orders/:id/returned-in-transit` via an optional
`reason_code` field (optional, not required — keeps every existing Phase
1–3 call to this endpoint working unchanged); `owner_notified_at`,
`owner_decision` ('write_off'/'dispose'), `owner_decision_by`,
`owner_decision_at`, `owner_decision_notes`.

**"Owner gets notified" is a queryable list, not a push notification:**
there's no SMS/email/WhatsApp send anywhere in this app yet (same honest
gap as the KCB integration in Phase 3), so rather than fake a notification
that doesn't go anywhere, a 'damaged' inspection result sets
`owner_notified_at` and the order becomes visible via the new `GET
/api/orders/pending-owner-decision` — that visibility IS the real,
buildable version of the requirement until an actual notification channel
exists.

**New endpoint:** `POST /api/orders/:id/owner-decision` (admin-only — this
app has no separate "owner" role, so admin stands in for it, same as
`inspect` stands in for "Operations Manager verifies returns"). Requires
the order to be `returned_damaged` with no existing decision; rejects a
second decision on an already-resolved order.

**New tests:** `tests/ordersPhase4.test.js` — reason code capture (valid,
invalid, and omitted), `owner_notified_at` only firing on a damaged (not
good) inspection, the pending-decision queue gaining and then losing an
order as it's decided, and rejecting a decision on an order that's either
already decided or was never actually inspected as damaged.

**Verified the same way as Phases 1–3** (see those entries for why): full
`schema.sql` executed against real SQLite, the additive migration path
simulated against a hand-built "Phase 3 already applied" database
(confirmed a pre-existing damaged order correctly surfaces in the pending
queue after migration, and the new CHECK constraints are enforced), and
the full return → inspect-damaged → pending-queue → decide flow run
step-by-step as raw SQL matching every expected value. **Still needs `npm
install && npm test` run for real** in an environment that can build
`better-sqlite3` — same network limitation as noted in the Phase 1 entry.

**Remaining phases from the plan, not yet started:** Phase 5 (telesales
equal-distribution + 10am cutoff rule), Phase 6 (staff attendance/payroll —
needs the commission-tier numbers confirmed first, see the original gap
analysis), Phase 7 (employee onboarding/e-signature), Phase 8 (disputes +
absence automation), Phase 9 (reporting rebuild — mostly falls out of
Phases 1–4 already being in place).

---

# Phase 3: Payment Reconciliation (KCB/M-Pesa Webhooks, Product Codes)

Builds on Phases 1–2. Adds the payment-matching layer the WhatsApp log
specifically asked for: solving "two Marthas, same amount" and "spouse pays
on the customer's behalf" by matching on a generated per-order code rather
than name+amount.

**New `product_code`** on `orders`: deterministic (`UT` + zero-padded order
id), generated the moment an order is created — matches "once a product has
been keyed in as converted... it generates a code" — and given to the
customer to quote when paying. Backfilled for any pre-existing order on
migration so nothing already in the system is unreachable by this scheme.

**New `payment_notifications` table**: the raw feed of every incoming
payment webhook, kept separate from `payment_records` (which stays the
confirmed ledger). This is what makes "flag unmatched payments for
follow-up" possible — a payment that can't be auto-matched is never
dropped, just recorded as `unmatched` for a human to resolve.

**New endpoints:**
- `POST /api/integrations/payments/{kcb,mpesa}/webhook` — inbound, no JWT
  (external systems call this), authenticated instead by a shared secret
  in `PAYMENT_WEBHOOK_SECRET` checked against an `X-Webhook-Secret` header.
  Idempotent — the same `external_reference` delivered twice (webhook
  retries are normal) only applies the payment once.
- `GET /api/payment-reconciliation/unmatched`, `POST
  /api/payment-reconciliation/:id/match` (staff resolves manually — the
  "spouse pays" case), `POST /api/payment-reconciliation/:id/ignore` (e.g.
  a provider's test transaction).

**Matching logic:** extracts a `UT######` code from the payment narrative
or account reference, looks up the order, and only auto-applies the
payment if that order is actually in a payable state
(`dispatched_unpaid`/`dispatched_partial`). A code that matches an order
that's `awaiting_dispatch`, already fully paid, cancelled, or returned is
deliberately left `unmatched` rather than silently misapplied — a human
decides what a payment against, say, a cancelled order should mean.

**No real KCB/M-Pesa credentials or API docs exist yet** — same blocker
flagged for Shopify sync in the original requirements gathering ("for this,
i need to have access.. or you can share devs contacts"). What's built here
is the *shape* of the integration — webhook receiver, matching logic, audit
trail, manual-resolution UI-ready endpoints — normalized around a
reasonable guess at what a payment notification looks like
(`method`/`amount`/`external_reference`/`narrative`/`payer_name`). The
actual field names, auth scheme, and delivery mechanism (push webhook vs.
polling) will very likely need small adjustments once real KCB API access
exists — expect a tweak to `validation/paymentReconciliation.schema.js` and
`middleware/webhookAuth.js`, not a rewrite. **No outbound KCB API calls are
made anywhere** (e.g. STK-push-style "request payment" initiation) — there's
no credential or endpoint to call, and nothing in the requirements asked
for initiating payments, only matching ones that arrive.

**Verified the same way as Phases 1–2** (see those entries for why): full
`schema.sql` executed against real SQLite, the additive migration path
simulated against a hand-built "Phase 2 already applied" database
(confirmed `product_code` backfills deterministically with no collisions,
and the unique partial index builds cleanly afterward), and the full
ingest → match → idempotent-redelivery → unmatched → manual-match flow run
step-by-step as raw SQL matching every expected value from
`tests/paymentReconciliation.test.js`. **Still needs `npm install && npm
test` run for real** in an environment that can build `better-sqlite3` —
same network limitation as noted in the Phase 1 entry.

**Deferred to Phase 4** (unchanged from the plan): the RMA/returns
workflow (reason codes, manager write-off decisions on damaged stock) —
inspection good/bad already works from Phase 1, this phase doesn't touch it.

---

# Phase 2: Courier, Delivery Zone/Fee & COD Confirmation Gate

Builds on Phase 1's order lifecycle. Adds everything the plan scoped for
Phase 2: courier assignment, delivery-zone-driven fee tiering, and the
mandatory COD confirmation gate before dispatch.

**Extended `orders`:** `payment_type` ('cod'/'prepaid'/'g4s_pickup_pay'),
`courier_type` ('boda'/'g4s'), `delivery_zone` ('nairobi'/'outside'),
`delivery_fee`, `cod_confirmed_at`/`cod_confirmed_by`,
`cod_confirmation_expires_at`.

**Auto-computed at order creation** (`utils/delivery.js`): delivery zone
from the customer's city (substring match on "nairobi"), courier
auto-suggested from zone (boda for Nairobi, G4S otherwise — overridable via
the new `POST /api/orders/:id/courier`), and delivery fee tiered per
Settings (flat KSh 300 under KSh 5,000, 5% above — both numbers configurable
in Settings, not hardcoded).

**COD Confirmation Gate:** `POST /api/orders/:id/confirm-cod` — required
before `dispatch()` will proceed on a `cod` order (`prepaid`/`g4s_pickup_pay`
orders skip the gate entirely). The confirmation window (default 120
minutes, configurable) starts at order creation; an unconfirmed order past
its window is auto-cancelled — checked lazily on both `confirm-cod` and
`dispatch` (so it's never possible to confirm or dispatch a stale order),
and swept proactively every 15 minutes by a new `setInterval` in
`server.js` (same pattern as the existing backup/reconciliation jobs), plus
an admin-triggerable `POST /api/orders/expire-unconfirmed` for on-demand runs.

**New tests:** `tests/ordersPhase2.test.js` — zone/courier/fee computation,
courier override, the confirmation gate blocking then allowing dispatch,
prepaid orders skipping the gate, and the auto-expiry sweep (using a
temporarily-shrunk confirmation window rather than waiting on the real one).

**Verified the same way as Phase 1** (see that entry below for why): full
`schema.sql` executed against real SQLite, the additive migration path
simulated against a hand-built "Phase 1 already applied" database (confirmed
the new CHECK constraints are actually enforced after an `ALTER TABLE ADD
COLUMN`, not just accepted syntactically), and the full create → block →
confirm → dispatch → expire-sweep flow run step-by-step as raw SQL matching
every expected value. **Still needs `npm install && npm test` run for real**
in an environment that can build `better-sqlite3` — same network limitation
as noted in the Phase 1 entry.

**Deferred to Phase 3** (unchanged from the plan): payments are still
recorded manually via `POST /api/orders/:id/payments` — no KCB/M-Pesa
auto-matching by product code yet.

---

# Phase 1: POS → Inventory Management Conversion — Online/COD Order Lifecycle

Implements Phase 1 of the plan to convert this from a point-of-sale system
into an inventory management system: the online/COD order state machine
that everything else (courier, payment reconciliation, returns, telesales
distribution) builds on top of. POS Terminal checkout is completely
untouched — `sales` still works exactly as before; `orders` is a new,
separate table for the online lifecycle.

**New tables:** `orders`, `order_items`, `order_status_history`.
**Extended:** `customers` (phone-based dedup, city, risk flag, prepay flag),
`payment_records` (new `order_id` column alongside the existing `sale_id`),
`inventory_movements` (new `dispatch`/`return_resellable` reasons, new
`reference_type` column so both sales and orders post to the same ledger).

**State machine:** `awaiting_dispatch → dispatched_unpaid → dispatched_partial
→ dispatched_paid`, with `returned_in_transit → returned_awaiting_inspection
→ returned_resellable | returned_damaged` branching off at any dispatched
state, plus `cancelled` from `awaiting_dispatch`. Stock is deducted on the
one transition into `dispatched_unpaid` (dispatch) and reinstated on the
one transition into `returned_resellable` (never `returned_damaged`) —
matches the "stock deduction happens ONLY when Dispatched" / "damaged
blocked from resale" requirements exactly.

**New endpoints:** `POST/GET /api/orders`, `GET /api/orders/:id`,
`POST /api/orders/:id/{merge-items,dispatch,payments,returned-in-transit,
returned-awaiting-inspection,inspect,cancel}`. `inspect` is manager/admin
only (RMA requirement: manager approval before resale).

**Duplicate-order prevention** (§1): a new order is rejected with 409 +
the existing order's id if the same phone already has an order in
`awaiting_dispatch`/`dispatched_unpaid`/`dispatched_partial`. Deliberately
does NOT include the `returned_*` states — a customer whose parcel is on
its way back needs to be able to place a new order (see risk flag below),
not be permanently blocked.

**Customer risk flagging** (§3): re-evaluated every time an order moves to
`returned_in_transit`. 1+ returns → `watch`, 3+ → `high` + `prepay_required`.
Nothing is enforced from the flag yet (no phase actually blocks COD based
on it) — it's surfaced on the customer record for telesales to act on
manually until Phase 5 (telesales rules) wires it in automatically.

**Known gaps, intentionally deferred to later phases (see the implementation
plan doc):** no courier/delivery-zone/fee fields yet (Phase 2), payments are
recorded manually — no KCB/M-Pesa auto-matching yet (Phase 3), no owner
write-off workflow for `returned_damaged` stock (mentioned in Phase 4),
dispatch only supports one parcel per order — no partial/split dispatch
across multiple couriers yet.

**Testing note:** this sandbox's network egress doesn't allow downloading
Node headers for `better-sqlite3`'s native build (blocked domain:
`nodejs.org`), so `npm install` / `npm test` could not actually be run
end-to-end here. Every SQL statement in the new service/migration code was
instead verified by hand: the full `schema.sql` was executed against real
SQLite (fresh-install path), and the additive migration path was simulated
against a hand-built "old" database matching the pre-Phase-1 shape,
including the `inventory_movements` and `customers` table rebuilds/backfills
(this caught and fixed one real bug — `ALTER TABLE ADD COLUMN` rejects a
non-constant `datetime('now')` default, unlike `CREATE TABLE`). The full
order lifecycle (create → dispatch → partial/full payment → return →
inspect good/damaged, plus the risk-flag counter) was also run step-by-step
as raw SQL against an in-memory database and matched expectations at every
step. **Please run `cd backend && npm install && npm test` yourself before
deploying** — `tests/orders.test.js` covers this phase's happy paths and
edge cases through the actual HTTP API, which is a stronger check than the
manual SQL walkthrough above, but it still needs to actually run once in an
environment that can build `better-sqlite3`.

---

# Settings, Multi-Channel Sales & Detailed Analytics — Changelog

## Audit remediation — checkpoint (P0 complete, P1 in progress)

Working through `urban-trends-pos-v4-consolidated-recommendations.md`
(an external audit) in priority order. This is a **mid-round checkpoint**,
not the finished pass — see the end of this entry for what's still ahead.

**P0 — complete:**
1. Refresh token moved out of `localStorage` into an httpOnly,
   `SameSite=Strict` cookie scoped to `/api/auth` (`Secure` in production).
   `POST /api/auth/refresh` and `/logout` now read the cookie instead of a
   request-body token; the frontend (`api/client.js`) uses
   `withCredentials: true` instead. Verified with real cookie-jar curl
   requests against a live server, not just in-process tests.
2. `react-router-dom` bumped `7.18.1` → `7.18.3` — confirmed via `npm audit`
   this is a genuine non-breaking patch fix for the CSRF advisory, not the
   "must migrate to v8" some stale discussion threads suggested. Also ran
   `npm audit fix` for two more high-severity transitives it caught
   (`browserslist`, `nanoid`). **Frontend: 0 vulnerabilities.**
3. CI added (`.github/workflows/ci.yml`) — backend test+audit, frontend
   build/lint/audit, on every push/PR.

Found along the way: the backend's `qs`/`body-parser` moderate advisories
don't actually clear with `npm audit fix` — the real upstream fix needs an
Express 5 migration. Added a targeted `"overrides": {"qs": "^6.16.0"}` in
`package.json` instead, forcing the patched `qs` everywhere in the tree
without that migration. **Backend: 0 vulnerabilities.**

**P1 — in progress:**
- ✅ Startup validation (`utils/validateEnv.js`) — refuses to start in
  production with a missing/placeholder `JWT_SECRET`/`ENCRYPTION_KEY`, the
  two secrets being identical, or a missing `CORS_ORIGIN`. Warns-but-
  continues in development. Tested all four cases directly.
- ✅ `morgan` uninstalled (confirmed genuinely unused first).
- ✅ Zod adopted for `POST /api/sales`, `POST /api/payments`,
  `POST`/`PATCH /api/expenses` (`middleware/validate.js` +
  `validation/*.schema.js`) — replaced hand-written `if (!x) throw` chains.
  11 new tests prove it rejects malformed input; DB-state checks (category/
  sale existence) stayed in the controllers, since zod only knows shape.
- ✅ Extracted all inline `db.prepare()` calls out of `users.controller.js`
  and `leads.controller.js` into `users.service.js`/`leads.service.js` —
  both controllers are now thin HTTP shims, consistent with the rest of the
  codebase. Both had **zero test coverage** before this; added 14 tests
  (7 each) covering the state machine, duplicate detection, role-scoping,
  and the security-critical "password change revokes tokens, plain edit
  doesn't" distinction.
- ✅ Extracted the 5x-duplicated `StatCard` component
  (`components/StatCard.jsx`, one `size` prop covers the one real
  difference) and `Settings.jsx`'s `SectionCard`/`Field`/`inputCls`
  (`components/SettingsUI.jsx`) into shared components.

**Test suite: 55 tests, all passing** (was 26 at the last full delivery).

**Still ahead in P1:** shared `TabBar` extraction (Catalog/Finance/Sales
History currently duplicate the same tab-button markup), route-based code
splitting, deduplicating the Shopify/WooCommerce sync logic, and replacing
21 native `alert()`/`confirm()`/`prompt()` calls with a proper toast/dialog
system. **P2 and P3 not started.**

---

## Commissioned round: loose ends, all proposals, and currency unification

Everything previously proposed-but-not-built, plus a new email backup
service. In rough order of how risky each change was:

**Tied up from the tax-removal round:**
- `products.tax_rate` and the unused "Default tax rate" setting are gone
  from the API and UI (column stays in the DB for historical `sale_items`
  compatibility, just genuinely inert now).

**Automated tests** — `vitest` + `supertest`, isolated temp SQLite DB per
run. 29 tests covering auth/token revocation, checkout, requisition
approval, inventory reconciliation, cash sessions, refresh tokens, and
currency integrity. Built *first*, specifically to de-risk the currency
migration below — and it earned its keep twice over (see next two items).

**Structured logging** — `winston` replacing `morgan`/raw `console.log`
throughout. JSON to `data/logs/app.log` + `error.log`.

**Rate limiting extended** to a generous baseline across all of `/api`
(600/5min), on top of the existing tighter ones. The auth limiter is now
scoped to just `/login`/`/pin-login` — refresh/logout require already
possessing an unguessable token, so rate-limiting those as tightly only
hurts a multi-register shop sharing one IP.

**Inventory reconciliation** (`GET`/`POST /api/inventory/reconcile`,
admin/manager to check, admin to fix) — compares the cached
`inventory.quantity` against `SUM(inventory_movements)`, the ledger built
by every legitimate write path. Caught a real bug in the first version
here: the fix had the correction's sign backwards, so "fixing" drift
silently introduced *new* drift instead of resolving it — caught by the
test suite before shipping, not after. Also fixed the one genuine gap that
caused false positives: `seed.js` wasn't logging initial stock as a
movement. A daily detect-only check (no auto-fix) logs a warning if
anything drifts.

**`cash_sessions` — finished, not dropped.** Open/close shift endpoints,
expected-vs-actual cash reconciliation at close (only counts the *cash*
portion of a split payment, via the existing `payments` table — tested
explicitly), a shift widget on the POS terminal (optional, doesn't gate
checkout), and a "Cash sessions" tab under Finance for oversight. Also hit
a real mistake building this: built an entire duplicate `sale_payments`
table before realizing `payments` already did that job — reverted before
it shipped.

**Refresh token flow** — access tokens are now short-lived (15 min,
`ACCESS_TOKEN_EXPIRES_IN`); staying logged in goes through a new
`refresh_tokens` table instead (hashed, never stored raw; rotated on every
use — reusing an old one is rejected, so a stolen-then-reused token breaks
the legitimate session too, a visible sign something's wrong). Deactivation
and password changes now revoke outstanding refresh tokens, not just
access tokens. Frontend (`api/client.js`) silently refreshes and retries
once on a 401 instead of bouncing to the login screen; concurrent 401s
share one in-flight refresh call. Verified with a real expired-token
integration test, not just unit-level rotation checks.

**Email backup service** — a second, independent copy of the backup story:
local backups (`data/backups/`, every 6h, 7-day retention, unchanged)
protect against a corrupted database file; emailing a copy off-machine
every 24h (separate schedule from the local one, `nodemailer`, configured
via `SMTP_*`/`BACKUP_EMAIL_TO` in `.env`) protects against losing the whole
machine. Optional — unset `SMTP_HOST` and it's exactly as if this didn't
exist. Manual trigger and status visible in Settings.

**Currency unified to integer cents** (`REAL` → `INTEGER` across
`products`, `sales`, `sale_items`, `payments`, `cash_sessions`,
`shopify_staging_products` — `expenses`/`payment_records` were already
cents, unchanged). This was sequenced last deliberately — highest risk of
silently corrupting money math, done only once a real test suite existed
as a safety net.
- **Migration** (`migrate.js`): rather than hand-transcribing each table's
  full DDL (real risk of a transcription slip on a table this important),
  pulls the table's actual `CREATE TABLE` text from `sqlite_master` and
  surgically swaps `REAL`→`INTEGER` only for the named currency columns —
  every `CHECK`/`DEFAULT`/`FK`/`UNIQUE` clause preserved exactly as-is.
  Idempotent (skips a table already converted), and verified against a
  simulated pre-migration database seeded with classic float-precision
  landmines (19.99, 0.10, 0.30) — every value converted to the exact
  correct cent, zero foreign-key violations.
- **API contract**: unchanged in shape, changed in units — money fields
  are now raw integer cents over the wire, same convention
  `expenses`/`payment_records` already used (frontend divides/multiplies
  by 100 at the display/input boundary). No new conversion layer invented;
  followed the pattern already proven in `Expenses.jsx`/`Payments.jsx`.
- **Business logic**: `sales.service.js`'s payment-matching check is now
  exact integer equality instead of a 1-cent float-fuzz tolerance — a real
  correctness improvement, since that tolerance only existed to paper over
  float drift that can no longer happen.
- **Sync paths updated**: Shopify/WooCommerce product sync and order sync
  (`shopify.service.js`, `wooProducts.service.js`, `salesSync.service.js`)
  now convert each platform's decimal price strings to cents at the point
  they're parsed.
- **Verified**, not just written: a dedicated test confirms the affected
  columns are genuinely `INTEGER` storage class (not just integer-valued
  floats), that a 19.99-style price round-trips through create→checkout
  exactly, and that `SUM()` over ten intentionally odd-cent line items in
  SQL matches the exact expected total with zero drift — the actual
  scenario (aggregating many rows) the old `REAL` columns were vulnerable to.

---

## Tax removed from local checkout

Local POS checkout no longer adds tax to the charged total —
`sales.service.js` now charges exactly the sum of line prices (minus
discount), with no tax added on top. Verified with a live checkout: paying
a product's exact price now succeeds; paying the old tax-inclusive amount
(price × 1 + tax_rate) is correctly rejected as a payment mismatch, so this
isn't just hidden from the display — the amount actually charged changed.
`useCartStore.js` and `POSTerminal.jsx` updated to match (no "Tax" line,
cart total is just the subtotal), so what the cashier sees is what actually
gets charged.

**What was deliberately left alone**, since the request was specifically
about checkout, not the concept of tax entirely:
- `products.tax_rate` still exists as a column and is still editable on the
  product form (Catalog → Products) — it's just no longer read at checkout.
  `sale_items.tax_rate` is now always recorded as `0` on new local sales
  (rather than the product's rate) so a sale record never implies tax was
  charged when it wasn't.
- The "Default tax rate" field in Settings is untouched — it was already
  unused by checkout before this change (products defaulted to a hardcoded
  0.16 in the product form, not this setting), so nothing behavior-wise
  changed here.
- Orders synced in from Shopify/WooCommerce (`salesSync.service.js`) still
  record whatever tax that platform actually charged its customer — that's
  real tax collected on a channel outside this POS, not something this app
  is adding, so removing it there would misreport actual channel revenue.

If the `tax_rate` field/UI on products and the unused Settings field should
go too, that's a separate follow-up — left in place for now since removing
the checkout charge was the specific ask.

---

## Sidebar consolidation, editable sync, auto-SKU, and automatic backups

1. **Sidebar merged from 14 items to 11.** Products, Categories, and
   Inventory are now one page (`/catalog`, `Catalog.jsx`) with Products/
   Categories as tabs; the old Inventory page's one real function beyond
   what Products already showed — stock adjustment through the audited
   `inventory_movements` ledger — is now a row action on Products itself
   ("Adjust stock"), not a separate page. Payments and Expenses are
   similarly merged into `/finance` (`Finance.jsx`), same tab pattern.
   **The underlying data model is unchanged** — `products` and `inventory`
   are still separate tables, `payments`/`payment_records` and `expenses`
   are still separate tables. This was deliberately a UI-only merge:
   `inventory` is scoped per-store (`UNIQUE(product_id, store_id)`)
   specifically so a second physical location is a data-entry task, not a
   schema migration — collapsing it into `products` would have undone
   that. Old routes (`/products`, `/categories`, `/inventory`, `/expenses`,
   `/payments`) redirect to the merged pages rather than 404ing.

2. **Shopify/WooCommerce sync review is now editable before approval.**
   SKU is an editable text field per row (auto-saves via a new `PATCH
   /api/integrations/shopify/staging/:id`) instead of a blocking
   requirement — if left blank, approving auto-assigns the next sequential
   SKU (`1`, `2`, `3`, ...) via a new counter in `settings`. A category is
   now the only thing required before approving a genuinely new product;
   rows that match an existing product need nothing extra. A manually-
   entered SKU or category now survives a re-sync instead of being
   silently overwritten by the next pull (the upsert only lets Shopify/
   WooCommerce's own SKU win if it actually has one; category is never
   touched by a sync at all).

3. **Automatic backups every 6 hours.** New `backup.service.js` uses
   `better-sqlite3`'s native online-backup API (safe under WAL — a raw
   file copy can miss data still sitting in the `-wal` file), 7-day
   retention (28 backups), scheduled from `server.js`. Admin-only `GET/POST
   /api/backups` for visibility and on-demand runs, surfaced in Settings.
   This protects against a corrupted database file on this machine — it is
   **not** off-machine disaster recovery; `backend/data/backups/` still
   needs to be copied elsewhere on its own schedule for that.

4. **`SETUP.md`** — a standalone first-time setup walkthrough, written from
   what actually went wrong during a real first setup this round (missing
   `.env`, migrate-before-seed ordering, the Node 24.19/`better-sqlite3`
   native crash and its fix, npm's install-script approval gate).

---

## Security hardening round

Five changes, addressing items flagged in `AUDIT.md` §2 (architecture-level
risks) and §3 (recommended additions):

1. **Connected-store secrets encrypted at rest** (`utils/crypto.js`,
   AES-256-GCM). `income_sources.api_secret`/`.access_token`/`.consumer_key`/
   `.consumer_secret` are now ciphertext in the database — previously plain
   `TEXT`, readable by anyone with filesystem access to `data/urban_trends.db`
   or a backup of it. Encrypted/decrypted transparently at the single choke
   point (`incomeSources.service.js`'s `getRaw`/`create`/`update`, plus the
   OAuth token-refresh write in `shopifyOAuth.service.js`) — no changes
   needed anywhere else that reads a `source` object. Requires a new
   `ENCRYPTION_KEY` in `.env` (added to `.env.example`) — any long random
   string, same as `JWT_SECRET`, but use a **different** value. Rows saved
   before this upgrade are read as plain values (no crash) and get encrypted
   automatically the next time that income source is saved.

2. **Outstanding JWTs now revoke immediately on password change or
   deactivation**, instead of quietly staying valid until their natural 8h
   expiry. New `users.token_version` column (backfilled via `migrate.js` on
   existing databases), embedded in the JWT at login, checked against the
   current DB value — alongside `is_active` — on every authenticated
   request in `middleware/auth.js`. Bumped on password change, admin
   password reset, and deactivation (`users.controller.js`). Verified end-
   to-end: deactivating a logged-in user's account rejects their still-
   unexpired token on the very next request.

3. **CORS fails closed in production.** An unset `CORS_ORIGIN` previously
   fell back to allowing every origin, silently, in every environment. Now
   that fallback only applies when `NODE_ENV` isn't `production` — in
   production, an unset `CORS_ORIGIN` logs why and rejects every
   cross-origin browser request instead. Non-browser requests (curl,
   server-to-server, health checks — anything with no `Origin` header) are
   unaffected either way.

4. **Demo credentials no longer shown in production builds.** `Login.jsx`'s
   `admin@urbantrends.com / ChangeMe123!` hint is now gated behind
   `import.meta.env.DEV` — still visible in local dev, stripped from
   `vite build` output.

5. **Rate limiting extended past `/api/auth`.** Checkout (`POST
   /api/sales`, 120 requests / 5 min) and the income-source routes that make
   outbound third-party calls (`connect`, `test`, `sync-products`,
   `sync-sales` — 20 requests / 15 min) are now limited. Plain CRUD on
   income sources and every other read endpoint is unaffected — they don't
   call out to a third party, so they're left as-is.

**Not changed in this round** (still open, see `AUDIT.md` for the full
list): no automated tests, no inventory reconciliation job, currency
representation still split between `REAL`/`INTEGER`, no refresh-token flow
(this round closes the *revocation* gap but access tokens are still
long-lived), `cash_sessions` still unfinished.

---

## Update: Shopify connection simplified to Client ID + Secret only


Five changes, addressing items flagged in `AUDIT.md` §2 (architecture-level
risks) and §3 (recommended additions):

1. **Connected-store secrets encrypted at rest** (`utils/crypto.js`,
   AES-256-GCM). `income_sources.api_secret`/`.access_token`/`.consumer_key`/
   `.consumer_secret` are now ciphertext in the database — previously plain
   `TEXT`, readable by anyone with filesystem access to `data/urban_trends.db`
   or a backup of it. Encrypted/decrypted transparently at the single choke
   point (`incomeSources.service.js`'s `getRaw`/`create`/`update`, plus the
   OAuth token-refresh write in `shopifyOAuth.service.js`) — no changes
   needed anywhere else that reads a `source` object. Requires a new
   `ENCRYPTION_KEY` in `.env` (added to `.env.example`) — any long random
   string, same as `JWT_SECRET`, but use a **different** value. Rows saved
   before this upgrade are read as plain values (no crash) and get encrypted
   automatically the next time that income source is saved.

2. **Outstanding JWTs now revoke immediately on password change or
   deactivation**, instead of quietly staying valid until their natural 8h
   expiry. New `users.token_version` column (backfilled via `migrate.js` on
   existing databases), embedded in the JWT at login, checked against the
   current DB value — alongside `is_active` — on every authenticated
   request in `middleware/auth.js`. Bumped on password change, admin
   password reset, and deactivation (`users.controller.js`). Verified end-
   to-end: deactivating a logged-in user's account rejects their still-
   unexpired token on the very next request.

3. **CORS fails closed in production.** An unset `CORS_ORIGIN` previously
   fell back to allowing every origin, silently, in every environment. Now
   that fallback only applies when `NODE_ENV` isn't `production` — in
   production, an unset `CORS_ORIGIN` logs why and rejects every
   cross-origin browser request instead. Non-browser requests (curl,
   server-to-server, health checks — anything with no `Origin` header) are
   unaffected either way.

4. **Demo credentials no longer shown in production builds.** `Login.jsx`'s
   `admin@urbantrends.com / ChangeMe123!` hint is now gated behind
   `import.meta.env.DEV` — still visible in local dev, stripped from
   `vite build` output.

5. **Rate limiting extended past `/api/auth`.** Checkout (`POST
   /api/sales`, 120 requests / 5 min) and the income-source routes that make
   outbound third-party calls (`connect`, `test`, `sync-products`,
   `sync-sales` — 20 requests / 15 min) are now limited. Plain CRUD on
   income sources and every other read endpoint is unaffected — they don't
   call out to a third party, so they're left as-is.

**Not changed in this round** (still open, see `AUDIT.md` for the full
list): no automated tests, no inventory reconciliation job, currency
representation still split between `REAL`/`INTEGER`, no refresh-token flow
(this round closes the *revocation* gap but access tokens are still
long-lived), `cash_sessions` still unfinished.

---

## Update: Shopify connection simplified to Client ID + Secret only

The Shopify connection flow now uses the **client credentials grant**
instead of the authorization-code/browser-redirect flow — Shopify's own
docs call this out as the right choice for "apps developed by your own
organization and installed in stores that you own," which is exactly this
setup (an internal POS talking to its own store), as opposed to a public
app installed by many unrelated merchants.

What changed:
- **Settings → Income sources** now only asks for shop domain, Client ID,
  and Client secret for a Shopify source — no "Admin API access token" field,
  no "Connect via OAuth" browser redirect.
- A single **Connect** button does a server-to-server exchange
  (`POST /admin/oauth/access_token` with `grant_type=client_credentials`) —
  no callback URL, no `BACKEND_PUBLIC_URL`/`FRONTEND_PUBLIC_URL` needed.
- These tokens expire every 24 hours. `shopifyOAuth.service.js` now
  auto-refreshes before every sync/test call (`ensureFreshToken`) — this is
  invisible day to day, but means the previous `oauth_scopes` field can now
  legitimately go stale between refreshes; Settings always shows what the
  *last* successful exchange actually granted.
- The old `/shopify/oauth/start` and `/callback` routes are gone entirely.
- Also fixed along the way: the token exchange now sends
  `application/x-www-form-urlencoded` as Shopify's spec requires (was
  sending JSON — Shopify tolerated it, but it was wrong), and a bug where a
  failed/empty scope grant was silently masked by falling back to display
  the originally *requested* scopes instead of what Shopify actually
  returned — this was actively hiding the exact class of misconfiguration
  (Dev Dashboard app not granted the needed Admin API scopes) that causes
  "Invalid API key or access token" errors after an apparently-successful
  connection.

---



Four things added: a **Settings page** (business config + Shopify/WooCommerce
connections), **multi-channel sales tracking** (Sales History now shows
whether a sale happened in the local store or on a connected online store,
and which one), support for **connecting any number of additional Shopify or
WooCommerce stores** as income sources, and **much more detailed analytics**
on the Dashboard (revenue by channel, daily trend chart, payment method mix,
top products per channel).

## Before you run this

Unlike the previous round of changes, this one **does** include a real
migration path — `backend/src/db/migrate.js` now backfills the new columns
(`sales.source_type`, `sales.income_source_id`, etc.) onto an existing
database with `ALTER TABLE`, instead of requiring you to delete `data/`.
Just run:

```
cd backend && npm run migrate
```

Deleting `data/` and starting fresh still works too, if you'd rather.

## Shopify changed how apps are created (this affects you)

As of **Jan 1, 2026**, Shopify retired the old flow of creating a custom app
straight in Admin → Settings → Apps → Develop apps and copying its Admin API
token. New apps are created in the **Shopify Dev Dashboard** and get their
Admin API access token through **OAuth**, the same way a public app does.

This is handled two ways in Settings → Income sources:
- **New setup**: enter the shop domain + the API key/secret from your Dev
  Dashboard app, then click **"Connect via OAuth"**. That's a real browser
  redirect to Shopify and back (`GET /api/income-sources/:id/shopify/oauth/start`
  → Shopify → `/callback`), not a fetch call — Shopify needs the actual tab.
- **Existing/legacy setup**: if you already have a working Admin API token
  from an app created before the cutover, just paste it into the "Admin API
  access token" field and skip OAuth entirely. The original `.env`-based
  `SHOPIFY_SHOP`/`SHOPIFY_ACCESS_TOKEN` single-store setup still works
  unchanged too — it's now just one option among several income sources
  instead of the only one.

## Decisions made during this round

- **Online sales never touch local inventory.** Shopify/WooCommerce already
  manage their own stock; pulling their orders in and also decrementing
  local inventory would double-count. Sales sync is purely for visibility
  and analytics — it reads orders, never writes back, and never adjusts
  `inventory`.
- **Unmatched SKUs never get silently dropped.** If an online order line
  item doesn't match any local product by SKU, a minimal placeholder
  product is auto-created (flagged in its description) so the sale still
  shows up correctly in Sales History and analytics instead of vanishing.
- **Each income source gets its own virtual "store"** (reusing the existing
  `stores` table) so `sales.store_id` stays meaningful for online orders too,
  and existing store-scoped queries don't need special-casing.
- **Sales History defaults to the cashier's own store**, same as before —
  online channels only appear when explicitly requesting "all channels"
  (`?includeAllChannels=1`), which is what the updated Sales History page
  does, since online orders don't belong to any one cashier's shift.
- **Voiding is local-only.** A void restores local stock, which doesn't
  apply to a Shopify/WooCommerce order — refunds/cancellations for those
  belong on the platform itself, so the Void button is hidden for
  non-local sales.
- **Secrets never round-trip to the browser.** The income sources API only
  ever reports `has_access_token: true/false`, never the token/secret
  itself; editing a connection leaves secret fields untouched unless you
  type a new value.
- **The existing single-store Shopify product-sync page (Shopify Sync) is
  unchanged** and still works exactly as before — it's now one path through
  a more general staging table that also accepts WooCommerce products and
  multiple income sources, tagged by `platform`/`income_source_id`.

## A real bug caught by actually running the migration

The very first version of `migrate.js` ran `schema.sql` (which now includes
`CREATE INDEX idx_sales_source ON sales(source_type, ...)`), *then* tried to
backfill the new columns — but on an existing database the index creation
failed first, because `source_type` didn't exist yet, crashing the whole
migration before the backfill could run. Fixed by backfilling columns
between two passes of `schema.sql` (the first pass creates whatever it can —
new tables, unaffected indexes — the second pass, after backfill, finishes
the rest). Verified against a simulated pre-upgrade database with an
existing sales row, which survives the migration untouched.

---



Six new modules added: CRM (Leads), Requisitions, Expenses, Payments, Staff,
and Staff Logs. Full backend + frontend, role-gated, mobile-responsive.

## ⚠️ Before you run this

The backend has no ALTER-based migration system — `schema.sql` only uses
`CREATE TABLE IF NOT EXISTS`, so changes to the `users` table (new `phone`
column, etc.) won't apply to an existing `data/urban_trends.db`. **Delete
your local `backend/data/` folder before running `npm run migrate` again.**
This matches the existing project's convention — it never had a migration
system to begin with — but it's easy to miss the first time.

```
rm -rf backend/data
cd backend && npm run migrate && npm run seed
```

## Decisions made during integration (recap)

- **Requisition approval auto-increments inventory** on approve (atomic
  transaction: requisition status + line items + inventory + movement log
  all commit together or not at all).
- **Payments = interpretation B**: a distinct recording action for layaway/
  partial customer payments and outgoing supplier payments — *not* a view
  over Terminal's own per-sale checkout payments. Backed by a new
  `payment_records` table (see below — naming note).
- **Cashiers cannot record expenses** — manager/admin only.
- **Staff reuses the existing `users` table** rather than a new `staff`
  table, to avoid duplicating identity (JWTs carry a `users.id`).
- **Error contract standardized app-wide** to `{ error: { code, message } }`,
  including all pre-existing routes (backward-compatible — no existing
  `throw new ApiError(status, message)` call site needed to change).

## Two real bugs the requirements doc's assumptions would have caused

1. **The doc assumed MySQL; the app actually runs `better-sqlite3`.** All
   six new tables are plain SQLite DDL matching the existing `schema.sql`
   conventions (`CHECK` constraints instead of enums, etc.).
2. **Table name collision:** the app already has a `payments` table (used
   internally by Terminal checkout for split payments). The new Payments
   module's table is named `payment_records` instead — same `/api/payments`
   route, different underlying table. Caught by actually running the
   migration rather than assuming it would apply cleanly.

There was also a pre-existing, never-wired-up `audit_log` table with a
similar shape to what Staff Logs needed. It's been replaced by `staff_logs`
(matching the spec's columns) rather than keeping two overlapping tables.

## What's new

**Backend** (`backend/src/`):
- `db/schema.sql` — `staff_logs`, `leads`, `lead_activities`,
  `lead_status_history`, `requisitions`, `requisition_items`,
  `expense_categories`, `expenses`, `payment_records`; `users` gained
  `phone` + `updated_at`; `inventory_movements.reason` gained `'requisition'`.
- `utils/paginate.js`, `utils/auditLog.js`, `utils/phone.js` — new shared
  helpers.
- `utils/ApiError.js`, `middleware/errorHandler.js` — updated for the new
  error shape (backward compatible).
- `services/leads.service.js` — status state machine + duplicate-phone
  detection.
- `services/requisitions.service.js` — atomic approve transaction.
- `controllers/` + `routes/` — `leads`, `requisitions`, `expenses`,
  `payments`, `staffLogs`; `users` controller/routes extended to cover the
  Staff module (mounted at both `/api/users` and `/api/staff`).
- `db/seed.js` — seeds default expense categories.

**Frontend** (`frontend/src/`):
- `components/Layout.jsx` — now responsive: a slide-over drawer + hamburger
  on mobile, persistent sidebar on desktop (this didn't exist before —
  the old sidebar was fixed-width with no mobile handling at all).
- `pages/Leads.jsx`, `Requisitions.jsx`, `Expenses.jsx`, `Payments.jsx`,
  `Staff.jsx`, `StaffLogs.jsx` — new pages, responsive tables/modals.
- `api/endpoints.js` — new `leadsApi`, `requisitionsApi`, `expensesApi`,
  `paymentsApi`, `staffApi`, `staffLogsApi`.
- `api/client.js` — new `getErrorMessage()` helper (the error shape changed
  from a string to `{code, message}` — this is used everywhere instead of
  reading `err.response.data.error` directly).
- Fixed 5 existing pages (Categories, POSTerminal, Products, ShopifySync,
  Login) that read the old string error shape directly — they'd have
  rendered "[object Object]" otherwise.
- `App.jsx` — new routes, role-gated via the existing `ProtectedRoute`.

## Testing performed

Ran the full stack locally (migrate → seed → backend → `vite build` →
`vite preview`) and exercised every new endpoint by hand: auth, leads
(create/duplicate-detect/state-machine/activities), requisitions
(create/approve-with-inventory-bump/reject/re-approve-conflict), expenses,
payment_records, staff (create/list/reset-password), staff-logs
(stats + list), and role restrictions for cashier/manager/admin on each.
`npm run build` and `npx oxlint src` both pass clean on the frontend.

## Open item you may want to revisit

Manager/admin-only role for recording Payments assumes the same
sensitivity as the original "view payments/reconciliation" row in the
doc's matrix — the doc didn't have an explicit row for this once we picked
interpretation B, so this was inferred rather than confirmed with you.
