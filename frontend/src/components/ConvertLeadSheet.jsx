import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Sheet from './Sheet';
import Picker from './Picker';
import { leadsApi, productsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { fetchAll } from '../api/fetchAll';
import { useToast } from '../context/UIContext';

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
const PAYMENT_TYPES = [
  { value: 'cod', label: 'Cash on delivery' },
  { value: 'prepaid', label: 'Prepaid' },
  { value: 'g4s_pickup_pay', label: 'G4S pickup & pay' },
];

// "Convert to order": one pop-up, one request. The server builds the order from the lead, links the two and marks the
// lead converted in a single transaction - nothing is half-done if it fails. If the customer's phone already has an
// active order the server says so (409 + that order's id) and this offers a one-tap merge into it instead.
export default function ConvertLeadSheet({ lead, onClose, onConverted }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState([{ product_id: lead.interested_product_id || '', quantity: 1 }]);
  const [city, setCity] = useState('');
  const [paymentType, setPaymentType] = useState('cod');
  const [error, setError] = useState('');
  const [existingOrder, setExistingOrder] = useState(null); // { id, canMerge } when the phone already has an active order
  const [busy, setBusy] = useState(false);

  const { data: products = [] } = useQuery({
    queryKey: ['products', 'for-convert'],
    queryFn: () => fetchAll(productsApi.list),
  });
  const options = products.map((p) => ({ value: p.id, label: p.name, hint: money(p.sell_price) }));
  const priceOf = (id) => products.find((p) => p.id === Number(id))?.sell_price || 0;
  const filled = rows.filter((r) => r.product_id);
  const total = filled.reduce((sum, r) => sum + priceOf(r.product_id) * (Number(r.quantity) || 0), 0);

  function setRow(i, patch) { setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); }

  async function submit(mergeIntoOrderId) {
    if (filled.length === 0) { setError('Choose at least one product.'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await leadsApi.convert(lead.id, {
        items: filled.map((r) => ({ product_id: Number(r.product_id), quantity: Math.max(1, Math.floor(Number(r.quantity) || 1)) })),
        city: city.trim() || undefined,
        payment_type: paymentType,
        merge_into_order_id: mergeIntoOrderId || undefined,
      });
      const { order, merged } = res.data.data;
      toast.success(merged ? `Items added to order #${order.id}.` : `Order #${order.id} created from this lead.`);
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onConverted?.(order);
      onClose();
    } catch (err) {
      const details = err?.response?.data?.details;
      if (err?.response?.status === 409 && details?.existingOrderId) {
        setExistingOrder({ id: details.existingOrderId, canMerge: !!details.canMerge });
      }
      setError(getErrorMessage(err, 'Could not convert this lead.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} size="md" as="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2 className="font-display font-700 text-lg mb-1">Convert to order</h2>
      <p className="text-sm text-text-muted mb-4">{lead.name} · {lead.phone}</p>

      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      {existingOrder && (
        <div className="mb-4 rounded-lg border border-line bg-paper px-3 py-3 text-sm">
          <div className="font-medium mb-1">This customer already has an active order (#{existingOrder.id}).</div>
          {existingOrder.canMerge ? (
            <>
              <p className="text-text-muted mb-2">Add these items to that order instead of creating a second one.</p>
              <button type="button" disabled={busy} onClick={() => submit(existingOrder.id)}
                className="px-3 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
                Merge into order #{existingOrder.id}
              </button>
            </>
          ) : (
            <p className="text-text-muted">That order has already been dispatched, so items can't be added to it.</p>
          )}
        </div>
      )}

      <div className="text-xs font-medium text-text-muted mb-1">Items</div>
      <div className="space-y-2 mb-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2 items-center">
            <Picker className="flex-1 min-w-0" value={r.product_id} onChange={(v) => setRow(i, { product_id: v })}
              options={options} title="Product" placeholder="Choose a product…" aria-label={`Product ${i + 1}`} />
            <input type="number" min="1" step="1" inputMode="numeric" value={r.quantity} aria-label={`Quantity ${i + 1}`}
              onChange={(e) => setRow(i, { quantity: e.target.value })}
              className="w-16 px-2 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm text-center" />
            {rows.length > 1 && (
              <button type="button" onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                className="text-xs text-text-muted hover:text-danger px-1" aria-label={`Remove item ${i + 1}`}>✕</button>
            )}
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setRows([...rows, { product_id: '', quantity: 1 }])}
        className="text-xs text-text-muted hover:text-text mb-4">+ Add another item</button>

      <label className="block text-xs font-medium text-text-muted mb-1">City / area (optional)</label>
      <input value={city} onChange={(e) => setCity(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

      <label className="block text-xs font-medium text-text-muted mb-1">Payment</label>
      <Picker value={paymentType} onChange={setPaymentType} options={PAYMENT_TYPES} title="Payment type" className="mb-3" />

      {total > 0 && <div className="text-sm mb-4">Order total: <span className="font-medium">{money(total)}</span></div>}

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
        <button type="submit" disabled={busy}
          className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {busy ? 'Converting…' : 'Convert'}
        </button>
      </div>
    </Sheet>
  );
}
