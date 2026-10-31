import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { requisitionsApi, productsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/UIContext';
import Pager, { usePager } from '../components/Pager';
import { fetchAll } from '../api/fetchAll';

import Sheet from '../components/Sheet';
const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
const when = (utc) => (utc ? new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString() : '');
const STATUS_COLORS = {
  pending: 'bg-accent/20 text-accent-ink',
  approved: 'bg-success-soft text-success',
  rejected: 'bg-danger-soft text-danger',
};

export default function Requisitions() {
  const { hasRole, user } = useAuth();
  const toast = useToast();
  const canReview = hasRole('admin', 'manager');
  const [statusFilter, setStatusFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [lines, setLines] = useState([{ product_id: '', quantity_requested: '' }]);
  const [notes, setNotes] = useState('');
  const [kind, setKind] = useState('shop_operational'); // or 'salary_advance'
  const [amountKes, setAmountKes] = useState('');
  const [signedName, setSignedName] = useState('');
  const [receiptName, setReceiptName] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const queryClient = useQueryClient();

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['requisitions', { statusFilter, page: pager.page, size: pager.pageSize }],
    queryFn: () => requisitionsApi.list({ ...pager.params, status: statusFilter || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const requisitions = data?.data || [];

  const { data: products } = useQuery({
    queryKey: ['products', 'for-requisition'],
    queryFn: () => fetchAll(productsApi.list),
  });

  const { data: selected } = useQuery({
    queryKey: ['requisitions', selectedId],
    queryFn: () => requisitionsApi.getById(selectedId).then((r) => r.data.data),
    enabled: !!selectedId,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['requisitions'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
  }

  function updateLine(i, field, value) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    if (!signedName.trim()) { setError('Type your full name to sign this request.'); return; }
    try {
      if (kind === 'salary_advance') {
        const amount = Math.round(Number(amountKes) * 100);
        if (!amount || amount <= 0) { setError('Enter the advance amount.'); return; }
        await requisitionsApi.create({ type: 'salary_advance', amount, notes: notes || undefined, signed_name: signedName.trim() });
      } else {
        const items = lines
          .filter((l) => l.product_id && l.quantity_requested)
          .map((l) => ({ product_id: Number(l.product_id), quantity_requested: Number(l.quantity_requested) }));
        if (items.length === 0) { setError('Add at least one product line.'); return; }
        await requisitionsApi.create({ notes: notes || undefined, items, signed_name: signedName.trim() });
      }
      invalidate();
      setCreating(false);
      setLines([{ product_id: '', quantity_requested: '' }]);
      setNotes('');
      setAmountKes('');
      setSignedName('');
      setKind('shop_operational');
    } catch (err) {
      setError(getErrorMessage(err, 'Could not create requisition.'));
    }
  }

  async function handleAcknowledge(e) {
    e.preventDefault();
    try {
      await requisitionsApi.acknowledge(selectedId, receiptName.trim());
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['requisitions', selectedId] });
      setReceiptName('');
      toast.success('Receipt signed.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not record your signature.'));
    }
  }

  async function handleApprove() {
    try {
      const items = selected.items.map((i) => ({ product_id: i.product_id, quantity_approved: i.quantity_requested }));
      await requisitionsApi.approve(selectedId, items);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['requisitions', selectedId] });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not approve requisition.'));
    }
  }

  async function handleReject(e) {
    e.preventDefault();
    if (!rejectionReason) return;
    try {
      await requisitionsApi.reject(selectedId, rejectionReason);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['requisitions', selectedId] });
      setRejecting(false);
      setRejectionReason('');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not reject requisition.'));
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Requisitions</h1>
          <p className="text-text-muted text-sm mt-1">Stock requests and salary advances. Approving stock auto-increments inventory; an approved advance comes off your pay. You sign when you ask and again when you receive it.</p>
        </div>
        <button onClick={() => { setCreating(true); setError(''); }}
          className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap">
          + New requisition
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); pager.reset(); }}
          className="px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[560px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Requested by</th>
              <th className="px-4 py-3 font-medium">Items</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {!isLoading && requisitions.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No requisitions found.</td></tr>
            )}
            {requisitions.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-mono text-xs">#{r.id}</td>
                <td className="px-4 py-3 whitespace-nowrap">{r.requested_by_name}</td>
                <td className="px-4 py-3">{r.type === 'salary_advance' ? `Advance · ${money(r.amount)}` : `${r.item_count} item${r.item_count === 1 ? '' : 's'}`}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-full capitalize ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                  {r.status === 'approved' && !r.receipt_signature_at && <span className="ml-1.5 text-xs text-text-muted">awaiting receipt</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setSelectedId(r.id)} className="text-xs text-text-muted hover:text-text">Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="requisitions" />

      {creating && (
        <Sheet onClose={() => setCreating(false)} size="md" as="form" onSubmit={handleCreate}>
            <h2 className="font-display font-700 text-lg mb-4">New requisition</h2>
            {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm" role="alert">{error}</div>}

            <label className="block text-xs font-medium text-text-muted mb-1" htmlFor="req-kind">What are you asking for?</label>
            <select id="req-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-line text-sm mb-4">
              <option value="shop_operational">Stock for the shop</option>
              <option value="salary_advance">Salary advance</option>
            </select>

            {kind === 'salary_advance' && (
              <>
                <label className="block text-xs font-medium text-text-muted mb-1" htmlFor="req-amount">Amount (KES)</label>
                <input id="req-amount" type="number" min="1" step="any" value={amountKes} onChange={(e) => setAmountKes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-4 text-sm" />
              </>
            )}

            {kind === 'shop_operational' && <div className="space-y-2 mb-3">
              {lines.map((line, i) => (
                <div key={i} className="flex gap-2">
                  <select value={line.product_id} onChange={(e) => updateLine(i, 'product_id', e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border border-line text-sm">
                    <option value="">Select product…</option>
                    {products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input type="number" min="1" value={line.quantity_requested}
                    onChange={(e) => updateLine(i, 'quantity_requested', e.target.value)}
                    placeholder="Qty" className="w-20 px-3 py-2 rounded-lg border border-line text-sm" />
                  {lines.length > 1 && (
                    <button type="button" onClick={() => setLines(lines.filter((_, idx) => idx !== i))}
                      className="text-danger text-sm px-1">×</button>
                  )}
                </div>
              ))}
            </div>}
            {kind === 'shop_operational' && (
              <button type="button" onClick={() => setLines([...lines, { product_id: '', quantity_requested: '' }])}
                className="text-xs text-text-muted hover:text-text mb-4">+ Add another product</button>
            )}

            <label className="block text-xs font-medium text-text-muted mb-1">Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-4" />

            <label className="block text-xs font-medium text-text-muted mb-1" htmlFor="req-sign">
              Sign: type your full name{kind === 'salary_advance' ? ' (you agree this amount is deducted from your pay)' : ''}
            </label>
            <input id="req-sign" value={signedName} onChange={(e) => setSignedName(e.target.value)} placeholder={user?.name || 'Your full name'} autoComplete="off"
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5 text-sm" />

            <div className="flex gap-2">
              <button type="button" onClick={() => setCreating(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Submit</button>
            </div>
          </Sheet>
      )}

      {selectedId && selected && (
        <Sheet onClose={() => setSelectedId(null)} size="md">
            <div className="flex items-start justify-between mb-3">
              <h2 className="font-display font-700 text-lg">Requisition #{selected.id}</h2>
              <span className={`text-xs px-2 py-1 rounded-full capitalize ${STATUS_COLORS[selected.status]}`}>{selected.status}</span>
            </div>
            {selected.notes && <p className="text-sm text-text-muted mb-3">{selected.notes}</p>}
            {selected.type === 'salary_advance' && <p className="text-sm mb-3">Salary advance of <span className="font-mono font-600">{money(selected.amount)}</span>, deducted from pay once approved.</p>}

            <div className="space-y-1.5 mb-4">
              {selected.items.map((i) => (
                <div key={i.id} className="flex justify-between text-sm border-b border-line pb-1.5">
                  <span>{i.product_name} <span className="text-text-muted font-mono text-xs">({i.sku})</span></span>
                  <span className="font-mono">
                    {i.quantity_approved != null ? `${i.quantity_approved} / ${i.quantity_requested}` : `${i.quantity_requested} requested`}
                  </span>
                </div>
              ))}
            </div>

            <div className="text-xs text-text-muted mb-4 space-y-0.5">
              {selected.request_signature_name && <div>Requested and signed by “{selected.request_signature_name}” · {when(selected.request_signature_at)}</div>}
              {selected.receipt_signature_name && <div>Receipt signed by “{selected.receipt_signature_name}” · {when(selected.receipt_signature_at)}</div>}
            </div>

            {selected.status === 'approved' && !selected.receipt_signature_at && selected.requested_by_staff_id === user?.id && (
              <form onSubmit={handleAcknowledge} className="mb-3">
                <label className="block text-xs font-medium text-text-muted mb-1" htmlFor="req-receipt">
                  Received {selected.type === 'salary_advance' ? 'the money' : 'the goods'}? Sign: type your full name
                </label>
                <div className="flex gap-2">
                  <input id="req-receipt" value={receiptName} onChange={(e) => setReceiptName(e.target.value)} placeholder={user?.name || 'Your full name'} autoComplete="off"
                    className="flex-1 px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm" />
                  <button type="submit" disabled={!receiptName.trim()} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Sign receipt</button>
                </div>
              </form>
            )}

            {selected.status === 'rejected' && selected.rejection_reason && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{selected.rejection_reason}</div>
            )}

            {canReview && selected.status === 'pending' && !rejecting && (
              <div className="flex gap-2 mb-2">
                <button onClick={() => setRejecting(true)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Reject</button>
                <button onClick={handleApprove} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Approve full quantities</button>
              </div>
            )}

            {canReview && rejecting && (
              <form onSubmit={handleReject} className="mb-2">
                <textarea required value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Reason for rejection…" rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-2 text-sm" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setRejecting(false)} className="flex-1 py-2 rounded-lg border border-line text-sm font-medium">Cancel</button>
                  <button type="submit" className="flex-1 py-2 rounded-lg bg-danger text-white text-sm font-medium">Confirm reject</button>
                </div>
              </form>
            )}

            <button onClick={() => setSelectedId(null)} className="w-full mt-2 py-2.5 rounded-lg border border-line text-sm font-medium">Close</button>
          </Sheet>
      )}
    </div>
  );
}
