import { useState } from 'react';
import Sheet from './Sheet';

// Two small forms for the Orders page on the new server. Both are plain controlled forms inside the shared Sheet.

const field = 'w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none text-sm';
const primary = 'px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50';
const secondary = 'px-4 py-2.5 rounded-lg border border-line text-sm font-medium hover:border-text-muted';

export const OUTCOMES = [
  { value: 'delivered', label: 'Delivered', help: 'The customer has the parcel.' },
  { value: 'rescheduled', label: 'Try again on another day', help: 'The courier will make another attempt.' },
  { value: 'not_claimed', label: 'Not claimed', help: 'Nobody collected it. The parcel is on its way back.' },
  { value: 'refused', label: 'Refused', help: 'The customer turned it down. The parcel is on its way back.' },
];

/** What happened to a parcel that is out for delivery. Anything other than "delivered" needs a reason; "try again" needs the new date. */
export function OutcomeSheet({ order, onClose, onSubmit }) {
  const [outcome, setOutcome] = useState('delivered');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const needsReason = outcome !== 'delivered';
  const ready = (!needsReason || reason.trim()) && (outcome !== 'rescheduled' || /^\d{4}-\d{2}-\d{2}$/.test(date));

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try { await onSubmit({ outcome, reason: reason.trim() || undefined, rescheduleFor: outcome === 'rescheduled' ? date : undefined }); onClose(); } finally { setBusy(false); }
  }

  return (
    <Sheet onClose={onClose} size="sm" as="form" onSubmit={submit} label="Delivery outcome">
      <h3 className="font-display font-700 text-lg mb-1">Delivery outcome</h3>
      <p className="text-xs text-text-muted mb-4 font-mono">{order.product_code} · {order.customer?.name}</p>
      <div className="space-y-2 mb-4">
        {OUTCOMES.map((o) => (
          <label key={o.value} className={`flex gap-3 items-start p-3 rounded-lg border cursor-pointer ${outcome === o.value ? 'border-accent bg-accent/10' : 'border-line'}`}>
            <input type="radio" name="outcome" value={o.value} checked={outcome === o.value} onChange={() => setOutcome(o.value)} className="mt-1" />
            <span><span className="block text-sm font-medium">{o.label}</span><span className="block text-xs text-text-muted">{o.help}</span></span>
          </label>
        ))}
      </div>
      {outcome === 'rescheduled' && (
        <label className="block mb-3 text-sm">New delivery date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${field} mt-1`} />
        </label>
      )}
      {needsReason && (
        <label className="block mb-4 text-sm">What happened?
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. phone off, customer not at the address" className={`${field} mt-1`} />
        </label>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onClose} className={secondary}>Cancel</button>
        <button type="submit" disabled={!ready || busy} className={primary}>Save outcome</button>
      </div>
    </Sheet>
  );
}

/**
 * The parcel of a failed delivery is physically back: count what came back, line by line. Goods that are neither restocked nor
 * damaged are recorded as missing and need a note. The unpaid part of the order is taken off sales; money the customer already paid is
 * kept as their credit (the server reports it).
 */
export function ReturnParcelSheet({ order, onClose, onSubmit }) {
  const [counts, setCounts] = useState(() => Object.fromEntries(order.items.map((i) => [i.id, { restock: i.quantity, damaged: 0 }])));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const set = (id, key, v) => setCounts((c) => ({ ...c, [id]: { ...c[id], [key]: num(v) } }));
  const rows = order.items.map((i) => {
    const c = counts[i.id];
    const over = c.restock + c.damaged > i.quantity;
    return { ...i, ...c, over, missing: over ? 0 : i.quantity - c.restock - c.damaged };
  });
  const anyOver = rows.some((r) => r.over);
  const anyMissing = rows.some((r) => r.missing > 0);
  const ready = !anyOver && (!anyMissing || notes.trim());

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onSubmit({
        items: rows.map((r) => ({ orderItemId: r.id, restockQuantity: r.restock, damagedQuantity: r.damaged })),
        notes: notes.trim() || undefined,
      });
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <Sheet onClose={onClose} size="md" as="form" onSubmit={submit} label="Count in the returned parcel">
      <h3 className="font-display font-700 text-lg mb-1">Count in the returned parcel</h3>
      <p className="text-xs text-text-muted mb-4">Check each line against what actually came back. Restocked goods go back on the shelf.</p>
      <div className="space-y-3 mb-4">
        {rows.map((r) => (
          <div key={r.id} className="border border-line rounded-lg p-3">
            <div className="flex justify-between text-sm mb-2"><span className="font-medium truncate pr-2">{r.product_name}</span><span className="font-mono text-text-muted">sent {r.quantity}</span></div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <label>Restock
                <input type="number" min="0" value={r.restock} onChange={(e) => set(r.id, 'restock', e.target.value)} className={`${field} mt-1`} />
              </label>
              <label>Damaged
                <input type="number" min="0" value={r.damaged} onChange={(e) => set(r.id, 'damaged', e.target.value)} className={`${field} mt-1`} />
              </label>
              <div>Missing<div className={`mt-1 px-3.5 py-2.5 rounded-lg bg-paper font-mono text-sm ${r.missing ? 'text-danger' : 'text-text-muted'}`}>{r.missing}</div></div>
            </div>
            {r.over && <div className="text-xs text-danger mt-2">More came back than were sent.</div>}
          </div>
        ))}
      </div>
      <label className="block mb-4 text-sm">Notes{anyMissing ? ' (required: some goods did not come back)' : ' (optional)'}
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. box was opened, one pair missing" className={`${field} mt-1`} />
      </label>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onClose} className={secondary}>Cancel</button>
        <button type="submit" disabled={!ready || busy} className={primary}>Count it in</button>
      </div>
    </Sheet>
  );
}
