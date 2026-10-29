import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Sheet from './Sheet';
import Picker from './Picker';
import { ordersApi, productsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { fetchAll } from '../api/fetchAll';
import { useToast } from '../context/UIContext';

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });

// "Add items" to an order that is still awaiting dispatch. One request: the server adds the lines, raises the subtotal
// and total, and re-works the delivery fee (it can cross the free/percentage threshold). Once an order is dispatched the
// parcel is already packed, so the server refuses and the button is not offered (see Orders.jsx).
export default function AddItemsSheet({ order, onClose, onAdded }) {
  const toast = useToast();
  const [rows, setRows] = useState([{ product_id: '', quantity: 1 }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['products', 'for-add-items'],
    queryFn: () => fetchAll(productsApi.list),
  });
  const options = products.map((p) => ({ value: p.id, label: p.name, hint: money(p.sell_price) }));
  const priceOf = (id) => products.find((p) => p.id === Number(id))?.sell_price || 0;
  const qtyOf = (r) => Math.max(1, Math.floor(Number(r.quantity) || 1));
  const filled = rows.filter((r) => r.product_id);
  const added = filled.reduce((sum, r) => sum + priceOf(r.product_id) * qtyOf(r), 0);

  function setRow(i, patch) { setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); }

  async function submit(e) {
    e?.preventDefault?.();
    if (filled.length === 0) { setError('Choose at least one product.'); return; }
    setBusy(true);
    setError('');
    try {
      await ordersApi.mergeItems(order.id, filled.map((r) => ({ product_id: Number(r.product_id), quantity: qtyOf(r) })));
      toast.success(`Added ${filled.length} item${filled.length === 1 ? '' : 's'} to ${order.product_code}.`);
      onAdded?.();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not add those items.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} size="md" as="form" onSubmit={submit} label={`Add items to ${order.product_code}`}>
      <h2 className="font-display font-700 text-lg mb-1">Add items</h2>
      <p className="text-sm text-text-muted mb-4">{order.product_code} · {order.customer?.name}</p>

      {error && <div role="alert" className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <div className="text-xs font-medium text-text-muted mb-1">Items to add</div>
      <div className="space-y-2 mb-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2 items-center">
            <Picker className="flex-1 min-w-0" value={r.product_id} onChange={(v) => setRow(i, { product_id: v })}
              options={options} title="Product" placeholder={isLoading ? 'Loading products…' : 'Choose a product…'} aria-label={`Product ${i + 1}`} />
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

      <div className="font-mono text-sm space-y-1 border-t border-dashed border-line pt-3 mb-4">
        <div className="flex justify-between text-text-muted"><span>Current total</span><span>{money(order.total)}</span></div>
        <div className="flex justify-between"><span>Adding</span><span>{money(added)}</span></div>
        <div className="flex justify-between font-600"><span>New total</span><span>{money(order.total + added)}</span></div>
        <p className="text-xs text-text-muted font-sans pt-1">The delivery fee is worked out again when you add.</p>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
        <button type="submit" disabled={busy || filled.length === 0}
          className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {busy ? 'Adding…' : 'Add to order'}
        </button>
      </div>
    </Sheet>
  );
}
