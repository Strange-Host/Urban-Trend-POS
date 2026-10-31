const PDFDocument = require('pdfkit');
const { kes } = require('./reportExport');

// A one-page A4 invoice built from the same server-composed data as the receipt
// (services/receipts.service.js), so the two can never disagree. Plain text only.
function invoicePdf(data) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${data.reference}` } });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const { business, totals } = data;
    const left = pdf.page.margins.left;
    const width = pdf.page.width - left - pdf.page.margins.right;
    const money = (c) => kes(c);
    const day = (ts) => (ts ? String(ts).slice(0, 10) : '');

    pdf.font('Helvetica-Bold').fontSize(20).text(business.name, left, 48);
    pdf.font('Helvetica').fontSize(9).fillColor('#555555');
    for (const line of [business.address, business.phone && `Tel: ${business.phone}`, business.pin && `PIN: ${business.pin}`].filter(Boolean)) pdf.text(line);

    pdf.fillColor('#000000').font('Helvetica-Bold').fontSize(22).text('INVOICE', left, 48, { width, align: 'right' });
    pdf.font('Helvetica').fontSize(10)
      .text(`No: ${data.reference}`, { width, align: 'right' })
      .text(`Date: ${day(data.dispatched_at || data.created_at)}`, { width, align: 'right' });
    if (data.status) pdf.text(`Status: ${String(data.status).replace(/_/g, ' ')}`, { width, align: 'right' });

    pdf.moveDown(2);
    if (data.customer && (data.customer.name || data.customer.phone)) {
      pdf.font('Helvetica-Bold').fontSize(10).text('Bill to', left);
      pdf.font('Helvetica').text([data.customer.name, data.customer.phone, data.customer.city].filter(Boolean).join('\n'));
      pdf.moveDown(1);
    } else if (data.cashier) {
      pdf.font('Helvetica').fontSize(10).text(`Served by: ${data.cashier}`, left);
      pdf.moveDown(1);
    }

    // Items table: description | qty | unit price | amount
    const cols = [width - 3 * 90, 60, 90, 90].map((w, i, a) => (i === 0 ? a[0] : w));
    const heads = ['Description', 'Qty', 'Unit price', 'Amount'];
    const row = (cells, opts = {}) => {
      pdf.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
      const h = Math.max(...cells.map((c, i) => pdf.heightOfString(String(c), { width: cols[i] - 8 }))) + 8;
      if (pdf.y + h > pdf.page.height - pdf.page.margins.bottom - 120) { pdf.addPage(); }
      const y = pdf.y;
      if (opts.fill) pdf.rect(left, y, width, h).fill(opts.fill);
      pdf.fillColor(opts.color || '#000000');
      let x = left;
      cells.forEach((c, i) => { pdf.text(String(c), x + 4, y + 4, { width: cols[i] - 8, align: i === 0 ? 'left' : 'right' }); x += cols[i]; });
      pdf.fillColor('#000000');
      pdf.y = y + h;
      pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor('#DDDDDD').lineWidth(0.5).stroke();
    };
    row(heads, { bold: true, fill: '#1F2937', color: '#FFFFFF' });
    for (const it of data.items) row([it.name, it.quantity, money(it.unit_price), money(it.line_total)]);

    pdf.moveDown(1);
    const total = (label, value, bold = false) => {
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10);
      const y = pdf.y;
      pdf.text(label, left + width - 260, y, { width: 150, align: 'left' });
      pdf.text(value, left + width - 110, y, { width: 110, align: 'right' });
      pdf.y = y + (bold ? 18 : 15);
    };
    total('Subtotal', `${business.currency} ${money(totals.subtotal)}`);
    if (totals.discount > 0) total('Discount', `-${money(totals.discount)}`);
    if (data.delivery && data.delivery.fee > 0) total('Delivery', money(data.delivery.fee));
    total('TOTAL', `${business.currency} ${money(totals.total)}`, true);
    total('Paid', money(totals.paid));
    if (totals.balance > 0) total('BALANCE DUE', `${business.currency} ${money(totals.balance)}`, true);

    if (data.payment?.show) {
      pdf.moveDown(1).font('Helvetica-Bold').fontSize(10).text('How to pay', left);
      pdf.font('Helvetica').text([data.payment.paybill && `Paybill: ${data.payment.paybill}`, `Account: ${data.payment.account}`].filter(Boolean).join('\n'));
    }
    if (data.notes) pdf.moveDown(1).font('Helvetica').fontSize(9).text(`Note: ${data.notes}`, left);
    pdf.fontSize(9).fillColor('#666666').text(business.footer, left, pdf.page.height - 80, { width, align: 'center' });
    pdf.end();
  });
}

module.exports = { invoicePdf };
