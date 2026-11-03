import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Sheet from './Sheet';
import Picker from './Picker';
import { ordersApi, productsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { fetchAll } from '../api/fetchAll';
import { useToast } from '../context/UIContext';

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });

// Change what a customer is ordering while the order is still awaiting dispatch: add a product, change a quantity,
// remove a line. The list sent is the list the order ends up with; the server works out the totals and the delivery fee
// again. Once the order is dispatched the server refuses every change and the button is not offered (see Orders.jsx).
export default function EditItemsSheet({ order, onClose, onSaved }) {
  const toast = useToast();
  const [rows, setRows] = useState(() => (order.items || []).map((it) => ({ product_id: it.product_id, quantity: it.quantity, discount: it.discount || 0 })));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['products', 'for-edit-items'],
    queryFn: () => fetchAll(productsApi.list),
  });
  const options = products.map((p) => ({ value: p.id, label: p.name, hint: money(p.sell_price) }));
  const nameOf = (id) => order.items?.find((it) => it.product_id === Number(id))?.product_name || products.find((p) => p.id === Number(id))?.name;
  const priceOf = (id) => products.find((p) => p.id === Number(id))?.sell_price ?? order.items?.find((it) => it.product_id === Number(id))?.unit_price ?? 0;
  const qtyOf = (r) => Math.max(1, Math.floor(Number(r.quantity) || 1));
  const filled = rows.filter((r) => r.product_id);
  const newSubtotal = filled.reduce((sum, r) => sum + priceOf(r.product_id) * qtyOf(r) - (Number(r.discount) || 0), 0);
  const newTotal = newSubtotal - (order.discount_total || 0);

  function setRow(i, patch) { setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); }

  async function submit(e) {
    e?.preventDefault?.();
    if (filled.length === 0) { setError('An order needs at least one item. Cancel the order instead.'); return; }
    const ids = filled.map((r) => Number(r.product_id));
    if (new Set(ids).size !== ids.length) { setError('Each product can only be listed once. Change its quantity instead.'); return; }
    setBusy(true);
    setError('');
    try {
      await ordersApi.replaceItems(order.id, filled.map((r) => ({
        product_id: Number(r.product_id), quantity: qtyOf(r), ...(Number(r.discount) > 0 ? { discount: Number(r.discount) } : {}),
      })));
      toast.success(`Updated the items on ${order.product_code}.`);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not change the items.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} size="md" as="form" onSubmit={submit} label={`Change items on ${order.product_code}`}>
      <h2 className="font-display font-700 text-lg mb-1">Change items</h2>
      <p className="text-sm text-text-muted mb-4">{order.product_code} · {order.customer?.name}</p>

      {error && <div role="alert" className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <div className="text-xs font-medium text-text-muted mb-1">Items on this order</div>
      <div className="space-y-2 mb-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2 items-center">
            {r.product_id && order.items?.some((it) => it.product_id === Number(r.product_id)) ? (
              <div className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-line text-sm truncate">{nameOf(r.product_id)}</div>
            ) : (
              <Picker className="flex-1 min-w-0" value={r.product_id} onChange={(v) => setRow(i, { product_id: v })}
                options={options} title="Product" placeholder={isLoading ? 'Loading products…' : 'Choose a product…'} aria-label={`Product ${i + 1}`} />
            )}
            <input type="number" min="1" step="1" inputMode="numeric" value={r.quantity} aria-label={`Quantity ${i + 1}`}
              onChange={(e) => setRow(i, { quantity: e.target.value })}
              className="w-16 px-2 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm text-center" />
            <button type="button" onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
              className="text-xs text-text-muted hover:text-danger px-1" aria-label={`Remove item ${i + 1}`}>✕</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setRows([...rows, { product_id: '', quantity: 1, discount: 0 }])}
        className="text-xs text-text-muted hover:text-text mb-4">+ Add another product</button>

      <div className="font-mono text-sm space-y-1 border-t border-dashed border-line pt-3 mb-4">
        <div className="flex justify-between text-text-muted"><span>Current total</span><span>{money(order.total)}</span></div>
        <div className="flex justify-between font-600"><span>New total</span><span>{money(newTotal)}</span></div>
        <p className="text-xs text-text-muted font-sans pt-1">
          The delivery fee is worked out again when you save.
          {order.payment_type === 'cod' && order.cod_confirmed_at ? ' A changed total means the customer must confirm this COD order again.' : ''}
        </p>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
        <button type="submit" disabled={busy || filled.length === 0}
          className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </Sheet>
  );
}
