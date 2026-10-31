import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Sheet from './Sheet';
import Picker from './Picker';
import { ordersApi, productsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { fetchAll } from '../api/fetchAll';
import { useToast } from '../context/UIContext';

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
const PAYMENT_TYPES = [
  { value: 'cod', label: 'Cash on delivery' },
  { value: 'prepaid', label: 'Prepaid' },
  { value: 'g4s_pickup_pay', label: 'G4S pickup & pay' },
];
const inputCls = 'w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm';

// "New order": for an order taken by phone or in person that did not come from a lead or an online shop. The server
// stores it on the 'manual' channel, prices it from the product list, and finds the customer by phone (so a repeat
// customer needs no name). Discounts are not offered here; they go through the normal discount rules on the order.
export default function NewOrderSheet({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', phone: '', email: '', city: '', payment_type: 'cod', notes: '' });
  const [rows, setRows] = useState([{ product_id: '', quantity: 1 }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['products', 'for-new-order'],
    queryFn: () => fetchAll(productsApi.list),
  });
  const options = products.map((p) => ({ value: p.id, label: p.name, hint: money(p.sell_price) }));
  const priceOf = (id) => products.find((p) => p.id === Number(id))?.sell_price || 0;
  const qtyOf = (r) => Math.max(1, Math.floor(Number(r.quantity) || 1));
  const filled = rows.filter((r) => r.product_id);
  const total = filled.reduce((sum, r) => sum + priceOf(r.product_id) * qtyOf(r), 0);

  function setRow(i, patch) { setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); }

  async function submit(e) {
    e?.preventDefault?.();
    if (filled.length === 0) { setError('Choose at least one product.'); return; }
    setBusy(true);
    setError('');
    try {
      const payload = {
        phone: form.phone.trim(),
        items: filled.map((r) => ({ product_id: Number(r.product_id), quantity: qtyOf(r) })),
        payment_type: form.payment_type,
        channel: 'manual',
      };
      if (form.name.trim()) payload.name = form.name.trim();
      if (form.email.trim()) payload.email = form.email.trim();
      if (form.city.trim()) payload.city = form.city.trim();
      if (form.notes.trim()) payload.notes = form.notes.trim();
      const res = await ordersApi.create(payload);
      const order = res.data.data;
      toast.success(`Order ${order.product_code || `#${order.id}`} created.`);
      onCreated?.(order);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not create the order.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} size="md" as="form" onSubmit={submit} label="New order">
      <h2 className="font-display font-700 text-lg mb-4">New order</h2>
      {error && <div role="alert" className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <label htmlFor="new-order-phone" className="block text-xs font-medium text-text-muted mb-1">Customer phone</label>
      <input id="new-order-phone" required autoFocus value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0712345678" className={`${inputCls} mb-3`} />

      <label htmlFor="new-order-name" className="block text-xs font-medium text-text-muted mb-1">Customer name (optional for a returning customer)</label>
      <input id="new-order-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inputCls} mb-3`} />

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label htmlFor="new-order-city" className="block text-xs font-medium text-text-muted mb-1">City / town (optional)</label>
          <input id="new-order-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label htmlFor="new-order-email" className="block text-xs font-medium text-text-muted mb-1">Email (optional)</label>
          <input id="new-order-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} />
        </div>
      </div>

      <label htmlFor="new-order-payment" className="block text-xs font-medium text-text-muted mb-1">Payment</label>
      <select id="new-order-payment" value={form.payment_type} onChange={(e) => setForm({ ...form, payment_type: e.target.value })} className={`${inputCls} mb-3`}>
        {PAYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>

      <div className="text-xs font-medium text-text-muted mb-1">Items</div>
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

      <label htmlFor="new-order-notes" className="block text-xs font-medium text-text-muted mb-1">Notes (optional)</label>
      <textarea id="new-order-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={`${inputCls} mb-4`} />

      <div className="font-mono text-sm border-t border-dashed border-line pt-3 mb-4">
        <div className="flex justify-between font-600"><span>Items total</span><span>{money(total)}</span></div>
        <p className="text-xs text-text-muted font-sans pt-1">The delivery fee is added by the server when the order is created.</p>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
        <button type="submit" disabled={busy || filled.length === 0}
          className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {busy ? 'Creating…' : 'Create order'}
        </button>
      </div>
    </Sheet>
  );
}
