import { useState } from 'react';
import Sheet from './Sheet';
import { ordersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast } from '../context/UIContext';
import { toCents } from '../utils/splitPayment';

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
const inputCls = 'w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm';

// Dispatch. Two things are asked here because the books depend on them:
//   1. Has the customer paid the delivery fee, and how much? What they paid offsets the delivery's costs; what they
//      did not pay is carried by the shop. There is no default answer: the person must choose.
//   2. What the courier earns for this parcel (the package fee). Required for a courier organization.
// Stock leaves the shelf when this is confirmed.
export default function DispatchSheet({ order, onClose, onDispatched }) {
  const toast = useToast();
  const fee = order.delivery_fee || 0;
  const isOrg = order.courier?.kind === 'organization';
  const hasCourier = !!order.courier_id;

  const [paid, setPaid] = useState(null);                 // null until chosen, then true / false
  const [collected, setCollected] = useState((fee / 100).toFixed(2));
  const [method, setMethod] = useState('mobile_money');
  const [reference, setReference] = useState('');
  const [packageFee, setPackageFee] = useState('');
  const [zeroReason, setZeroReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e?.preventDefault?.();
    setError('');
    const body = {};
    if (fee > 0) {
      if (paid === null) { setError('Say whether the customer has paid the delivery fee.'); return; }
      body.delivery_fee_paid = paid;
      if (paid) {
        const cents = toCents(collected);
        if (!cents || cents <= 0) { setError('Enter how much of the delivery fee the customer paid.'); return; }
        if (cents > fee) { setError(`The customer cannot have paid more than the fee charged (${money(fee)}).`); return; }
        body.delivery_fee_collected = cents;
        body.delivery_fee_method = method;
        if (reference.trim()) body.delivery_fee_reference = reference.trim();
      }
    }
    if (hasCourier && (isOrg || packageFee !== '')) {
      const cents = toCents(packageFee);
      if (cents === null || (packageFee === '' && isOrg)) { setError('Enter what the courier earns for this parcel (0 if nothing).'); return; }
      body.package_fee = cents;
      if (cents === 0) {
        if (!zeroReason.trim()) { setError('A package fee of 0 needs a reason.'); return; }
        body.package_fee_zero_reason = zeroReason.trim();
      }
    }
    setBusy(true);
    try {
      await ordersApi.dispatch(order.id, body);
      toast.success(`${order.product_code} dispatched.`);
      onDispatched?.();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not dispatch this order.'));
    } finally {
      setBusy(false);
    }
  }

  const feeCents = toCents(collected);
  const shortfall = paid === false ? fee : paid && feeCents != null ? Math.max(0, fee - feeCents) : null;

  return (
    <Sheet onClose={onClose} size="md" as="form" onSubmit={submit} label={`Dispatch ${order.product_code}`}>
      <h2 className="font-display font-700 text-lg mb-1">Dispatch</h2>
      <p className="text-sm text-text-muted mb-4">{order.product_code} · {order.customer?.name} · stock is deducted now.</p>

      {error && <div role="alert" className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      {fee > 0 ? (
        <fieldset className="mb-4">
          <legend className="text-sm font-medium mb-1">Has the customer paid the delivery fee? <span className="font-mono text-text-muted">({money(fee)})</span></legend>
          <div className="flex gap-2 mb-2">
            {[[true, 'Yes, paid'], [false, 'No, not paid']].map(([v, label]) => (
              <button key={String(v)} type="button" aria-pressed={paid === v} onClick={() => setPaid(v)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border ${paid === v ? 'bg-accent border-accent text-accent-ink' : 'border-line text-text-muted hover:border-text-muted'}`}>
                {label}
              </button>
            ))}
          </div>
          {paid === true && (
            <div className="space-y-2">
              <label className="block text-xs text-text-muted">Amount paid (KES)
                <input type="number" step="0.01" min="0" value={collected} onChange={(e) => setCollected(e.target.value)} className={`${inputCls} font-mono mt-1`} />
              </label>
              <div className="flex gap-2">
                <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="How the fee was paid" className={`${inputCls} flex-1`}>
                  <option value="mobile_money">M-Pesa</option>
                  <option value="cash">Cash</option>
                  <option value="bank_transfer">Bank</option>
                </select>
                <input placeholder="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} className={`${inputCls} flex-1 font-mono`} />
              </div>
            </div>
          )}
          {shortfall > 0 && (
            <p className="text-xs text-danger mt-2">{money(shortfall)} of the fee is unpaid. The shop carries that part of the delivery cost.</p>
          )}
        </fieldset>
      ) : (
        <p className="text-xs text-text-muted mb-4">No delivery fee is charged on this order.</p>
      )}

      {hasCourier ? (
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1" htmlFor="package-fee">
            What {order.courier?.name} earns for this parcel (KES){isOrg ? '' : ' — optional'}
          </label>
          <input id="package-fee" type="number" step="0.01" min="0" value={packageFee} onChange={(e) => setPackageFee(e.target.value)} className={`${inputCls} font-mono`} />
          {packageFee !== '' && toCents(packageFee) === 0 && (
            <input placeholder="Why is there no fee?" value={zeroReason} onChange={(e) => setZeroReason(e.target.value)} className={`${inputCls} mt-2`} aria-label="Reason for a zero package fee" />
          )}
          <p className="text-xs text-text-muted mt-1">This counts as a cost of the delivery. Extra costs (outpost legs, handling) are added after dispatch, until the delivery is confirmed.</p>
        </div>
      ) : (
        <p className="text-xs text-text-muted mb-4">No named courier is picked, so no package fee is recorded.</p>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
        <button type="submit" disabled={busy} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {busy ? 'Dispatching…' : 'Dispatch — deducts stock'}
        </button>
      </div>
    </Sheet>
  );
}
