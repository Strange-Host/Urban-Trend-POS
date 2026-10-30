const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// Turns a report document into an Excel workbook or a PDF. A document is
//   { title, subtitle, business, sections: [{ heading, note?, columns: [{ key, header, type }], rows, totals? }] }
// where type is 'text' | 'int' | 'money' | 'percent' | 'date'. Money arrives in integer cents and is
// shown in KES; percent arrives already as a number (12.5 = 12.5%). Missing values show as a dash.

const kes = (cents) => ((cents === 0 ? 0 : cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function display(value, type) {
  if (value === null || value === undefined || value === '') return '-';
  if (type === 'money') return kes(value);
  if (type === 'percent') return `${value}%`;
  if (type === 'int') return Number(value).toLocaleString('en-KE');
  return String(value);
}

// Excel sheet names: max 31 chars, none of : \ / ? * [ ]
const sheetName = (s, i) => (String(s).replace(/[:\\/?*[\]]/g, ' ').slice(0, 28).trim() || `Sheet ${i + 1}`);

async function toXlsx(doc) {
  const wb = new ExcelJS.Workbook();
  wb.creator = doc.business || 'Urban Trends POS';
  wb.created = new Date();
  const used = new Set();

  doc.sections.forEach((section, i) => {
    let name = sheetName(section.heading, i);
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 26)} ${i + 1}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);

    ws.addRow([doc.title]).font = { bold: true, size: 14 };
    ws.addRow([[doc.business, doc.subtitle].filter(Boolean).join('  |  ')]).font = { color: { argb: 'FF666666' } };
    if (section.note) ws.addRow([section.note]).font = { italic: true, color: { argb: 'FF666666' } };
    ws.addRow([]);

    const header = ws.addRow(section.columns.map((c) => c.header));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }; });

    const addData = (row, bold) => {
      const r = ws.addRow(section.columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined || v === '') return null;
        if (c.type === 'money') return v / 100;          // KES, not cents
        return v;
      }));
      section.columns.forEach((c, idx) => {
        const cell = r.getCell(idx + 1);
        if (c.type === 'money') cell.numFmt = '#,##0.00;[Red]-#,##0.00';
        if (c.type === 'int') cell.numFmt = '#,##0';
        if (c.type === 'percent') cell.numFmt = '0.0"%"';
      });
      if (bold) r.font = { bold: true };
    };
    section.rows.forEach((row) => addData(row, false));
    if (section.totals) addData(section.totals, true);

    section.columns.forEach((c, idx) => {
      const widest = Math.max(c.header.length, ...section.rows.slice(0, 200).map((r) => display(r[c.key], c.type).length), 8);
      ws.getColumn(idx + 1).width = Math.min(widest + 3, 48);
    });
    ws.views = [{ state: 'frozen', ySplit: header.number }];
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPdf(doc) {
  return new Promise((resolve, reject) => {
    const widest = Math.max(...doc.sections.map((s) => s.columns.length));
    const pdf = new PDFDocument({ size: 'A4', layout: widest > 6 ? 'landscape' : 'portrait', margin: 36, info: { Title: doc.title } });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = pdf.page.margins.left;
    const usable = () => pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
    const bottom = () => pdf.page.height - pdf.page.margins.bottom;

    pdf.font('Helvetica-Bold').fontSize(16).text(doc.title, left, pdf.y);
    pdf.font('Helvetica').fontSize(9).fillColor('#666666').text([doc.business, doc.subtitle].filter(Boolean).join('  |  '));
    pdf.text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    pdf.fillColor('#000000').moveDown(0.8);

    for (const section of doc.sections) {
      if (pdf.y > bottom() - 90) pdf.addPage();
      pdf.font('Helvetica-Bold').fontSize(11).text(section.heading, left, pdf.y);
      if (section.note) pdf.font('Helvetica-Oblique').fontSize(8).fillColor('#666666').text(section.note).fillColor('#000000');
      pdf.moveDown(0.3);

      // Numeric columns get what their header and typical value need (a header word never splits);
      // text columns share what is left. If it still does not fit, everything scales down evenly.
      const cols = section.columns;
      pdf.font('Helvetica-Bold').fontSize(8);
      const isText = (c) => c.type === 'text' || c.type === 'date';
      const need = cols.map((c) => {
        if (isText(c)) return 0;
        const longestWord = Math.max(...c.header.split(/\s+/).map((word) => pdf.widthOfString(word)));
        return Math.max(longestWord + 10, c.type === 'money' ? 62 : c.type === 'percent' ? 44 : 34);
      });
      const textCount = cols.filter(isText).length;
      const left_over = usable() - need.reduce((a, b) => a + b, 0);
      const textW = textCount ? Math.max(left_over / textCount, 60) : 0;
      const widths = cols.map((c, i) => (isText(c) ? textW : need[i]));
      const scale = usable() / widths.reduce((a, b) => a + b, 0);
      const w = widths.map((x) => x * scale);

      const drawRow = (values, { bold = false, fill = null, color = '#000000' } = {}) => {
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        const height = Math.max(...values.map((v, i) => pdf.heightOfString(v, { width: w[i] - 6 }))) + 6;
        if (pdf.y + height > bottom()) { pdf.addPage(); drawHeader(); pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8); }
        const y = pdf.y;
        if (fill) pdf.rect(left, y, usable(), height).fill(fill);
        pdf.fillColor(color);
        let x = left;
        values.forEach((v, i) => {
          const right = cols[i].type !== 'text' && cols[i].type !== 'date';
          pdf.text(v, x + 3, y + 3, { width: w[i] - 6, align: right ? 'right' : 'left' });
          x += w[i];
        });
        pdf.fillColor('#000000');
        pdf.y = y + height;
      };
      const drawHeader = () => drawRow(cols.map((c) => c.header), { bold: true, fill: '#1F2937', color: '#FFFFFF' });

      drawHeader();
      section.rows.forEach((row, idx) => drawRow(cols.map((c) => display(row[c.key], c.type)), { fill: idx % 2 ? '#F3F4F6' : null }));
      if (section.totals) drawRow(cols.map((c) => display(section.totals[c.key], c.type)), { bold: true, fill: '#E5E7EB' });
      if (!section.rows.length) pdf.font('Helvetica-Oblique').fontSize(8).text('No data for this period.', left + 3);
      pdf.moveDown(1);
    }
    pdf.end();
  });
}

module.exports = { toXlsx, toPdf, display, kes };
