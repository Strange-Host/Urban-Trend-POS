import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { stockApi } from '../../api/endpoints';
import Pager, { usePager } from '../../components/Pager';
import Picker, { Segmented } from '../../components/Picker';
import Sheet from '../../components/Sheet';
import { useAuth } from '../../context/AuthContext';
import { useToast, useDialog } from '../../context/UIContext';
import { Badge, ProductSearch, Table } from './shared';
import { btnPrimary, inputCls, labelCls, when } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------------------------------
export default function TransfersTab({ stores }) {
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const { user, can } = useAuth();
  const canReview = can('stock.review');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const [toStore, setToStore] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([{ key: 1, product: null, qty: '' }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'transfers', status, pager.page, pager.pageSize],
    queryFn: () => stockApi.transfers({ ...pager.params, status: status || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const others = stores.filter((s) => !s.is_current && s.is_active);
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['stock'] }); queryClient.invalidateQueries({ queryKey: ['inventory'] }); };

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!toStore) return setError('Choose where the stock is going.');
    const items = [];
    for (const [i, l] of lines.entries()) {
      const quantity = parseInt(l.qty, 10);
      if (!l.product || !Number.isInteger(quantity) || quantity <= 0) return setError(`Line ${i + 1}: choose a product and a quantity.`);
      items.push({ product_id: l.product.id, quantity });
    }
    setBusy(true);
    try {
      await stockApi.requestTransfer({ to_store_id: Number(toStore), note: note.trim() || undefined, items });
      toast.info('Requested. The stock moves once someone else approves it.');
      setOpen(false); setToStore(''); setNote(''); setLines([{ key: 1, product: null, qty: '' }]); refresh();
    } catch (err) { setError(getErrorMessage(err, 'Could not request the transfer.')); } finally { setBusy(false); }
  }

  async function decide(t, approve) {
    try {
      if (approve) {
        if (!(await dialog.confirm({ message: `Move ${t.total_units} unit(s) from ${t.from_store_name} to ${t.to_store_name}? The stock moves now.`, confirmLabel: 'Approve' }))) return;
        await stockApi.approveTransfer(t.id);
      } else {
        const reason = await dialog.prompt({ message: 'Why is this transfer being rejected?', required: true, confirmLabel: 'Reject' });
        if (!reason) return;
        await stockApi.rejectTransfer(t.id, reason);
      }
      refresh();
    } catch (err) { toast.error(getErrorMessage(err, 'Could not update the transfer.')); }
  }

  async function cancel(t) {
    if (!(await dialog.confirm({ message: 'Withdraw this transfer request?', danger: true, confirmLabel: 'Withdraw' }))) return;
    try { await stockApi.cancelTransfer(t.id); refresh(); } catch (err) { toast.error(getErrorMessage(err, 'Could not withdraw it.')); }
  }

  const rows = data?.data || [];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-text-muted max-w-xl">Ask to move stock to another branch. Nothing moves until a manager approves it; then it leaves one branch and arrives at the other together.</p>
        <button onClick={() => setOpen(true)} className={btnPrimary} disabled={others.length === 0}>+ New transfer</button>
      </div>
      <Segmented value={status} onChange={(v) => { setStatus(v); pager.reset(); }} aria-label="Filter transfers" className="mb-4 max-w-md"
        options={[{ value: '', label: 'All' }, { value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />

      <Table head={['#', 'From → To', 'Items', 'Status', '']} loading={isLoading} empty={rows.length === 0 && 'No transfers yet.'}>
        {rows.map((t) => (
          <tr key={t.id} className="border-b border-line last:border-0 align-top">
            <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{t.id}<div className="text-text-muted">{when(t.created_at)}</div></td>
            <td className="px-4 py-3">{t.from_store_name} → {t.to_store_name}<div className="text-xs text-text-muted">asked by {t.requested_by_name}{t.note ? ` — ${t.note}` : ''}</div></td>
            <td className="px-4 py-3 text-text-muted">{t.items.map((i) => <div key={i.id}>{i.quantity} × {i.product_name}</div>)}</td>
            <td className="px-4 py-3">
              <Badge status={t.status} />
              {t.reviewed_by_name && t.status !== 'pending' && <div className="text-xs text-text-muted mt-1">{t.status === 'cancelled' ? 'withdrawn' : t.status} by {t.reviewed_by_name}</div>}
              {t.status === 'rejected' && t.review_note && <div className="text-xs text-danger mt-0.5">{t.review_note}</div>}
            </td>
            <td className="px-4 py-3 text-right whitespace-nowrap">
              {t.status === 'pending' && canReview && (t.requested_by_staff_id !== user.id || user.role === 'admin') && (
                <>
                  <button onClick={() => decide(t, true)} className="text-xs font-medium text-success hover:opacity-70 mr-3">Approve</button>
                  <button onClick={() => decide(t, false)} className="text-xs text-danger hover:opacity-70 mr-3">Reject</button>
                </>
              )}
              {t.status === 'pending' && (t.requested_by_staff_id === user.id || user.role === 'admin') && <button onClick={() => cancel(t)} className="text-xs text-text-muted hover:text-text">Withdraw</button>}
            </td>
          </tr>
        ))}
      </Table>
      <Pager pager={pager} data={data} noun="transfers" />

      {open && (
        <Sheet onClose={() => setOpen(false)} size="md" as="form" onSubmit={save}>
          <h2 className="font-display font-700 text-lg mb-4">New transfer</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <label className={labelCls}>Send to</label>
          <Picker value={toStore} onChange={setToStore} title="Send to" aria-label="Send to" className="mb-3" options={others.map((s) => ({ value: s.id, label: s.name }))} />
          <div className="space-y-3 mb-3">
            {lines.map((l) => (
              <div key={l.key} className="grid grid-cols-[1fr_5rem_auto] gap-2 items-end">
                <div><label className={labelCls}>Product</label><ProductSearch value={l.product} onChange={(product) => setLine(l.key, { product })} /></div>
                <div><label className={labelCls}>Qty</label><input type="number" min="1" inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className={inputCls} /></div>
                {lines.length > 1 ? <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="pb-2 text-xs text-danger">Remove</button> : <span />}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setLines((ls) => [...ls, { key: Date.now(), product: null, qty: '' }])} className="text-sm text-text-muted hover:text-text mb-3">+ Add another product</button>
          <label className={labelCls}>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} mb-5`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{busy ? 'Sending…' : 'Request transfer'}</button>
          </div>
        </Sheet>
      )}
    </>
  );
}
