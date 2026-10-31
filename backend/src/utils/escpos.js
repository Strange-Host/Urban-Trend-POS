// Turns a receipt (services/receipts.service.js) into ESC/POS bytes for an 80 mm thermal printer: text, bold/centered
// headings, a paper cut, and the pulse that opens a cash drawer wired to the printer. Pure function, no hardware here.
//
// Printers speak a single-byte code page, not Unicode, so text is reduced to plain ASCII (accents dropped, anything else
// becomes "?"). Prices are KES, so nothing is lost in practice.

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  init: [ESC, 0x40],
  left: [ESC, 0x61, 0], center: [ESC, 0x61, 1],
  boldOn: [ESC, 0x45, 1], boldOff: [ESC, 0x45, 0],
  big: [GS, 0x21, 0x11], normal: [GS, 0x21, 0x00],      // double width + height / back to normal
  feed: (n) => [ESC, 0x64, n],
  cut: [GS, 0x56, 0x42, 0x00],                          // feed to the cutter, then partial cut
  drawer: [ESC, 0x70, 0x00, 0x19, 0xfa],                // pin 2, ~50 ms on / ~500 ms off
};

function ascii(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/×/g, 'x')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?');
}

const money = (cents) => {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString('en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
};

function wrap(text, cols) {
  const words = ascii(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (let word of words) {
    while (word.length > cols) { // a single word longer than the line
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cols));
      word = word.slice(cols);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= cols) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// "left ........ right" on one line; the left side is cut short rather than pushing the amount off the paper.
function pair(left, right, cols) {
  const r = ascii(right);
  const l = ascii(left).slice(0, Math.max(cols - r.length - 1, 0));
  return l + ' '.repeat(Math.max(cols - l.length - r.length, 1)) + r;
}

/**
 * @param {object} receipt  from receipts.service forSale / forOrder
 * @param {{cols?: number, cut?: boolean, drawer?: boolean}} opts
 *   cols: characters per line (48 for a typical 80 mm roll, 32 for 58 mm); cut: cut the paper after printing;
 *   drawer: also open the cash drawer.
 * @returns {Buffer}
 */
function receiptToEscPos(receipt, { cols = 48, cut = true, drawer = false } = {}) {
  cols = Math.min(Math.max(Math.round(cols) || 48, 20), 64);
  const out = [];
  const bytes = (b) => out.push(Buffer.from(b));
  const text = (s = '') => out.push(Buffer.from(`${s}\n`, 'latin1'));
  const rule = () => text('-'.repeat(cols));
  const isOrder = receipt.kind === 'order';
  const b = receipt.business || {};

  bytes(CMD.init);
  if (drawer) bytes(CMD.drawer); // first, so the drawer opens while the receipt prints

  bytes(CMD.center);
  bytes(CMD.boldOn); bytes(CMD.big);
  wrap(b.name || 'Receipt', Math.floor(cols / 2)).forEach(text);
  bytes(CMD.normal); bytes(CMD.boldOff);
  [b.address, b.phone, b.pin && `PIN: ${b.pin}`].filter(Boolean).forEach((l) => wrap(l, cols).forEach(text));

  bytes(CMD.left);
  rule();
  text(pair(isOrder ? 'Order' : 'Receipt', receipt.reference, cols));
  const d = new Date(`${String(receipt.dispatched_at || receipt.created_at || '').replace(' ', 'T')}Z`);
  if (!Number.isNaN(d.getTime())) text(ascii(d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' })));
  if (receipt.status === 'voided') { bytes(CMD.boldOn); text('*** VOIDED ***'); bytes(CMD.boldOff); }
  if (!isOrder && receipt.cashier) text(`Served by: ${ascii(receipt.cashier)}`);

  if (isOrder && receipt.customer) {
    rule();
    bytes(CMD.boldOn); text('Deliver to'); bytes(CMD.boldOff);
    text(ascii(receipt.customer.name));
    text(ascii([receipt.customer.phone, receipt.customer.city].filter(Boolean).join(' - ')));
    const courier = receipt.delivery?.courier_name || (receipt.delivery?.courier_type === 'g4s' ? 'G4S' : receipt.delivery?.courier_type === 'boda' ? 'Boda' : '');
    if (courier) text(ascii(`Courier: ${courier}${receipt.delivery.courier_phone ? ` - ${receipt.delivery.courier_phone}` : ''}`));
  }

  rule();
  for (const it of receipt.items || []) {
    wrap(it.name, cols).forEach(text);
    text(pair(`  ${it.quantity} x ${money(it.unit_price)}`, money(it.line_total), cols));
  }
  rule();

  const t = receipt.totals || {};
  if (t.discount > 0) text(pair('Discount', `-${money(t.discount)}`, cols));
  if (isOrder && receipt.delivery?.fee > 0) text(pair('Delivery', money(receipt.delivery.fee), cols));
  bytes(CMD.boldOn);
  text(pair('TOTAL', `${b.currency || 'KES'} ${money(t.total)}`, cols));
  bytes(CMD.boldOff);
  text(pair('Paid', money(t.paid), cols));
  if (t.balance > 0) { bytes(CMD.boldOn); text(pair('BALANCE DUE', money(t.balance), cols)); bytes(CMD.boldOff); }
  if (!isOrder) {
    for (const p of receipt.payments || []) {
      text(pair(String(p.method).replace('_', ' ').replace(/^./, (c) => c.toUpperCase()), money(p.amount), cols));
      if (p.reference) text(`  Ref: ${ascii(p.reference)}`);
    }
  }

  if (isOrder && receipt.payment?.show) {
    rule();
    bytes(CMD.boldOn); text('HOW TO PAY'); bytes(CMD.boldOff);
    if (receipt.payment.paybill) text(`Paybill: ${ascii(receipt.payment.paybill)}`);
    text(`Account: ${ascii(receipt.payment.account)}`);
  }
  if (receipt.notes) { rule(); wrap(`Note: ${receipt.notes}`, cols).forEach(text); }

  rule();
  bytes(CMD.center);
  wrap(b.footer || 'Thank you.', cols).forEach(text);
  bytes(CMD.feed(cut ? 4 : 6));
  if (cut) bytes(CMD.cut);

  return Buffer.concat(out);
}

// A drawer-only job (for a "No sale / open drawer" action).
function drawerKick() {
  return Buffer.from([...CMD.init, ...CMD.drawer]);
}

module.exports = { receiptToEscPos, drawerKick, ascii };
