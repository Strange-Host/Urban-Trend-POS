// Urban Trends staff screens. Plain JavaScript, no build step. Every value from the server is put on the page as text, never as HTML.
const app = document.getElementById('app');
const dlg = document.getElementById('dlg');
const S = { token: sessionStorage.getItem('ut_token'), me: null, perms: [] };
const can = (p) => S.perms.includes(p);

// ------------------------------------------------------------------ small helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
const kes = (c) => (Number(c) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (v) => { const n = Number(String(v).replace(/,/g, '').trim()); if (!Number.isFinite(n) || n < 0 || String(v).trim() === '') throw new Error('Enter an amount like 1500 or 1500.50.'); return Math.round(n * 100); };
const when = (d) => (d ? new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const monthStart = () => today().slice(0, 8) + '01';
const pct = (bp) => `${(bp / 100).toFixed(1)}%`;
const label = (text, input, cls) => h('label', { class: cls }, text, input);
const input = (name, o = {}) => h('input', { name, type: o.type || 'text', placeholder: o.ph, value: o.value, required: o.required, min: o.min, step: o.step, autocomplete: o.auto || 'off', inputmode: o.mode, list: o.list });
const select = (name, opts, cur) => { const s = h('select', { name }, opts.map(([v, t]) => h('option', { value: v }, t))); if (cur !== undefined) s.value = cur; return s; };
const pill = (text, kind) => h('span', { class: `pill ${kind || ''}` }, String(text).replace(/_/g, ' '));
const statusKind = (s) => ({ delivered: 'good', returned: 'amber', returning: 'warn', cancelled: '', dispatched: 'amber', awaiting_dispatch: '' }[s] || '');

function notice(text, kind = 'ok') { const n = h('div', { class: `msg ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, text); const box = document.getElementById('notice'); if (box) { box.replaceChildren(n); box.scrollIntoView({ block: 'nearest' }); } else alert(text); }
const fail = (e) => notice(e.message || 'Something went wrong.', 'err');

async function api(method, path, body, { raw } = {}) {
  const res = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data.error?.code;
    if (res.status === 401 && (code === 'SESSION_INVALID' || code === 'NOT_LOGGED_IN')) { logout(); }
    const msg = data.error?.code === 'VALIDATION' && data.details?.length ? `${data.error.message} ${data.details.map((d) => `${d.field}: ${d.message}`).join('; ')}` : data.error?.message || 'Something went wrong.';
    const e = new Error(msg); e.code = code; e.status = res.status; e.details = data.details; throw e;
  }
  return data;
}

/** Runs a button's action once at a time, shows what went wrong, and refreshes the view on success. */
function act(btn, fn, { ok, then } = {}) {
  return async (ev) => {
    ev?.preventDefault?.();
    btn = btn || ev.currentTarget; btn.disabled = true;
    try { const r = await fn(); if (ok) notice(typeof ok === 'function' ? ok(r) : ok); if (then) await then(r); } catch (e) { fail(e); } finally { btn.disabled = false; }
  };
}
function form(fields, submitText, onSubmit, opts = {}) {
  const f = h('form', { class: 'row' }, fields, h('button', { type: 'submit', class: opts.danger ? 'danger' : '' }, submitText));
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault(); const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try { const r = await onSubmit(Object.fromEntries(new FormData(f)), f); if (opts.ok) notice(typeof opts.ok === 'function' ? opts.ok(r) : opts.ok); if (opts.then) await opts.then(r); } catch (e) { fail(e); } finally { btn.disabled = false; }
  });
  return f;
}

function ask(title, body, buttons) {
  return new Promise((resolve) => {
    dlg.replaceChildren(h('h2', {}, title), body, h('div', { class: 'row' }, buttons.map(([text, value, cls]) => h('button', { type: 'button', class: cls, onclick: () => { dlg.close(); resolve(value); } }, text))));
    dlg.addEventListener('close', () => resolve(null), { once: true });
    dlg.showModal();
  });
}
/** A manager approves by typing their own username and password. Returns {username, password} or null. */
async function askApproval(what) {
  const u = input('u', { auto: 'off', required: true }), p = input('p', { type: 'password', auto: 'new-password', required: true });
  const r = await ask('Manager approval', h('div', {}, h('p', { class: 'muted' }, `A manager must approve ${what}. They enter their own username and password here.`), label('Manager username', u), label('Manager password', p)), [['Approve', true], ['Cancel', false, 'secondary']]);
  return r ? { username: u.value.trim(), password: p.value } : null;
}
async function download(path, filename) {
  const res = await api('GET', path, undefined, { raw: true });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error?.message || 'Download failed.'); }
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: filename }); document.body.append(a); a.click(); a.remove();
}
const table = (heads, rows, numCols = []) => h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((t, i) => h('th', { class: numCols.includes(i) ? 'n' : '' }, t)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numCols.includes(i) ? 'n' : '' }, c)))))));
const empty = (t) => h('p', { class: 'muted' }, t);

// ------------------------------------------------------------------ shell and routing
function logout() { S.token = null; S.me = null; S.perms = []; sessionStorage.removeItem('ut_token'); location.hash = '#/login'; render(); }

const NAV = [
  ['#/risk', 'Money at risk', () => can('atrisk.view')], ['#/home', 'Today', () => !can('atrisk.view')],
  ['#/orders', 'Orders', () => can('orders.view')], ['#/new-order', 'New order', () => can('orders.create')],
  ['#/couriers', 'Couriers', () => can('couriers.view')], ['#/till', 'Till', () => can('till.operate')],
  ['#/pay', 'Pay', () => true], ['#/discounts', 'Discounts', () => can('reports.view')],
];
function shell(content) {
  const here = location.hash.split('/').slice(0, 2).join('/');
  return h('div', {}, h('header', {},
    h('strong', {}, 'Urban Trends'),
    h('nav', {}, NAV.filter(([, , show]) => show()).map(([href, text]) => h('a', { href, class: href === here ? 'on' : '' }, text))),
    h('span', { class: 'who' }, `${S.me.displayName} (${S.me.role})`),
    h('button', { class: 'secondary', onclick: act(null, async () => { await api('POST', '/auth/logout').catch(() => {}); logout(); }) }, 'Log out')),
  h('main', {}, h('div', { id: 'notice' }), content));
}
const mount = (node) => { app.replaceChildren(node); };

const ROUTES = [
  [/^#\/login$/, () => viewLogin()], [/^#\/home$/, () => viewHome()], [/^#\/risk$/, () => viewRisk()],
  [/^#\/orders$/, () => viewOrders()], [/^#\/order\/(.+)$/, (m) => viewOrder(decodeURIComponent(m[1]))], [/^#\/new-order$/, () => viewNewOrder()],
  [/^#\/couriers$/, () => viewCouriers()], [/^#\/courier\/(\d+)$/, (m) => viewCourier(Number(m[1]))],
  [/^#\/till$/, () => viewTill()], [/^#\/pay$/, () => viewPay()], [/^#\/discounts$/, () => viewDiscounts()],
];
async function render() {
  if (!S.token) { if (location.hash !== '#/login') { location.hash = '#/login'; return; } return viewLogin(); }
  if (!S.me) { try { const r = await api('GET', '/auth/me'); S.me = r.user; S.perms = r.permissions; } catch { return; } }
  if (S.me.mustChangePassword) return viewChangePassword();
  const hash = location.hash || (can('atrisk.view') ? '#/risk' : '#/home');
  if (!location.hash) { location.hash = hash; return; }
  for (const [re, fn] of ROUTES) { const m = re.exec(hash); if (m) { try { return await fn(m); } catch (e) { mount(shell(h('div', { class: 'msg err' }, e.message))); return; } } }
  mount(shell(h('p', {}, 'That page does not exist.')));
}
window.addEventListener('hashchange', render);

// ------------------------------------------------------------------ login and password
function viewLogin() {
  const msg = h('div', { id: 'notice' });
  mount(h('div', { class: 'login card' }, h('h1', {}, 'Urban Trends'), msg,
    form([label('Username', input('username', { required: true, auto: 'username' })), label('Password', input('password', { type: 'password', required: true, auto: 'current-password' }))], 'Log in',
      async (v) => { const r = await api('POST', '/auth/login', v); S.token = r.token; sessionStorage.setItem('ut_token', r.token); S.me = r.user; S.perms = r.permissions; location.hash = ''; await render(); })));
}
function viewChangePassword() {
  mount(h('div', { class: 'login card' }, h('h1', {}, 'Choose your own password'), h('div', { id: 'notice' }),
    h('p', { class: 'muted' }, 'You are using a one-time password. Choose a new one (at least 10 characters) to continue.'),
    form([label('One-time password', input('currentPassword', { type: 'password', required: true })), label('New password', input('newPassword', { type: 'password', required: true, auto: 'new-password' }))], 'Save password',
      async (v) => { await api('POST', '/auth/change-password', v); S.me = null; await render(); })));
}

// ------------------------------------------------------------------ today (everyone) and the clock
async function clockCard() {
  const to = today();
  const rec = (await api('GET', `/payroll/attendance?from=${to}&to=${to}`)).records[0];
  const body = h('div', {});
  const state = !rec ? 'Not clocked in today.' : rec.clockOutAt ? `Clocked in ${when(rec.clockInAt)}, out ${when(rec.clockOutAt)}.` : `Clocked in ${when(rec.clockInAt)}.`;
  body.append(h('p', {}, state));
  if (!rec) body.append(h('button', { onclick: act(null, () => api('POST', '/payroll/attendance/clock-in'), { ok: 'Clocked in.', then: render }) }, 'Clock in'));
  else if (!rec.clockOutAt && !rec.absenceReason) body.append(h('button', { onclick: act(null, () => api('POST', '/payroll/attendance/clock-out'), { ok: 'Clocked out.', then: render }) }, 'Clock out'));
  return h('div', { class: 'card' }, h('h2', {}, 'Attendance'), body);
}
async function viewHome() {
  mount(shell(h('div', {}, h('h1', {}, `Hello, ${S.me.displayName}`), await clockCard(),
    h('div', { class: 'card' }, h('p', {}, 'Use the menu above. ', can('orders.create') ? h('a', { href: '#/new-order' }, 'Take a new order') : null)))));
}

// ------------------------------------------------------------------ money at risk
const RISK_TEXT = {
  dispatched_no_outcome: 'Dispatched, no delivery outcome', delivered_unpaid: 'Delivered but not fully paid', unmatched_payment: 'Money nobody has matched', returning: 'Parcel not back yet',
  courier_unpaid: 'Owed to a courier', dispatch_no_fee: 'Dispatched with no package fee', organization_overdue: 'Organization has not remitted', cash_not_deposited: 'Shop cash not deposited',
  till_variance_unsigned: 'Till difference not signed off', till_session_left_open: 'Till left open',
};
async function viewRisk() {
  const [alerts, risk, susp, custody] = await Promise.all([api('GET', '/alerts?open=true'), api('GET', '/at-risk'), api('GET', '/payments/suspense'), api('GET', '/custody')]);
  const out = h('div', {}, h('h1', {}, 'Money at risk'));
  for (const a of alerts.alerts) {
    const note = input('note', { ph: 'What you found / did' });
    out.append(h('div', { class: 'card msg err' }, h('strong', {}, a.title), h('p', { class: 'muted' }, when(a.createdAt)),
      a.body?.firstViolations ? h('ul', {}, a.body.firstViolations.map((v) => h('li', {}, v.message))) : null,
      h('div', { class: 'row' }, label('Note', note, 'grow'), h('button', { onclick: act(null, () => api('POST', `/alerts/${a.id}/acknowledge`, { note: note.value }), { ok: 'Acknowledged.', then: render }) }, 'Acknowledge'))));
  }
  out.append(h('div', { class: 'card' }, h('div', { class: 'big' }, `KES ${kes(risk.totalCents)}`), h('div', { class: 'muted' }, `${risk.items.length} item${risk.items.length === 1 ? '' : 's'} need attention`)));
  out.append(risk.items.length ? table(['What', 'Order', 'Amount', 'Days', 'Who', 'Detail'], risk.items.map((i) => [pill(RISK_TEXT[i.kind] || i.kind, 'warn'), i.orderRef ? h('a', { href: `#/order/${encodeURIComponent(i.orderRef)}` }, i.orderRef) : '', kes(i.amountCents), i.ageDays, i.owner || '', i.detail]), [2, 3]) : empty('Nothing at risk right now.'));

  out.append(h('h2', {}, 'Payments waiting for a match'));
  out.append(susp.items.length ? susp.items.map((x) => {
    const ref = input('orderRef', { ph: 'Order reference', required: true });
    return h('div', { class: 'card' }, h('div', {}, h('strong', {}, `KES ${kes(x.remainingCents)}`), ` ${x.transCode} `, pill(x.kind, 'amber')),
      h('div', { class: 'muted' }, [x.payerName, x.msisdn, x.accountRaw && `typed: ${x.accountRaw}`, when(x.createdAt)].filter(Boolean).join(' · ')),
      form([label('Match to order', ref, 'grow')], 'Match', (v) => api('POST', `/payments/suspense/${x.exceptionId}/apply`, v), { ok: 'Matched.', then: render }),
      form([label('Reason for refund', input('reason', { required: true }), 'grow')], 'Refund to payer', async (v) => { if (await ask('Refund this payment?', h('p', {}, `KES ${kes(x.remainingCents)} goes back to the payer.`), [['Refund', true, 'danger'], ['Cancel', false, 'secondary']])) return api('POST', `/payments/suspense/${x.exceptionId}/refund`, v); throw new Error('Cancelled.'); }, { ok: 'Refunded.', then: render }));
  }) : empty('No unmatched money.'));

  out.append(h('h2', {}, 'Shop cash waiting to be deposited'));
  out.append(custody.records.length ? table(['Held by', 'Order', 'Amount', 'Since', ''], custody.records.map((c) => [c.holder, h('a', { href: `#/order/${encodeURIComponent(c.orderRef)}` }, c.orderRef), kes(c.amountCents), when(c.openedAt),
    h('button', { onclick: act(null, () => api('POST', `/custody/${c.id}/deposit`), { ok: 'Deposited.', then: render }) }, 'Mark deposited')]), [2]) : empty('No cash held.'));
  mount(shell(out));
}

// ------------------------------------------------------------------ orders
async function viewOrders() {
  const q = { status: '', search: '', unpaid: false };
  const list = h('div', {});
  const load = async () => {
    const p = new URLSearchParams({ limit: '50' }); if (q.status) p.set('status', q.status); if (q.search) p.set('search', q.search); if (q.unpaid) p.set('unpaid', 'true');
    const r = await api('GET', `/orders?${p}`);
    list.replaceChildren(h('p', { class: 'muted' }, `${r.total} order${r.total === 1 ? '' : 's'}${r.total > r.orders.length ? ` (showing the newest ${r.orders.length})` : ''}`),
      r.orders.length ? table(['Order', 'Customer', 'Status', 'Total', 'Owes', 'Courier', 'Created'], r.orders.map((o) => [h('a', { href: `#/order/${encodeURIComponent(o.orderRef)}` }, o.orderRef), h('div', {}, o.customerName, h('div', { class: 'muted' }, o.customerPhone)), pill(o.status, statusKind(o.status)), kes(o.totalCents), o.balanceCents > 0 ? kes(o.balanceCents) : '', o.courierName || '', when(o.createdAt)]), [3, 4]) : empty('No orders match.'));
  };
  const st = select('status', [['', 'All'], ['active', 'Active'], ['awaiting_dispatch', 'Awaiting dispatch'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered'], ['returning', 'Returning'], ['returned', 'Returned'], ['cancelled', 'Cancelled']]);
  const se = input('search', { ph: 'Reference, name or phone' }); const un = h('input', { type: 'checkbox' });
  st.addEventListener('change', () => { q.status = st.value; load().catch(fail); });
  se.addEventListener('input', () => { clearTimeout(se.t); se.t = setTimeout(() => { q.search = se.value.trim(); load().catch(fail); }, 300); });
  un.addEventListener('change', () => { q.unpaid = un.checked; load().catch(fail); });
  mount(shell(h('div', {}, h('h1', {}, 'Orders'), h('div', { class: 'row' }, label('Status', st), label('Search', se, 'grow'), label('Not fully paid', un), can('orders.create') ? h('a', { href: '#/new-order' }, 'New order') : null), list)));
  await load();
}

async function viewOrder(ref) {
  const { order: o } = await api('GET', `/orders/${encodeURIComponent(ref)}`);
  const reload = () => render();
  const out = h('div', {}, h('h1', {}, o.orderRef, ' ', pill(o.status, statusKind(o.status)), ' ', pill(o.paymentStatus, o.paymentStatus === 'paid' ? 'good' : o.paymentStatus === 'unpaid' ? 'warn' : 'amber')));
  out.append(h('div', { class: 'card' }, h('dl', { class: 'kv' },
    h('dt', {}, 'Customer'), h('dd', {}, `${o.customerName}, ${o.customerPhone}`), h('dt', {}, 'Total'), h('dd', {}, `KES ${kes(o.totalCents)}`), h('dt', {}, 'Paid'), h('dd', {}, `KES ${kes(o.paidCents)}`),
    h('dt', {}, 'Still owes'), h('dd', {}, `KES ${kes(o.balanceCents)}`), o.collectedByOrganizationCents ? [h('dt', {}, 'Held by organization'), h('dd', {}, `KES ${kes(o.collectedByOrganizationCents)}`)] : null,
    o.dispatch ? [h('dt', {}, 'Courier'), h('dd', {}, `${o.dispatch.courierName}, fee KES ${kes(o.dispatch.packageFeeCents)}${o.dispatch.zeroReason ? ` (${o.dispatch.zeroReason})` : ''}`)] : null)));
  out.append(h('h2', {}, 'Items'), table(['Item', 'Qty', 'Price', 'Discount', 'Line'], o.items.map((i) => [`${i.name}${i.sku ? ` (${i.sku})` : ''}`, i.quantity, kes(i.unitPriceCents), i.discountCents ? kes(i.discountCents) : '', kes(i.lineTotalCents)]), [1, 2, 3, 4]));

  // actions
  if (can('orders.manage')) {
    if (o.status === 'awaiting_dispatch') {
      const couriers = (await api('GET', '/couriers?active=true')).couriers;
      const fee = input('fee', { ph: '0 for none', required: true, mode: 'decimal' }), why = input('zeroReason', { ph: 'Needed if the fee is 0' });
      const c = select('courierId', couriers.map((x) => [x.id, `${x.name} (${x.kind})`]));
      out.append(h('h2', {}, 'Dispatch'), couriers.length ? form([label('Courier', c, 'grow'), label('Package fee (KES)', fee), label('Reason if fee is 0', why, 'grow')], 'Dispatch', (v) => api('POST', `/orders/${encodeURIComponent(o.orderRef)}/dispatch`, { courierId: Number(v.courierId), packageFee: { amountCents: toCents(v.fee), zeroReason: v.zeroReason || undefined } }), { ok: 'Dispatched.', then: reload }) : empty('Add a courier first.'));
      out.append(form([label('Reason for cancelling', input('reason', { required: true }), 'grow')], 'Cancel order', (v) => api('POST', `/orders/${encodeURIComponent(o.orderRef)}/cancel`, v), { ok: 'Cancelled.', then: reload, danger: true }));
    }
    if (o.status === 'dispatched') {
      const outc = select('outcome', [['delivered', 'Delivered'], ['not_claimed', 'Customer did not claim it'], ['refused', 'Customer refused it'], ['rescheduled', 'Rescheduled']]);
      out.append(h('h2', {}, 'Delivery outcome'), form([label('Outcome', outc), label('Reason', input('reason'), 'grow'), label('New date', input('rescheduleFor', { type: 'date' }))], 'Record', (v) => api('POST', `/orders/${encodeURIComponent(o.orderRef)}/attempts`, { outcome: v.outcome, reason: v.reason || undefined, rescheduleFor: v.rescheduleFor || undefined }), { ok: 'Recorded.', then: reload }));
    }
    if (o.status === 'returning') {
      const rows = o.items.map((i) => ({ i, back: input(`b${i.id}`, { type: 'number', min: 0, value: String(i.quantity) }), bad: input(`d${i.id}`, { type: 'number', min: 0, value: '0' }) }));
      const notes = input('notes', { ph: 'Needed if anything is missing' });
      out.append(h('h2', {}, 'The parcel is back'), h('p', { class: 'muted' }, 'Count what came back. Goods that go back on the shelf add to stock; damaged goods do not. Anything not counted is recorded as missing.'),
        h('div', { class: 'card' }, rows.map((r) => h('div', { class: 'row' }, h('div', { class: 'grow' }, `${r.i.name} (sent ${r.i.quantity})`), label('Back on shelf', r.back), label('Damaged', r.bad))),
          h('div', { class: 'row' }, label('Notes', notes, 'grow'), h('button', { onclick: act(null, () => api('POST', `/orders/${encodeURIComponent(o.orderRef)}/returned`, { notes: notes.value || undefined, items: rows.map((r) => ({ orderItemId: r.i.id, restockQuantity: Number(r.back.value), damagedQuantity: Number(r.bad.value) })) }),
            { ok: (r) => `Received. KES ${kes(r.unpaidWrittenOffCents)} unpaid was taken off sales.${r.customerCreditCents ? ` The customer has KES ${kes(r.customerCreditCents)} credit to refund.` : ''}`, then: reload }) }, 'Receive parcel'))));
    }
  }
  if (can('payments.match') && o.balanceCents > 0 && !['cancelled', 'returned'].includes(o.status)) {
    out.append(h('h2', {}, 'Cash taken at the shop'), form([label('Amount (KES)', input('amount', { required: true, mode: 'decimal' })), label('Why it was paid at the shop', input('reason', { required: true }), 'grow')], 'Record cash', (v) => api('POST', `/orders/${encodeURIComponent(o.orderRef)}/shop-cash`, { amountCents: toCents(v.amount), reason: v.reason }), { ok: 'Recorded. The cash is held until deposited.', then: reload }));
  }
  out.append(h('h2', {}, 'History'), table(['When', 'What', 'Who'], [...o.events].reverse().map((e) => [when(e.at), e.type.replace(/_/g, ' '), e.actor])));
  mount(shell(out));
}

async function viewNewOrder() {
  const prods = can('catalog.view') ? (await api('GET', '/products?active=true&limit=100')).products : [];
  const items = h('div', {});
  const dl = h('datalist', { id: 'skus' }, prods.map((p) => h('option', { value: p.sku }, `${p.name} (${p.available} available)`)));
  const addRow = () => {
    const sku = input('sku', { ph: 'Code (optional)', list: 'skus' }), name = input('name', { ph: 'Item', required: true }), qty = input('qty', { type: 'number', min: 1, value: '1', required: true }), price = input('price', { ph: 'Price KES', required: true, mode: 'decimal' });
    sku.addEventListener('change', () => { const p = prods.find((x) => x.sku === sku.value.trim().toUpperCase()); if (p) { name.value = p.name; price.value = String(p.priceCents / 100); } });
    items.append(h('div', { class: 'row item' }, label('Code', sku), label('Item', name, 'grow'), label('Qty', qty), label('Price (KES)', price)));
  };
  addRow();
  const f = h('form', {}, h('div', { class: 'row' }, label('Customer name', input('customerName', { required: true }), 'grow'), label('Phone', input('customerPhone', { required: true, mode: 'tel' }))), h('h2', {}, 'Items'), items,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: addRow }, 'Add another item')),
    h('div', { class: 'row' }, label('Discount (KES)', input('discount', { mode: 'decimal' })), label('Notes', input('notes'), 'grow')), h('p', {}, h('button', { type: 'submit' }, 'Create order')));
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault(); const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const v = Object.fromEntries(new FormData(f));
      const lines = [...f.querySelectorAll('.item')].map((r) => ({ sku: r.querySelector('[name=sku]').value.trim() || undefined, name: r.querySelector('[name=name]').value.trim(), quantity: Number(r.querySelector('[name=qty]').value), unitPriceCents: toCents(r.querySelector('[name=price]').value) }));
      const r = await api('POST', '/orders', { customerName: v.customerName, customerPhone: v.customerPhone, items: lines, discountCents: v.discount ? toCents(v.discount) : undefined, notes: v.notes || undefined });
      location.hash = `#/order/${encodeURIComponent(r.order.orderRef)}`;
    } catch (e) {
      if (e.code === 'DUPLICATE_ACTIVE_ORDER' && e.details?.existingOrderRef) notice(h('span', {}, 'This phone number already has an active order: ', h('a', { href: `#/order/${encodeURIComponent(e.details.existingOrderRef)}` }, e.details.existingOrderRef), '.'), 'err');
      else fail(e);
    } finally { btn.disabled = false; }
  });
  mount(shell(h('div', {}, h('h1', {}, 'New order'), dl, f)));
}

// ------------------------------------------------------------------ couriers
async function viewCouriers() {
  const [list, costs] = await Promise.all([api('GET', '/couriers'), api('GET', '/couriers/costs?status=pending')]);
  const out = h('div', {}, h('h1', {}, 'Couriers'));
  out.append(table(['Name', 'Type', 'Phone', 'Status'], list.couriers.map((c) => [h('a', { href: `#/courier/${c.id}` }, c.name), c.kind === 'organization' ? (c.collectsPayment ? 'Organization (collects payment)' : 'Organization') : 'Rider', c.phone || '', pill(c.active ? 'active' : 'inactive', c.active ? 'good' : '')])));
  if (costs.costs.length) {
    out.append(h('h2', {}, 'Costs waiting for approval'), table(['Courier', 'What', 'Amount', 'Entered by', ''], costs.costs.map((c) => [c.courierName, `${c.kind.replace(/_/g, ' ')}: ${c.description}`, kes(c.amountCents), c.recordedBy,
      can('courier_costs.approve') && c.recordedBy !== S.me.username ? h('span', { class: 'row' }, h('button', { onclick: act(null, () => api('POST', `/couriers/costs/${c.id}/approve`), { ok: 'Approved.', then: render }) }, 'Approve'),
        h('button', { class: 'secondary', onclick: act(null, async () => { const w = input('w', { required: true }); if (await ask('Reject this cost', label('Reason', w), [['Reject', true, 'danger'], ['Cancel', false, 'secondary']])) return api('POST', `/couriers/costs/${c.id}/reject`, { reason: w.value }); throw new Error('Cancelled.'); }, { ok: 'Rejected.', then: render }) }, 'Reject')) : h('span', { class: 'muted' }, c.recordedBy === S.me.username ? 'Someone else must approve' : '')]), [2]));
  }
  if (can('couriers.manage')) {
    out.append(h('h2', {}, 'Add a rider'), form([label('Name', input('name', { required: true }), 'grow'), label('Phone', input('phone', { mode: 'tel' })), label('ID number', input('idNumber')), label('Bike plate', input('vehiclePlate'))], 'Add rider', (v) => api('POST', '/couriers/riders', Object.fromEntries(Object.entries(v).filter(([, x]) => x))), { ok: 'Rider added.', then: render }));
    const coll = h('input', { type: 'checkbox', name: 'collectsPayment', checked: true });
    out.append(h('h2', {}, 'Add an organization'), form([label('Name', input('name', { required: true }), 'grow'), label('Contact person', input('contactPerson')), label('Phone', input('phone', { mode: 'tel' })), label('Collects payment', coll), label('Overdue after (days)', input('overdueAfterDays', { type: 'number', min: 1, value: '14' })), label('Pause new parcels above (KES overdue)', input('limit', { mode: 'decimal' }))], 'Add organization',
      (v, f) => api('POST', '/couriers/organizations', { name: v.name, contactPerson: v.contactPerson || undefined, phone: v.phone || undefined, collectsPayment: f.querySelector('[name=collectsPayment]').checked, overdueAfterDays: Number(v.overdueAfterDays), overdueLimitCents: v.limit ? toCents(v.limit) : undefined }), { ok: 'Organization added.', then: render }));
  }
  mount(shell(out));
}

async function viewCourier(id) {
  const [d, unpaid] = await Promise.all([api('GET', `/couriers/${id}`), api('GET', `/couriers/${id}/unpaid`)]);
  const c = d.profile.courier, p = d.profile;
  const out = h('div', {}, h('h1', {}, c.name, ' ', pill(c.kind), ' ', pill(c.active ? 'active' : 'inactive', c.active ? 'good' : '')));
  out.append(h('div', { class: 'card' }, h('dl', { class: 'kv' }, h('dt', {}, 'We owe them'), h('dd', {}, `KES ${kes(p.owedCents)}`), h('dt', {}, 'Dispatches in progress'), h('dd', {}, p.dispatchesInProgress), h('dt', {}, 'Total earned'), h('dd', {}, `KES ${kes(p.totalEarnedCents)}`),
    c.kind === 'organization' && c.collectsPayment ? [h('dt', {}, 'They hold for us'), h('dd', {}, `KES ${kes(p.heldByOrganizationCents)}`)] : null,
    d.standing ? [h('dt', {}, 'Overdue'), h('dd', {}, `KES ${kes(d.standing.overdueCents)}`, d.standing.paused ? [' ', pill('new parcels paused', 'warn')] : null), h('dt', {}, 'Age of what they hold'), h('dd', {}, d.standing.buckets.map((b) => `${b.label} days: ${kes(b.cents)}`).join(' · '))] : null)));
  out.append(h('h2', {}, 'Owed and not yet paid'), unpaid.items.length ? table(['Since', 'What', 'Order', 'Amount'], unpaid.items.map((i) => [when(i.since), i.description, i.orderRef || '', kes(i.amountCents)]), [3]) : empty('Nothing owed.'));
  if (can('courier_payouts.pay') && unpaid.items.length) {
    out.append(h('h2', {}, 'Pay everything owed'), form([label('How', select('method', [['mpesa', 'M-Pesa'], ['bank', 'Bank'], ['cash', 'Cash']])), label('Payment reference', input('paymentRef', { ph: 'M-Pesa code / bank ref; not needed for cash' }), 'grow')], `Pay KES ${kes(p.owedCents)}`, (v) => api('POST', `/couriers/${id}/payouts`, { method: v.method, paymentRef: v.paymentRef || undefined }), { ok: 'Paid.', then: render }));
  }
  if (can('couriers.manage')) {
    out.append(h('h2', {}, 'Record a cost'), form([label('Kind', select('kind', [['return_trip', 'Return trip'], ['fuel', 'Fuel'], ['airtime', 'Airtime'], ['handling', 'Handling'], ['repair', 'Repair'], ['other', 'Other']])), label('Amount (KES)', input('amount', { required: true, mode: 'decimal' })), label('What for', input('description', { required: true }), 'grow'), label('Order', input('orderRef')), label('Receipt', input('receiptRef'))], 'Record cost',
      (v) => api('POST', `/couriers/${id}/costs`, { kind: v.kind, amountCents: toCents(v.amount), description: v.description, orderRef: v.orderRef || undefined, receiptRef: v.receiptRef || undefined }), { ok: 'Recorded. Someone else approves it.', then: render }));
    if (c.kind === 'organization' && c.collectsPayment) {
      out.append(h('h2', {}, 'They collected payment on a parcel'), form([label('Order', input('orderRef', { required: true }), 'grow'), label('Amount (KES)', input('amount', { required: true, mode: 'decimal' }))], 'Record collection', (v) => api('POST', `/couriers/${id}/collections`, { orderRef: v.orderRef, amountCents: toCents(v.amount) }), { ok: 'Recorded.', then: render }));
      const open = (await api('GET', `/couriers/${id}/open-collections`)).collections;
      out.append(h('h2', {}, 'Settle a statement'));
      if (!open.length) out.append(empty('No collections waiting for a statement.'));
      else {
        const boxes = open.map((k) => ({ k, cb: h('input', { type: 'checkbox', checked: true }) }));
        const from = input('from', { type: 'date', value: monthStart() }), to = input('to', { type: 'date', value: today() }), charge = input('charge', { required: true, mode: 'decimal', value: '0' }), rem = input('rem', { required: true, mode: 'decimal' }), refn = input('ref');
        out.append(h('div', { class: 'card' }, table(['', 'Order', 'Collected', 'On'], boxes.map(({ k, cb }) => [cb, k.orderRef, kes(k.amountCents), k.collectedOn]), [2]),
          h('div', { class: 'row' }, label('Period from', from), label('to', to), label('Their charge (KES)', charge), label('Cash they sent (KES)', rem), label('Remittance reference', refn, 'grow'),
            h('button', { onclick: act(null, () => api('POST', `/couriers/${id}/statements`, { periodStart: from.value, periodEnd: to.value, collectionIds: boxes.filter((b) => b.cb.checked).map((b) => b.k.id), chargeEnteredCents: toCents(charge.value), remittedCents: toCents(rem.value), remittanceRef: refn.value || undefined }),
              { ok: (r) => `Settled. Charge difference KES ${kes(r.statement.chargeVarianceCents)}; they still owe KES ${kes(Math.max(r.statement.cashVarianceCents, 0))}.`, then: render }) }, 'Settle statement'))));
      }
    }
    out.append(h('p', {}, h('button', { class: 'secondary', onclick: act(null, () => api('PUT', `/couriers/${id}/active`, { active: !c.active }), { then: render }) }, c.active ? 'Deactivate' : 'Reactivate')));
  }
  mount(shell(out));
}

// ------------------------------------------------------------------ till
async function viewTill() {
  const cur = await api('GET', '/till/current');
  const out = h('div', {}, h('h1', {}, 'Till'));
  if (can('till.signoff')) {
    const need = await api('GET', '/till/sessions?needsSignoff=true');
    if (need.sessions.length) out.append(h('div', { class: 'card' }, h('h2', {}, 'Closed tills waiting for sign-off'), table(['Cashier', 'Closed', 'Reason given', ''], need.sessions.map((s) => [s.cashier, when(s.closedAt), s.varianceReason || '', s.cashier === S.me.username ? h('span', { class: 'muted' }, 'Someone else signs off') : h('button', { onclick: act(null, () => api('POST', `/till/sessions/${s.id}/signoff`), { ok: 'Signed off.', then: render }) }, 'Sign off')]))));
  }
  if (!cur.session) {
    out.append(h('div', { class: 'card' }, h('h2', {}, 'Open your till'), form([label('Opening float (KES)', input('float', { required: true, mode: 'decimal', value: '0' }))], 'Open till', (v) => api('POST', '/till/sessions', { openingFloatCents: toCents(v.float) }), { ok: 'Till open.', then: render })));
    return mount(shell(out));
  }
  const s = cur.session, ex = cur.expected;
  out.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Open since ${when(s.openedAt)}, float KES ${kes(s.openingFloatCents)}`), h('div', { class: 'row' }, ['cash', 'card', 'mobile_money'].map((m) => h('div', { class: 'grow' }, h('div', { class: 'muted' }, m.replace('_', ' ')), h('div', { class: 'big' }, kes(ex[m])))))));

  // sell
  const prods = (await api('GET', '/products?active=true&limit=100')).products;
  const reasons = (await api('GET', '/discount-reasons')).reasons;
  const rows = h('div', {});
  const dl = h('datalist', { id: 'tillskus' }, prods.map((p) => h('option', { value: p.sku }, `${p.name} (${p.available} available)`)));
  const addRow = () => {
    const sku = input('sku', { ph: 'Code', list: 'tillskus' }), name = input('name', { ph: 'Item', required: true }), qty = input('qty', { type: 'number', min: 1, value: '1', required: true }), price = input('price', { ph: 'KES', required: true, mode: 'decimal' });
    sku.addEventListener('change', () => { const p = prods.find((x) => x.sku === sku.value.trim().toUpperCase()); if (p) { name.value = p.name; price.value = String(p.priceCents / 100); } });
    rows.append(h('div', { class: 'row line' }, label('Code', sku), label('Item', name, 'grow'), label('Qty', qty), label('Price', price)));
  };
  addRow();
  const pays = ['cash', 'card', 'mobile_money'].map((m) => ({ m, amt: input(`amt-${m}`, { mode: 'decimal', ph: '0' }), ref: input(`ref-${m}`, { ph: m === 'cash' ? '' : 'Reference' }) }));
  const disc = input('disc', { mode: 'decimal', ph: '0' }), reason = select('reason', [['', 'No discount'], ...reasons.map((r) => [r.code, r.label])]);
  const sell = h('form', {}, rows, h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: addRow }, 'Add item')), h('div', { class: 'row' }, label('Discount (KES)', disc), label('Reason', reason, 'grow')),
    h('div', {}, pays.map((p) => h('div', { class: 'row' }, h('div', { class: 'grow' }, p.m.replace('_', ' ')), label('Amount (KES)', p.amt), p.m === 'cash' ? null : label('Reference', p.ref)))), h('p', {}, h('button', { type: 'submit' }, 'Complete sale')));
  let attemptId = crypto.randomUUID();
  sell.addEventListener('submit', async (ev) => {
    ev.preventDefault(); const btn = sell.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const items = [...sell.querySelectorAll('.line')].map((r) => ({ sku: r.querySelector('[name=sku]').value.trim() || undefined, name: r.querySelector('[name=name]').value.trim(), quantity: Number(r.querySelector('[name=qty]').value), unitPriceCents: toCents(r.querySelector('[name=price]').value) }));
      const payments = pays.filter((p) => p.amt.value.trim() && toCents(p.amt.value) > 0).map((p) => ({ method: p.m, amountCents: toCents(p.amt.value), reference: p.ref.value.trim() || undefined }));
      const body = { items, payments, clientSaleId: attemptId, saleDiscountCents: disc.value.trim() ? toCents(disc.value) : undefined, discountReason: reason.value || undefined };
      let r;
      try { r = await api('POST', '/sales', body); } catch (e) {
        if (e.code !== 'DISCOUNT_NEEDS_APPROVAL') throw e;
        const ap = await askApproval('this discount'); if (!ap) throw new Error('The discount was not approved.');
        r = await api('POST', '/sales', { ...body, approval: ap });
      }
      attemptId = crypto.randomUUID(); notice(`Sale ${r.sale.saleNo} done: KES ${kes(r.sale.totalCents)}.`); await render();
    } catch (e) { fail(e); } finally { btn.disabled = false; }
  });
  out.append(h('h2', {}, 'Sell'), dl, sell);

  // recent sales
  const sales = (await api('GET', `/sales?sessionId=${s.id}&limit=30`)).sales;
  out.append(h('h2', {}, 'This session\'s sales'), sales.length ? table(['Sale', 'Total', 'Discount', 'Status', ''], sales.map((x) => [x.saleNo, kes(x.totalCents), x.discountCents ? kes(x.discountCents) : '', pill(x.status, x.status === 'voided' ? 'warn' : 'good'),
    x.status === 'completed' ? h('span', { class: 'row' }, h('button', { class: 'secondary', onclick: act(null, async () => { const ap = await askApproval('this void'); if (!ap) throw new Error('Not approved.'); const w = input('w'); const ok = await ask('Void this sale', label('Reason', w), [['Void', true, 'danger'], ['Cancel', false, 'secondary']]); if (!ok) throw new Error('Cancelled.'); return api('POST', `/sales/${x.id}/void`, { reason: w.value, approval: ap }); }, { ok: 'Voided.', then: render }) }, 'Void'),
      h('button', { class: 'secondary', onclick: act(null, () => refundDialog(x.id), { then: render }) }, 'Refund')) : '']), [1, 2]) : empty('No sales yet.'));

  // cash movement and close
  const kind = select('kind', [['paid_out', 'Paid out'], ['drop', 'Drop to safe'], ['top_up', 'Top-up']]);
  out.append(h('h2', {}, 'Cash in or out of the drawer'), form([label('What', kind), label('Amount (KES)', input('amount', { required: true, mode: 'decimal' })), label('Reason', input('reason', { required: true }), 'grow')], 'Record', async (v) => { const ap = await askApproval('this cash movement'); if (!ap) throw new Error('Not approved.'); return api('POST', `/till/sessions/${s.id}/movements`, { kind: v.kind, amountCents: toCents(v.amount), reason: v.reason, approval: ap }); }, { ok: 'Recorded.', then: render }));
  out.append(h('h2', {}, 'Close the till'), h('p', { class: 'muted' }, 'Count each drawer and enter what is really there. Any difference needs a reason and is recorded.'),
    form([label('Cash counted (KES)', input('cash', { required: true, mode: 'decimal' })), label('Card slips total (KES)', input('card', { required: true, mode: 'decimal', value: '0' })), label('Mobile money total (KES)', input('mm', { required: true, mode: 'decimal', value: '0' })), label('Reason for any difference', input('why'), 'grow')], 'Close till',
      (v) => api('POST', `/till/sessions/${s.id}/close`, { counted: { cash: toCents(v.cash), card: toCents(v.card), mobile_money: toCents(v.mm) }, varianceReason: v.why || undefined }),
      { ok: (r) => r.totalAbsVarianceCents ? `Closed. Off by KES ${kes(r.totalAbsVarianceCents)}${r.session.signoffRequired ? '; a manager must sign it off.' : '.'}` : 'Closed. The count matches.', then: render, danger: true }));
  mount(shell(out));
}

async function refundDialog(saleId) {
  const { sale } = await api('GET', `/sales/${saleId}`);
  const qs = sale.items.map((i) => ({ i, q: input(`q${i.id}`, { type: 'number', min: 0, max: i.quantity - i.refundedQuantity, value: '0' }) }));
  const method = select('m', sale.payments.map((p) => [p.method, p.method.replace('_', ' ')])), why = input('why', { required: true }), back = h('input', { type: 'checkbox', checked: true });
  const ok = await ask('Refund', h('div', {}, qs.map(({ i, q }) => label(`${i.name} (${i.quantity - i.refundedQuantity} left to refund)`, q)), label('Pay back by', method), label('Reason', why), label('Goods go back on the shelf', back)), [['Next', true], ['Cancel', false, 'secondary']]);
  if (!ok) throw new Error('Cancelled.');
  const items = qs.filter(({ q }) => Number(q.value) > 0).map(({ i, q }) => ({ saleItemId: i.id, quantity: Number(q.value) }));
  if (!items.length) throw new Error('Choose at least one item to refund.');
  const ap = await askApproval('this refund'); if (!ap) throw new Error('Not approved.');
  const r = await api('POST', `/sales/${saleId}/refund`, { items, method: method.value, reason: why.value, restock: back.checked, approval: ap });
  notice(`Refunded KES ${kes(r.amountCents)}.`);
}

// ------------------------------------------------------------------ pay: everyone sees their own; managers see everyone
async function viewPay() {
  const p = { from: monthStart(), to: today() };
  const out = h('div', {}, h('h1', {}, can('payroll.view') ? 'Pay' : 'My pay'));
  const view = h('div', {});
  const from = input('from', { type: 'date', value: p.from }), to = input('to', { type: 'date', value: p.to });
  const load = async () => {
    p.from = from.value; p.to = to.value;
    if (can('payroll.view')) {
      const t = await api('GET', `/payroll/salary?from=${p.from}&to=${p.to}`);
      view.replaceChildren(h('p', {}, pill(t.source === 'locked' ? 'locked run' : 'live, not yet approved', t.source === 'locked' ? 'good' : 'amber')),
        t.rows.length ? table(['Staff', 'Days', 'Retainer', 'Commission', 'Bonus', 'Late', 'Absent', 'Missing hrs', 'Advances', 'Loss', 'Net', 'Pay out', 'Owes back'],
          [...t.rows.map((r) => [r.staffKey, r.daysWorked, kes(r.retainerCents), kes(r.commissionCents), kes(r.bonusesCents), kes(r.lateCents), kes(r.absenceCents), kes(r.missingHoursCents), kes(r.advancesCents), kes(r.lossDeductionsCents), kes(r.netCents), kes(r.payableCents), r.shortfallCents ? kes(r.shortfallCents) : '']),
            [h('strong', {}, 'Total'), '', '', kes(t.totals.commissionCents), '', '', '', '', '', '', kes(t.totals.netCents), kes(t.totals.payableCents), kes(t.totals.shortfallCents)]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) : empty('Nobody is on payroll for this period.'));
    } else {
      const r = await api('GET', `/payroll/staff/${encodeURIComponent(S.me.username)}?from=${p.from}&to=${p.to}`).catch((e) => { if (e.status === 404) return null; throw e; });
      view.replaceChildren(r ? h('div', {}, h('p', {}, pill(r.source === 'locked' ? 'approved' : 'so far this period', r.source === 'locked' ? 'good' : 'amber')),
        h('div', { class: 'card' }, h('dl', { class: 'kv' }, ...[['Days worked', r.item.daysWorked], ['Daily retainer', kes(r.item.retainerCents)], ['Commission', kes(r.item.commissionCents)], ['Bonuses', kes(r.item.bonusesCents)], ['Late', kes(r.item.lateCents)], ['Absent', kes(r.item.absenceCents)], ['Missing hours', kes(r.item.missingHoursCents)], ['Salary advances', kes(r.item.advancesCents)], ['Loss deductions', kes(r.item.lossDeductionsCents)], ['Net pay', kes(r.item.netCents)]].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])))) : empty('You are not on payroll for this period.'));
    }
  };
  out.append(h('div', { class: 'row' }, label('From', from), label('To', to), h('button', { onclick: act(null, load) }, 'Show')), view);
  if (can('attendance.own')) out.append(await clockCard());

  if (can('payroll.view')) {
    const runs = (await api('GET', '/payroll/runs')).runs;
    out.append(h('h2', {}, 'Payroll runs'), runs.length ? table(['Period', 'Status', 'Made by', 'Approved by', 'Paid', ''], runs.map((r) => [`${r.periodStart} to ${r.periodEnd}`, pill(r.status, r.status === 'paid' ? 'good' : r.status === 'approved' ? 'amber' : ''), r.createdBy, r.approvedBy || '', r.paidAt ? when(r.paidAt) : '',
      h('span', { class: 'row' },
        r.status === 'draft' && can('payroll.approve') ? h('button', { onclick: act(null, async () => { if (!(await ask('Approve and lock this run?', h('p', {}, 'After this, the figures for the period can no longer change.'), [['Approve', true], ['Cancel', false, 'secondary']]))) throw new Error('Cancelled.'); return api('POST', `/payroll/runs/${r.id}/approve`); }, { ok: 'Approved and locked.', then: render }) }, 'Approve') : null,
        r.status === 'approved' && can('payroll.pay') ? h('button', { onclick: act(null, async () => { const m = select('m', [['mpesa', 'M-Pesa'], ['bank', 'Bank'], ['cash', 'Cash']]), rf = input('rf'); if (!(await ask('Mark as paid', h('div', {}, label('How', m), label('Payment reference', rf)), [['Mark paid', true], ['Cancel', false, 'secondary']]))) throw new Error('Cancelled.'); return api('POST', `/payroll/runs/${r.id}/pay`, { method: m.value, paymentRef: rf.value || undefined }); }, { ok: 'Marked paid.', then: render }) }, 'Mark paid') : null,
        r.status !== 'draft' ? h('button', { class: 'secondary', onclick: act(null, () => download(`/payroll/runs/${r.id}/export.csv`, `payroll-${r.periodStart}-${r.periodEnd}.csv`)) }, 'CSV') : null)])) : empty('No runs yet.'));
    if (can('payroll.manage')) {
      out.append(h('h2', {}, 'Prepare a run'), form([label('From', input('from', { type: 'date', required: true, value: monthStart() })), label('To', input('to', { type: 'date', required: true, value: today() }))], 'Make draft run', (v) => api('POST', '/payroll/runs', v), { ok: 'Draft made. An admin approves it.', then: render }));
      out.append(h('h2', {}, 'Advance, loss deduction or bonus'), form([label('Staff username', input('staffKey', { required: true })), label('Type', select('type', [['salary_advance', 'Salary advance'], ['loss_deduction', 'Loss deduction'], ['bonus', 'Bonus']])), label('Amount (KES)', input('amount', { required: true, mode: 'decimal' })), label('Date', input('effectiveDate', { type: 'date', required: true, value: today() })), label('Reason', input('reason', { required: true }), 'grow')], 'Record',
        (v) => api('POST', '/payroll/adjustments', { staffKey: v.staffKey, type: v.type, amountCents: toCents(v.amount), effectiveDate: v.effectiveDate, reason: v.reason }), { ok: 'Recorded.', then: load }));
      out.append(h('h2', {}, 'Record an absence'), form([label('Staff username', input('staffKey', { required: true })), label('Date', input('workDate', { type: 'date', required: true, value: today() })), label('Reason', input('reason', { required: true }), 'grow')], 'Record absence', (v) => api('POST', '/payroll/attendance/absences', v), { ok: 'Recorded.', then: load }));
    }
    if (can('payroll.rates')) {
      const plans = (await api('GET', '/payroll/plans')).plans;
      out.append(h('h2', {}, 'Pay rates (admin)'), h('p', { class: 'muted' }, 'A rate is never edited: a change is a new entry from a later date, so past pay stays as it was.'),
        form([label('Staff username', input('staffKey', { required: true })), label('From date', input('effectiveFrom', { type: 'date', required: true, value: today() })), label('Daily retainer (KES)', input('retainer', { required: true, mode: 'decimal' })), label('Commission plan', select('plan', [['', 'None'], ...plans.map((x) => [x.id, x.name])])),
          label('Late fee per hour (KES)', input('late', { mode: 'decimal', value: '0' })), label('Absence fee (KES)', input('absent', { mode: 'decimal', value: '0' })), label('Missing-hour fee (KES)', input('missing', { mode: 'decimal', value: '0' }))], 'Save pay profile',
          (v) => api('POST', '/payroll/profiles', { staffKey: v.staffKey, effectiveFrom: v.effectiveFrom, dailyRetainerCents: toCents(v.retainer), commissionPlanId: v.plan ? Number(v.plan) : undefined, lateFeePerHourCents: toCents(v.late || '0'), absenceFeeCents: toCents(v.absent || '0'), missingHourFeeCents: toCents(v.missing || '0') }), { ok: 'Saved.', then: load }),
        h('h2', {}, 'Commission plans'), plans.length ? table(['Plan', 'Monthly target', 'Below 70%', 'At 70%', 'At 80%+'], plans.map((x) => [x.name, kes(x.targetCents), kes(x.rateBelow70Cents), kes(x.rate70Cents), kes(x.rate80Cents)]), [1, 2, 3, 4]) : empty('No plans yet.'),
        form([label('Plan name', input('name', { required: true })), label('Target (KES)', input('target', { required: true, mode: 'decimal' })), label('Rate below 70% (KES/unit)', input('r0', { mode: 'decimal', value: '0' })), label('At 70%', input('r70', { mode: 'decimal', value: '0' })), label('At 80%+', input('r80', { mode: 'decimal', value: '0' }))], 'Add plan',
          (v) => api('POST', '/payroll/plans', { name: v.name, targetCents: toCents(v.target), rateBelow70Cents: toCents(v.r0), rate70Cents: toCents(v.r70), rate80Cents: toCents(v.r80) }), { ok: 'Plan added.', then: render }));
    }
  }
  mount(shell(out));
  await load().catch(fail);
}

// ------------------------------------------------------------------ discounts report
async function viewDiscounts() {
  const from = input('from', { type: 'date', value: monthStart() }), to = input('to', { type: 'date', value: today() });
  const view = h('div', {});
  const load = async () => {
    const end = new Date(`${to.value}T00:00:00+03:00`); end.setDate(end.getDate() + 1);
    const q = `from=${encodeURIComponent(new Date(`${from.value}T00:00:00+03:00`).toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
    const [d, r] = await Promise.all([api('GET', `/reports/discounts?${q}`), api('GET', `/reports/risky-actions?${q}`)]);
    view.replaceChildren(h('h2', {}, 'Discounts by person'), d.rows.length ? table(['Cashier', 'Sales', 'Gross', 'Discount', 'Of gross', 'Discounted sales', 'Approved', 'Reasons'], d.rows.map((x) => [x.cashier, x.sales, kes(x.grossCents), kes(x.discountCents), pill(pct(x.discountBp), x.discountBp > 1000 ? 'warn' : ''), x.discountedSales, x.approvedSales, x.byReason.map((b) => `${b.reason.replace(/_/g, ' ')} ${kes(b.discountCents)}`).join(', ')]), [1, 2, 3, 5, 6]) : empty('No sales in this period.'),
      h('h2', {}, 'Risky actions by person'), r.rows.length ? table(['Person', 'Voids', 'Refunds', 'Discounts', 'Paid out', 'Drops', 'Till off by', 'Sign-offs needed', 'Risk'], r.rows.map((x) => [x.actor, `${x.voids.count} (${kes(x.voids.cents)})`, `${x.refunds.count} (${kes(x.refunds.cents)})`, `${x.discounts.count} (${kes(x.discounts.cents)})`, `${x.paidOuts.count} (${kes(x.paidOuts.cents)})`, `${x.drops.count} (${kes(x.drops.cents)})`, kes(x.tillVarianceCents), x.sessionsNeedingSignoff, x.riskScore]), [8]) : empty('Nothing to show.'));
  };
  mount(shell(h('div', {}, h('h1', {}, 'Discounts and risky actions'), h('div', { class: 'row' }, label('From', from), label('To', to), h('button', { onclick: act(null, load) }, 'Show')), view)));
  await load().catch(fail);
}

render();
