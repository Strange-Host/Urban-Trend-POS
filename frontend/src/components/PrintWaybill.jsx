import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';

// The parcel label: who it is for, what is in it, how much to collect, and a QR code that holds the order reference, so a
// returned parcel can be scanned in. It is laid out for the same 80mm roll as the receipt and printed through the same host.
// Everything is drawn as React text and SVG rects (the QR modules are drawn, never pasted in as markup), so a customer's name
// can never run as script.

const kes = (cents) => ((Number(cents) || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const rule = { borderTop: '1px dashed #000', margin: '6px 0' };
const row = { display: 'flex', justifyContent: 'space-between', gap: 8 };

/** The QR as an SVG made of squares. The text is the order reference (UT-XXXXXXXX), nothing else. */
export function QrCode({ text, size = 120 }) {
  const qr = useMemo(() => QRCode.create(String(text), { errorCorrectionLevel: 'M' }), [text]);
  const n = qr.modules.size;
  const cells = [];
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (qr.modules.get(x, y)) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" />);
  return (
    <svg role="img" aria-label={`QR code for ${text}`} viewBox={`-2 -2 ${n + 4} ${n + 4}`} width={size} height={size} shapeRendering="crispEdges" fill="#000" style={{ background: '#fff' }}>
      {cells}
    </svg>
  );
}

/** What the rider takes at the door: nothing if paid, the balance otherwise. */
export function amountToCollect(order) {
  return order.status === 'cancelled' ? 0 : Math.max(Number(order.outstanding) || 0, 0);
}

export function WaybillView({ order, businessName = 'Urban Trends', printedAt = new Date() }) {
  const due = amountToCollect(order);
  const units = (order.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  return (
    <div style={{ width: '72mm', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.35 }}>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 15 }}>{businessName}</div>
      <div style={{ textAlign: 'center', fontWeight: 700 }}>DELIVERY WAYBILL</div>
      <div style={rule} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <QrCode text={order.id} size={110} />
        <div>
          <div style={{ fontSize: 11 }}>Order</div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{order.id}</div>
          <div style={{ fontSize: 11 }}>{printedAt.toLocaleDateString('en-KE', { dateStyle: 'medium' })}</div>
        </div>
      </div>
      <div style={rule} />
      <div style={{ fontWeight: 700 }}>Deliver to</div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{order.customer?.name}</div>
      <div style={{ fontSize: 14 }}>{order.customer?.phone}</div>
      {order.customer?.city && <div>{order.customer.city}</div>}
      <div style={rule} />
      <div style={{ fontWeight: 700 }}>{units} item{units === 1 ? '' : 's'}</div>
      {(order.items || []).map((i, k) => (<div key={k} style={row}><span>{i.product_name}</span><span>× {i.quantity}</span></div>))}
      <div style={rule} />
      {due > 0 ? (
        <div style={{ ...row, fontWeight: 700, fontSize: 15 }}><span>COLLECT</span><span>KES {kes(due)}</span></div>
      ) : (
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 15 }}>PAID: collect nothing</div>
      )}
      {order.courier?.name && <div>Rider: {order.courier.name}</div>}
      <div style={rule} />
      <div style={{ textAlign: 'center', fontSize: 11 }}>If the customer does not take the parcel, bring it back with this label.</div>
    </div>
  );
}

/** A waybill can be printed from the moment an order exists, and again at dispatch (the rider and the balance are then known). */
export default function PrintWaybillButton({ order, businessName, label = 'Waybill', className = '' }) {
  const [data, setData] = useState(null);
  if (!order || order.status === 'cancelled') return null;
  return (
    <>
      <button type="button" onClick={() => setData(order)}
        className={className || 'px-3 py-2 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50'}>
        {label}
      </button>
      <WaybillHost order={data} businessName={businessName} onDone={() => setData(null)} />
    </>
  );
}

function WaybillHost({ order, businessName, onDone }) {
  useEffect(() => {
    if (!order) return undefined;
    const finish = () => onDone();
    window.addEventListener('afterprint', finish, { once: true });
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', finish); };
  }, [order, onDone]);
  if (!order) return null;
  return createPortal(<div className="print-root"><WaybillView order={order} businessName={businessName} /></div>, document.body);
}
