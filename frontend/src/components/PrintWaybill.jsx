import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { receiptsApi } from '../api/endpoints';
import { useToast } from '../context/UIContext';
import { getErrorMessage } from '../api/client';

// The parcel label: who it is for, what is in it, how much the rider collects, and a QR code holding the order's
// payment code (UT000123), so a returned parcel can be matched to its order by scanning. It is laid out for the same
// 80mm roll as the receipt and printed through the same print-root CSS. Like the receipt, everything is drawn as React
// text and SVG rects (the QR modules are drawn, never pasted in as markup), so a customer's name can never run as script.

const kes = (cents) => {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString('en-KE', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
};
const rule = { borderTop: '1px dashed #000', margin: '6px 0' };
const row = { display: 'flex', justifyContent: 'space-between', gap: 8 };

/** The QR as an SVG made of squares. The text is the order reference, nothing else. */
export function QrCode({ text, size = 110 }) {
  const qr = useMemo(() => QRCode.create(String(text), { errorCorrectionLevel: 'M' }), [text]);
  const n = qr.modules.size;
  const cells = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (qr.modules.get(x, y)) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" />);
    }
  }
  return (
    <svg role="img" aria-label={`QR code for ${text}`} viewBox={`-2 -2 ${n + 4} ${n + 4}`} width={size} height={size}
      shapeRendering="crispEdges" fill="#000" style={{ background: '#fff' }}>
      {cells}
    </svg>
  );
}

/** What the rider takes at the door: nothing if paid (or cancelled), the balance otherwise. Cents. */
export function amountToCollect(data) {
  if (data.status === 'cancelled') return 0;
  return Math.max(Number(data.totals?.balance) || 0, 0);
}

/** `data` is the order receipt from GET /orders/:id/receipt. */
export function WaybillView({ data, printedAt = new Date() }) {
  const due = amountToCollect(data);
  const items = data.items || [];
  const units = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const courierName = data.delivery?.courier_name || (data.delivery?.courier_type === 'g4s' ? 'G4S' : data.delivery?.courier_type === 'boda' ? 'Boda' : '');
  return (
    <div style={{ width: '72mm', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.35 }}>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 15 }}>{data.business?.name}</div>
      <div style={{ textAlign: 'center', fontWeight: 700 }}>DELIVERY WAYBILL</div>
      <div style={rule} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <QrCode text={data.reference} />
        <div>
          <div style={{ fontSize: 11 }}>Order</div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{data.reference}</div>
          <div style={{ fontSize: 11 }}>{printedAt.toLocaleDateString('en-KE', { dateStyle: 'medium' })}</div>
        </div>
      </div>
      <div style={rule} />
      <div style={{ fontWeight: 700 }}>Deliver to</div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{data.customer?.name}</div>
      <div style={{ fontSize: 14 }}>{data.customer?.phone}</div>
      {data.customer?.city && <div>{data.customer.city}</div>}
      <div style={rule} />
      <div style={{ fontWeight: 700 }}>{units} item{units === 1 ? '' : 's'}</div>
      {items.map((i, k) => (<div key={k} style={row}><span>{i.name}</span><span>× {i.quantity}</span></div>))}
      <div style={rule} />
      {due > 0 ? (
        <div style={{ ...row, fontWeight: 700, fontSize: 15 }}><span>COLLECT</span><span>{data.business?.currency || 'KES'} {kes(due)}</span></div>
      ) : (
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 15 }}>PAID: collect nothing</div>
      )}
      {courierName && <div>Rider: {courierName}{data.delivery?.courier_phone ? ` · ${data.delivery.courier_phone}` : ''}</div>}
      <div style={rule} />
      <div style={{ textAlign: 'center', fontSize: 11 }}>If the customer does not take the parcel, bring it back with this label.</div>
    </div>
  );
}

function WaybillHost({ data, onDone }) {
  useEffect(() => {
    if (!data) return undefined;
    const finish = () => onDone();
    window.addEventListener('afterprint', finish, { once: true });
    // One frame so the portal is laid out before the dialog snapshots the page.
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', finish); };
  }, [data, onDone]);
  if (!data) return null;
  return createPortal(<div className="print-root"><WaybillView data={data} /></div>, document.body);
}

/**
 * <PrintWaybillButton orderId={42} status="awaiting_dispatch" /> — fetches the server-composed order receipt (so the
 * label always shows the current balance and rider) and prints it. Hidden for a cancelled order.
 */
export default function PrintWaybillButton({ orderId, status, label = 'Waybill', className = '' }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  if (status === 'cancelled') return null;

  async function handleClick() {
    setBusy(true);
    try {
      const res = await receiptsApi.order(orderId);
      setData(res.data.data);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not load the waybill.'));
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
      <WaybillHost data={data} onDone={() => setData(null)} />
    </>
  );
}
