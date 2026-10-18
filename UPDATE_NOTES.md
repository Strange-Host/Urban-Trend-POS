# Urban Trends POS — update notes (security, phone use, staff and categories)

## 1. What changed

**Sign-in and sessions**
- The POS no longer stays signed in forever. Each sign-in is a *session* with: a **screen lock** after a few idle minutes (password, or PIN for cashiers, to carry on), a **sign-out** after longer idleness, and a **hard maximum length**. Defaults: cashiers lock after 5 min / sign out after 30 min / 12 h maximum; managers 10 min / 60 min / 7 days; admins 10 min / 30 min / 24 h. Change them in **Security → Sign-in rules** (admins).
- The lock is enforced by the **server**, not just drawn on screen: a copied browser can't carry on without the password/PIN.
- A **"Keep me signed in on this device"** box on the sign-in page. Unticked: ends when the browser closes (and is capped at 12 h). Ticked: lasts up to the role maximum, still locks when idle. PIN sign-ins are never remembered.
- **Confirm it's you**: before refunds, voids, stock adjustments, staff changes and changes to integrations/settings, the POS asks for the password again if it hasn't been typed in the last 5 minutes. The action then carries on by itself.
- **Signed-in devices** list and "sign out all others" (**Security & devices**, bottom of the sidebar). Admins can also sign a staff member out of every device.
- Wrong passwords/PINs lock an account (5 in a row → 15 minutes). PIN and password are locked separately. Admins can lift a lock from the staff **More** menu.
- A copied refresh token that is replayed ends the whole session and alerts the admins.

**Passwords**: 12+ characters for admins and managers, 8+ (not only digits) for cashiers; common passwords, runs like `123456`, and passwords containing the person's name/email are refused. Temporary passwords are 12 characters and **must be changed** at first sign-in.

**Alerts to the admins** (bell + the Security page; urgent ones also by email if email is set up): account lockouts, replayed sign-ins, refunds/voids over KES 3,000, stock adjustments of 25+ units, price changes of 15%+, staff created/role changed/password reset/deactivated/deleted/erased, and changes to online-store, payment, SMS, email or backup settings. Limits are editable in **Security**.

**Backups**: emailed backups are now compressed and **encrypted**. A **trial restore** tool checks that a backup is intact (section 4).

**Staff** (Staff page): *Active / Inactive / All* tabs; **Reactivate**; **More ▾** menu (access, reset password, sign out everywhere, unlock, **Remove account…**). Removing offers: *Deactivate*, *Delete permanently* (only for accounts that never did anything), *Erase personal data* (former staff: wipes name, email, phone, password, PIN and HR documents but keeps their sales and records as "Former staff #N").

**Categories**: **Delete** now shows what uses the category and moves everything (products, switched-off products, items waiting in the sync review, sub-categories) to another category in one step; **Archive / Restore** hides a category from pickers without touching old products. *(The old Delete button never worked: the page called functions that didn't exist.)*

**Phone use**: every pop-up is now a bottom sheet that follows the keyboard and keeps its buttons in reach, and closes with the back gesture; new category picker (instead of the phone's own dropdown); redesigned **Adjust stock**; bigger Approve/Reject buttons, bulk category and bulk approve, and "show 50 more" on the sync review.

**Packages**: `npm audit` is clean (0 vulnerabilities) for backend and frontend; Dependabot is configured (`.github/dependabot.yml`).

## 2. Deploying it
1. Extract the zip **over your project folder** (same paths; replace when asked). It contains only changed/new files.
2. In Railway → your service → **Variables**, add `BACKUP_PASSPHRASE` (12+ characters; keep it in your password manager). Optional now, required later: `TRUST_PROXY_HOPS=2` only if you add Cloudflare (section 3).
3. In the project folder: `git add .` → `git commit -m "security and phone update"` → `git push`. Railway redeploys by itself.
4. **Everyone signs in once after this update** (old sign-ins are retired on purpose). The database change is additive and automatic.
5. Open **Security** as admin and check the rules suit your shop. Make a trial restore (section 4).
6. GitHub → your repository → **Settings → Code security**: switch on *Dependabot alerts* and *Dependabot security updates* (free).

## 3. Cloudflare in front of the POS (recommended, needs your own domain)
1. Buy/choose a domain. In Cloudflare, **Add a site**, choose the free plan, and change the **nameservers** at your registrar to the two Cloudflare gives you (wait until Cloudflare says Active).
2. Railway → service → **Settings → Networking → Custom Domain**: add `pos.yourdomain.com`. Railway shows a CNAME target. In Cloudflare **DNS**, add that CNAME (`pos` → the target). Leave the cloud **grey (DNS only)** until Railway shows the domain as verified, then switch it to **orange (Proxied)**.
3. Cloudflare → **SSL/TLS** → set the mode to **Full (strict)**.
4. Railway variables: `TRUST_PROXY_HOPS=2`, `CORS_ORIGIN=https://pos.yourdomain.com`, `APP_BASE_URL=https://pos.yourdomain.com`. In the POS, **Settings → Server → Public web address** = the same.
5. Cloudflare → **Security → WAF → Rate limiting rules**: add a rule for URI path `/api/auth/login` (and `/api/auth/pin-login`), e.g. 10 requests per minute per IP → Block for 10 minutes. Turn on **Bot Fight Mode**.
6. Update webhook addresses in Shopify/M-Pesa/WordPress to the new domain; keep the old Railway address working until everything is moved.
(The exact Cloudflare/Railway screen names can change; Railway's "custom domain" docs describe the Cloudflare steps.)

## 4. Trial restore of an emailed backup
On your own computer (Node 18+), in the project's `backend` folder, after `npm ci`:
```
BACKUP_PASSPHRASE="your passphrase" node scripts/restore-backup.js path/to/urban_trends-....db.gz.enc
```
If you never set `BACKUP_PASSPHRASE`, the server's `ENCRYPTION_KEY` is used instead (set it in the same way). It decrypts to a separate file, checks the database is intact, prints row counts and ends with **TRIAL RESTORE PASSED** or **FAILED**. It never touches the live database. Do this once now and again every few months.

## 5. How it was checked
Backend: 456 automated tests pass (411 existing + 45 new). Frontend: 42 automated tests pass and the production build compiles; the old-database upgrade path was tested. **Not tested on a real phone** (no phone/browser was available): please try the checklist below once deployed.

Phone checklist: Adjust stock (keypad, buttons visible above the keyboard) · open and close a pop-up with the back gesture · pick a category (and add one) · Sync review: tick several, set category, approve · leave the screen idle: warning, lock, unlock · tick "keep me signed in" on your phone · sign in on a second device and see it under Security → devices.

Note: because passwords are now checked against a common-password list and the person's name, a few **existing automated tests** that used name-based passwords were changed to stronger ones.
