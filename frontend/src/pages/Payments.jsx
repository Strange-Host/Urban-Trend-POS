import { useState } from 'react';
import StatCard from '../components/StatCard';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { paymentsApi } from '../api/endpoints';
import { USE_NEW_SERVER as NEW } from '../api/newServer';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';
import Pager, { usePager } from '../components/Pager';

import Sheet from '../components/Sheet';
const METHODS = ['cash', 'card', 'mobile_money', 'bank_transfer'];
const emptyForm = { direction: 'incoming', sale_id: '', supplier_name: '', method: 'cash', amount: '', reference: '', notes: '' };

const STATUS_COLORS = {
  completed: 'bg-success-soft text-success',
  refunded: 'bg-line text-text-muted',
  failed: 'bg-danger-soft text-danger',
};

export default function Payments() {
  const toast = useToast();
  const dialog = useDialog();
  const [directionFilter, setDirectionFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['payments', { directionFilter, page: pager.page, size: pager.pageSize }],
    queryFn: () => paymentsApi.list({ ...pager.params, direction: directionFilter || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const payments = data?.data || [];

  const { data: summary } = useQuery({
    queryKey: ['payments', 'summary'],
    queryFn: () => paymentsApi.summary().then((r) => r.data.data),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['payments'] });
  }

  function openNew() {
    setForm(emptyForm);
    setError('');
    setCreating(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    const payload = {
      direction: form.direction,
      method: form.method,
      amount: Math.round(Number(form.amount) * 100),
      reference: form.reference || undefined,
      notes: form.notes || undefined,
      ...(form.direction === 'incoming' ? { sale_id: Number(form.sale_id) } : { supplier_name: form.supplier_name }),
    };
    try {
      await paymentsApi.create(payload);
      invalidate();
      setCreating(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not record payment.'));
    }
  }

  async function handleRefund(p) {
    if (!(await dialog.confirm({ message: 'Mark this payment as refunded?', danger: true }))) return;
    try {
      await paymentsApi.refund(p.id);
      invalidate();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not refund payment.'));
    }
  }

  const incomingTotal = summary?.by_method?.filter((m) => m.direction === 'incoming').reduce((s, m) => s + m.total, 0) || 0;
  const outgoingTotal = summary?.by_method?.filter((m) => m.direction === 'outgoing').reduce((s, m) => s + m.total, 0) || 0;

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Payments</h1>
          <p className="text-text-muted text-sm mt-1">
            {NEW
              ? 'Every payment booked against an order. Payments are matched as they arrive; a wrong one is refunded from Payment reconciliation.'
              : 'Layaway/partial customer payments and outgoing supplier payments — separate from Terminal checkout.'}
          </p>
        </div>
        {!NEW && (
          <button onClick={openNew}
            className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap">
            + Record payment
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard label="Incoming (completed)" value={`KES ${(incomingTotal / 100).toFixed(0)}`} />
        <StatCard label="Outgoing (completed)" value={`KES ${(outgoingTotal / 100).toFixed(0)}`} />
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm">
          <option value="">All directions</option>
          <option value="incoming">Incoming</option>
          <option value="outgoing">Outgoing</option>
        </select>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Direction</th>
              <th className="px-4 py-3 font-medium">To/From</th>
              <th className="px-4 py-3 font-medium">Method</th>
              <th className="px-4 py-3 font-medium text-right">Amount</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {!isLoading && payments.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">No payments recorded yet.</td></tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">{NEW ? new Date(p.created_at).toLocaleString() : p.created_at}</td>
                <td className="px-4 py-3 capitalize">{p.direction}</td>
                <td className="px-4 py-3 whitespace-nowrap">{p.direction === 'incoming' ? (p.order_ref ? `${p.order_ref} · ${p.receipt_no}` : `Sale #${p.sale_id}`) : p.supplier_name}</td>
                <td className="px-4 py-3 capitalize whitespace-nowrap">{p.method.replace('_', ' ')}</td>
                <td className="px-4 py-3 text-right font-mono">{(p.amount / 100).toFixed(2)}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded-full capitalize ${STATUS_COLORS[p.status]}`}>{p.status}</span></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {!NEW && p.status === 'completed' && (
                    <button onClick={() => handleRefund(p)} className="text-xs text-danger hover:opacity-70">Refund</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="payments" />

      {creating && (
        <Sheet onClose={() => setCreating(false)} size="sm" as="form" onSubmit={handleCreate}>
            <h2 className="font-display font-700 text-lg mb-4">Record payment</h2>
            {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

            <label className="block text-xs font-medium text-text-muted mb-1">Direction</label>
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3">
              <option value="incoming">Incoming (customer/layaway)</option>
              <option value="outgoing">Outgoing (supplier)</option>
            </select>

            {form.direction === 'incoming' ? (
              <>
                <label className="block text-xs font-medium text-text-muted mb-1">Sale ID</label>
                <input required type="number" value={form.sale_id} onChange={(e) => setForm({ ...form, sale_id: e.target.value })}
                  placeholder="The sale this payment is against"
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />
              </>
            ) : (
              <>
                <label className="block text-xs font-medium text-text-muted mb-1">Supplier name</label>
                <input required value={form.supplier_name} onChange={(e) => setForm({ ...form, supplier_name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />
              </>
            )}

            <label className="block text-xs font-medium text-text-muted mb-1">Method</label>
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3">
              {METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
            </select>

            <label className="block text-xs font-medium text-text-muted mb-1">Amount (KES)</label>
            <input required type="number" step="0.01" min="0.01" value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Reference (optional)</label>
            <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })}
              placeholder="M-Pesa code, cheque no., etc."
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5" />

            <div className="flex gap-2">
              <button type="button" onClick={() => setCreating(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Save</button>
            </div>
          </Sheet>
      )}
    </div>
  );
}
