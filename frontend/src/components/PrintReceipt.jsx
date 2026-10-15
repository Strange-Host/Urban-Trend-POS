import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { receiptsApi } from '../api/endpoints';
import { useToast } from '../context/UIContext';
import { getErrorMessage } from '../api/client';

// Every value below is rendered as a React text node — never as HTML. The older
// system built its receipt by pasting customer names into an HTML string and
// document.write()-ing it, which let a crafted name run script in a staff
// member's browser. Here "<script>" in a name simply prints as the characters.

function kes(cents) {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString('en-KE', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

// SQLite datetimes are UTC with no zone marker.
function when(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

const rule = { borderTop: '1px dashed #000', margin: '6px 0' };
const row = { display: 'flex', justifyContent: 'space-between', gap: 8 };

export function ReceiptView({ data }) {
  const { business, totals } = data;
  const isOrder = data.kind === 'order';
  return (
    <div style={{ width: '72mm', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.35 }}>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 15 }}>{business.name}</div>
      {business.address && <div style={{ textAlign: 'center' }}>{business.address}</div>}
      {business.phone && <div style={{ textAlign: 'center' }}>{business.phone}</div>}
      <div style={rule} />

      <div style={row}><span>{isOrder ? 'Order' : 'Receipt'}</span><strong>{data.reference}</strong></div>
      <div>{when(data.dispatched_at || data.created_at)}</div>
      {data.status === 'voided' && <div style={{ fontWeight: 700 }}>*** VOIDED ***</div>}
      {!isOrder && data.cashier && <div>Served by: {data.cashier}</div>}

      {isOrder && (
        <>
          <div style={rule} />
          <div style={{ fontWeight: 700 }}>{isOrder ? 'Deliver to' : ''}</div>
          <div>{data.customer.name}</div>
          <div>{data.customer.phone}{data.customer.city ? ` · ${data.customer.city}` : ''}</div>
          {(data.delivery.courier_name || data.delivery.courier_type) && (
            <div>
              Courier: {data.delivery.courier_name || (data.delivery.courier_type === 'g4s' ? 'G4S' : 'Boda')}
              {data.delivery.courier_phone ? ` · ${data.delivery.courier_phone}` : ''}
            </div>
          )}
        </>
      )}

      <div style={rule} />
      {data.items.map((it, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div>{it.name}</div>
          <div style={row}><span>{it.quantity} × {kes(it.unit_price)}</span><span>{kes(it.line_total)}</span></div>
        </div>
      ))}
      <div style={rule} />

      {totals.discount > 0 && <div style={row}><span>Discount</span><span>-{kes(totals.discount)}</span></div>}
      {isOrder && data.delivery.fee > 0 && <div style={row}><span>Delivery</span><span>{kes(data.delivery.fee)}</span></div>}
      <div style={{ ...row, fontWeight: 700, fontSize: 14 }}><span>TOTAL</span><span>{business.currency} {kes(totals.total)}</span></div>
      <div style={row}><span>Paid</span><span>{kes(totals.paid)}</span></div>
      {totals.balance > 0 && <div style={{ ...row, fontWeight: 700 }}><span>BALANCE DUE</span><span>{kes(totals.balance)}</span></div>}
      {!isOrder && data.payments?.map((p, i) => (
        <div key={i} style={row}><span style={{ textTransform: 'capitalize' }}>{String(p.method).replace('_', ' ')}</span><span>{kes(p.amount)}</span></div>
      ))}

      {isOrder && data.payment?.show && (
        <>
          <div style={rule} />
          <div style={{ fontWeight: 700 }}>HOW TO PAY</div>
          {data.payment.paybill && <div>Paybill: <strong>{data.payment.paybill}</strong></div>}
          <div>Account: <strong>{data.payment.account}</strong></div>
        </>
      )}

      {data.notes && (<><div style={rule} /><div>Note: {data.notes}</div></>)}
      <div style={rule} />
      <div style={{ textAlign: 'center' }}>{business.footer}</div>
    </div>
  );
}

// Mounts the receipt in a portal on <body> (the print CSS hides everything else),
// opens the browser print dialog, then removes it again.
export function PrintReceiptHost({ data, onDone }) {
  useEffect(() => {
    if (!data) return undefined;
    const finish = () => onDone();
    window.addEventListener('afterprint', finish, { once: true });
    // One frame so the portal is laid out before the dialog snapshots the page.
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', finish); };
  }, [data, onDone]);

  if (!data) return null;
  return createPortal(<div className="print-root"><ReceiptView data={data} /></div>, document.body);
}

/**
 * <PrintReceiptButton kind="order" id={42} /> — fetches the server-composed
 * receipt (so cashiers need no Settings access) and prints it.
 */
export default function PrintReceiptButton({ kind, id, label = 'Print receipt', className = '' }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      const res = await (kind === 'sale' ? receiptsApi.sale(id) : receiptsApi.order(id));
      setData(res.data.data);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not load the receipt.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={handleClick} disabled={busy}
        className={className || 'px-3 py-2 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50'}>
        {busy ? 'Preparing…' : label}
      </button>
      <PrintReceiptHost data={data} onDone={() => setData(null)} />
    </>
  );
}
