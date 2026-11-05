import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { stockApi, inventoryApi } from '../../api/endpoints';
import Pager, { usePager } from '../../components/Pager';
import Sheet from '../../components/Sheet';
import { LoadingBlock } from '../../components/Skeleton';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/UIContext';
import { Badge, Table } from './shared';
import { btnGhost, btnPrimary, cardCls, inputCls, labelCls } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------------------------------------------------
export default function CountsTab({ storeParams, isOwnStore }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user, can } = useAuth();
  const canReview = can('stock.review');
  const [counting, setCounting] = useState(null);      // 'opening' | 'closing' | null
  const [counts, setCounts] = useState({});            // product_id -> typed value
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(null);    // count id
  const [adjust, setAdjust] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const pager = usePager(25);

  const { data: summary } = useQuery({ queryKey: ['stock', 'day-summary', storeParams], queryFn: () => stockApi.daySummary(storeParams).then((r) => r.data.data) });
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'counts', storeParams, pager.page, pager.pageSize],
    queryFn: () => stockApi.counts({ ...pager.params, ...storeParams }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const { data: inventory = [] } = useQuery({ queryKey: ['inventory', 'list'], queryFn: () => inventoryApi.list().then((r) => r.data.data), enabled: !!counting });
  const { data: detail } = useQuery({ queryKey: ['stock', 'count', reviewing], queryFn: () => stockApi.count(reviewing).then((r) => r.data.data), enabled: !!reviewing });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['stock'] }); queryClient.invalidateQueries({ queryKey: ['inventory'] }); };

  async function submit(e) {
    e.preventDefault();
    setError('');
    const items = Object.entries(counts).filter(([, v]) => v !== '' && v !== undefined).map(([id, v]) => ({ product_id: Number(id), counted_qty: parseInt(v, 10) }));
    if (items.length === 0) return setError('Enter the count for at least one product.');
    if (items.some((i) => !Number.isInteger(i.counted_qty) || i.counted_qty < 0)) return setError('Counts must be whole numbers, zero or more.');
    setBusy(true);
    try {
      const res = await stockApi.submitCount({ kind: counting, note: note.trim() || undefined, items });
      const c = res.data.data;
      toast.info(c.lines_with_variance ? `Submitted. ${c.units_short} short, ${c.units_over} over — a manager will review it.` : 'Submitted. Everything matched.');
      setCounting(null); setCounts({}); setNote(''); setFilter(''); refresh();
    } catch (err) { setError(getErrorMessage(err, 'Could not submit the count.')); } finally { setBusy(false); }
  }

  async function review(approve) {
    try {
      if (approve) await stockApi.approveCount(reviewing, { apply_adjustments: adjust, note: reviewNote.trim() || undefined });
      else {
        if (!reviewNote.trim()) return toast.error('Say why you are rejecting it.');
        await stockApi.rejectCount(reviewing, reviewNote.trim());
      }
      setReviewing(null); setAdjust(false); setReviewNote(''); refresh();
    } catch (err) { toast.error(getErrorMessage(err, 'Could not save the review.')); }
  }

  const rows = data?.data || [];
  const shown = inventory.filter((i) => !filter.trim() || `${i.product_name} ${i.sku}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const canDecide = detail && detail.status === 'submitted' && canReview && (detail.submitted_by_staff_id !== user.id || user.role === 'admin');

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-text-muted max-w-xl">Count the shelf at the start and end of the day. Differences are recorded and reviewed by a manager; counting alone never changes the stock figures.</p>
        {isOwnStore && (
          <div className="flex gap-2">
            <button onClick={() => { setError(''); setCounting('opening'); }} className={btnGhost}>Opening count</button>
            <button onClick={() => { setError(''); setCounting('closing'); }} className={btnPrimary}>Closing count</button>
          </div>
        )}
      </div>

      {summary && (
        <div className={`${cardCls} p-4 mb-6`}>
          <h2 className="font-display font-700 text-sm">Today</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Opening count: {summary.opening ? `${summary.opening.status === 'submitted' ? 'waiting for review' : summary.opening.status} (${summary.opening.submitted_by_name})` : 'not done yet'} · Closing count: {summary.closing ? `${summary.closing.status === 'submitted' ? 'waiting for review' : summary.closing.status} (${summary.closing.submitted_by_name})` : 'not done yet'}
          </p>
          {summary.opening && summary.closing && (
            <>
              <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
                <div><div className="text-xs text-text-muted">Missing</div><div className={`font-mono font-medium ${summary.totals.units_missing ? 'text-danger' : ''}`}>{summary.totals.units_missing}</div></div>
                <div><div className="text-xs text-text-muted">Surplus</div><div className="font-mono font-medium">{summary.totals.units_surplus}</div></div>
                <div><div className="text-xs text-text-muted">Products off</div><div className="font-mono font-medium">{summary.totals.products_with_difference}</div></div>
              </div>
              {summary.lines.some((l) => l.unexplained !== 0) && (
                <ul className="mt-3 border-t border-line pt-3 space-y-1 text-sm">
                  {summary.lines.filter((l) => l.unexplained !== 0).map((l) => (
                    <li key={l.product_id} className="flex justify-between gap-3">
                      <span>{l.product_name}</span>
                      <span className="text-text-muted">opened {l.opening_counted}, expected {l.expected_closing}, counted {l.closing_counted} · <span className={l.unexplained < 0 ? 'text-danger' : ''}>{l.unexplained > 0 ? '+' : ''}{l.unexplained}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <Table head={['Date', 'Count', 'By', 'Result', 'Status', '']} loading={isLoading} empty={rows.length === 0 && 'No counts yet.'}>
        {rows.map((c) => (
          <tr key={c.id} className="border-b border-line last:border-0">
            <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{c.count_date}</td>
            <td className="px-4 py-3 capitalize">{c.kind}</td>
            <td className="px-4 py-3 whitespace-nowrap">{c.submitted_by_name}</td>
            <td className="px-4 py-3 text-text-muted">{c.lines_with_variance ? <span className="text-danger">{c.units_short} short · {c.units_over} over</span> : 'Matched'} <span className="text-xs">({c.products_counted} products{c.products_not_counted ? `, ${c.products_not_counted} not counted` : ''})</span></td>
            <td className="px-4 py-3"><Badge status={c.status} />{c.adjustments_applied ? <span className="ml-1 text-xs text-text-muted">stock corrected</span> : null}</td>
            <td className="px-4 py-3 text-right"><button onClick={() => { setReviewing(c.id); setAdjust(false); setReviewNote(''); }} className="text-xs text-text-muted hover:text-text">{c.status === 'submitted' && canReview ? 'Review' : 'View'}</button></td>
          </tr>
        ))}
      </Table>
      <Pager pager={pager} data={data} noun="counts" />

      {counting && (
        <Sheet onClose={() => setCounting(null)} size="lg" as="form" onSubmit={submit}>
          <h2 className="font-display font-700 text-lg mb-1 capitalize">{counting} count</h2>
          <p className="text-xs text-text-muted mb-3">Type what you can see on the shelf. Leave a product blank to skip it. Do not look at the system figure first — count, then type.</p>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a product…" className={`${inputCls} mb-3`} />
          <div className="max-h-[45vh] overflow-auto border border-line rounded-lg mb-3">
            {shown.length === 0 && <div className="px-3 py-6 text-center text-sm text-text-muted">No products here.</div>}
            {shown.map((i) => (
              <div key={i.product_id} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-line last:border-0">
                <div className="min-w-0"><div className="text-sm truncate">{i.product_name}</div><div className="text-xs text-text-muted font-mono">{i.sku}</div></div>
                <input type="number" min="0" inputMode="numeric" value={counts[i.product_id] ?? ''} onChange={(e) => setCounts({ ...counts, [i.product_id]: e.target.value })} aria-label={`Counted ${i.product_name}`} className="w-24 px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-right" />
              </div>
            ))}
          </div>
          <label className={labelCls}>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} mb-4`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setCounting(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{busy ? 'Submitting…' : 'Submit count'}</button>
          </div>
        </Sheet>
      )}

      {reviewing && (
        <Sheet onClose={() => setReviewing(null)} size="lg">
          {!detail ? <LoadingBlock /> : (
            <>
              <h2 className="font-display font-700 text-lg mb-1 capitalize">{detail.kind} count · {detail.count_date}</h2>
              <p className="text-xs text-text-muted mb-3">{detail.store_name} · submitted by {detail.submitted_by_name} <Badge status={detail.status} />{detail.review_note ? ` — ${detail.review_note}` : ''}</p>
              <div className="max-h-[40vh] overflow-auto border border-line rounded-lg mb-3">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-text-muted"><th className="px-3 py-2 font-medium">Product</th><th className="px-3 py-2 font-medium text-right">System</th><th className="px-3 py-2 font-medium text-right">Counted</th><th className="px-3 py-2 font-medium text-right">Diff</th></tr></thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={l.product_id} className="border-b border-line last:border-0">
                        <td className="px-3 py-2">{l.product_name}</td>
                        <td className="px-3 py-2 text-right font-mono">{l.expected_qty}</td>
                        <td className="px-3 py-2 text-right font-mono">{l.counted_qty}</td>
                        <td className={`px-3 py-2 text-right font-mono ${l.variance < 0 ? 'text-danger' : ''}`}>{l.variance > 0 ? '+' : ''}{l.variance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.products_not_counted > 0 && <p className="text-xs text-text-muted mb-3">{detail.products_not_counted} product(s) with stock were not part of this count.</p>}
              {canDecide ? (
                <>
                  <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} /> Also correct the system stock to the counted figures</label>
                  <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Note (needed to reject)" className={`${inputCls} mb-3`} />
                  <div className="flex gap-2">
                    <button onClick={() => review(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium text-danger">Reject</button>
                    <button onClick={() => review(true)} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Approve</button>
                  </div>
                </>
              ) : <button onClick={() => setReviewing(null)} className="w-full py-2.5 rounded-lg border border-line text-sm font-medium">Close</button>}
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
