import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { paymentReconciliationApi, ordersApi, custodyApi } from '../api/endpoints';
import { USE_NEW_SERVER as NEW } from '../api/newServer';
import { getErrorMessage } from '../api/client';
import { PageHeader } from '../components/DataUI';
import { useDialog, useToast } from '../context/UIContext';
import Pager, { usePager } from '../components/Pager';

function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
}

// Cash taken at the shop is held by the person who took it until it is deposited or handed to the till. It sits here, with the
// other money that is waiting for a decision, and gets older on the money-at-risk page until someone clears it.
function CashHeld() {
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState(null);
  const { data } = useQuery({ queryKey: ['custody'], queryFn: () => custodyApi.list().then((r) => r.data.data) });
  const rows = data || [];
  if (rows.length === 0) return null;

  async function deposit(row) {
    if (!(await dialog.confirm({ message: `Mark ${money(row.amount)} held by ${row.holder} as deposited?` }))) return;
    setBusyId(row.id);
    try {
      await custodyApi.deposit(row.id);
      queryClient.invalidateQueries({ queryKey: ['custody'] });
      queryClient.invalidateQueries({ queryKey: ['money-at-risk'] });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not record this deposit.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-8">
      <h2 className="font-display font-600 mb-1">Shop cash waiting to be deposited</h2>
      <p className="text-text-muted text-sm mb-3">Cash taken at the shop stays with the person who took it until it is deposited or handed to the till.</p>
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <table className="stack-sm w-full text-sm">
          <thead className="bg-paper text-text-muted font-mono text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3">Taken</th>
              <th className="text-left px-4 py-3">Held by</th>
              <th className="text-left px-4 py-3">Order</th>
              <th className="text-right px-4 py-3">Amount</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3 font-mono text-xs text-text-muted">{new Date(r.opened_at).toLocaleString()}</td>
                <td className="px-4 py-3">{r.holder}</td>
                <td className="px-4 py-3 font-mono text-xs">{r.order_id}{r.receipt_no ? ` · ${r.receipt_no}` : ''}</td>
                <td className="px-4 py-3 text-right font-mono font-600">{money(r.amount)}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => deposit(r)} disabled={busyId === r.id}
                    className="px-3 py-1.5 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft disabled:opacity-50">
                    Deposited
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PaymentReconciliation() {
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(null);   // the notification being resolved
  const [orderSearch, setOrderSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['payment-reconciliation', 'unmatched', { page: pager.page, size: pager.pageSize }],
    queryFn: () => paymentReconciliationApi.unmatched(pager.params).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const rows = data?.data || [];

  // Candidate orders to match a stray payment against. Searched on demand
  // rather than listed upfront — the whole point of this screen is that
  // the payment DIDN'T carry a usable code, so there's nothing to
  // pre-filter on; a human recognises the customer by name or phone.
  const { data: orderResults } = useQuery({
    queryKey: ['orders', 'reconcile-search', orderSearch],
    queryFn: () => ordersApi.list({ search: orderSearch, limit: 10 }).then((r) => r.data),
    enabled: !!selected && orderSearch.trim().length >= 3,
  });

  // New server: orders this money probably belongs to (same phone, or owing exactly this amount), so a person need not search at all.
  const { data: suggested } = useQuery({
    queryKey: ['payment-reconciliation', 'suggestions', selected?.id],
    queryFn: () => paymentReconciliationApi.suggestions(selected.id).then((r) => r.data.data),
    enabled: NEW && !!selected,
  });

  async function handleMatch(orderId) {
    setBusy(true);
    setError('');
    try {
      await paymentReconciliationApi.match(selected.id, orderId);
      queryClient.invalidateQueries({ queryKey: ['payment-reconciliation'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      setSelected(null);
      setOrderSearch('');
    } catch (err) {
      setError(getErrorMessage(err, 'Could not match this payment.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleIgnore(row) {
    const notes = await dialog.prompt(NEW
      ? 'Why is this payment being refunded? (required, e.g. paid by mistake)'
      : 'Why is this payment being ignored? (e.g. provider test transaction)');
    if (notes === null) return; // cancelled the prompt
    if (NEW && !notes.trim()) { setError('Say why this payment is being refunded.'); return; }
    setBusy(true);
    setError('');
    try {
      await paymentReconciliationApi.ignore(row.id, notes || undefined);
      queryClient.invalidateQueries({ queryKey: ['payment-reconciliation'] });
      if (selected?.id === row.id) setSelected(null);
    } catch (err) {
      setError(getErrorMessage(err, NEW ? 'Could not refund this payment.' : 'Could not ignore this payment.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <PageHeader
        eyebrow={data?.total > 0 ? `${data.total} unresolved` : 'All clear'}
        title="Payment reconciliation"
        description="Payments that arrived from M-Pesa or KCB but couldn't be matched to an order automatically — usually because the customer didn't quote the order code, or someone else paid on their behalf. Nothing here is discarded automatically; each one needs a decision."
        meta={data?.total > 0 ? `${money(data.summary?.unallocated || 0)}\nunallocated (${data.total})` : null}
      />

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      {isLoading && <div className="text-text-muted text-sm">Loading…</div>}

      {!isLoading && rows.length === 0 && (
        <div className="bg-surface border border-line rounded-xl p-10 text-center">
          <div className="text-success font-display font-600 mb-1">Nothing to reconcile.</div>
          <p className="text-text-muted text-sm">
            Every payment received so far matched an order automatically.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <table className="stack-sm w-full text-sm">
            <thead className="bg-paper text-text-muted font-mono text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Received</th>
                <th className="text-left px-4 py-3">Source</th>
                <th className="text-left px-4 py-3">Payer</th>
                <th className="text-left px-4 py-3">Reference</th>
                <th className="text-right px-4 py-3">Amount</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.id} className={selected?.id === row.id ? 'bg-accent/10' : ''}>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 uppercase font-mono text-xs">{row.source}</td>
                  <td className="px-4 py-3">{row.payer_name || <span className="text-text-muted">—</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {row.external_reference || '—'}
                    {row.matched_code && (
                      <div className="text-danger">
                        code {row.matched_code} found, but that order can't take a payment
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-600">{money(row.amount)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => { setSelected(row); setOrderSearch(''); setError(''); }}
                      className="px-3 py-1.5 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft"
                    >
                      Match to order
                    </button>
                    <button
                      onClick={() => handleIgnore(row)}
                      disabled={busy}
                      className="ml-2 px-3 py-1.5 rounded-lg border border-line text-xs hover:border-text-muted disabled:opacity-50"
                    >
                      {NEW ? 'Refund' : 'Ignore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager pager={pager} data={data} noun="unmatched payments" />

      {/* Match panel */}
      {selected && (
        <div className="mt-6 bg-surface border border-line rounded-xl p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="font-display font-600 mb-0.5">
                Match {money(selected.amount)} from {selected.payer_name || 'unknown payer'}
              </h2>
              <p className="text-text-muted text-xs font-mono">
                {selected.source.toUpperCase()} · {selected.external_reference || 'no reference'} ·
                {' '}{new Date(selected.created_at).toLocaleString()}
              </p>
            </div>
            <button onClick={() => setSelected(null)} className="text-text-muted hover:text-text" aria-label="Close">✕</button>
          </div>

          {NEW && (suggested || []).length > 0 && (
            <div className="mb-4">
              <div className="text-sm font-medium mb-1.5">Likely orders</div>
              <div className="divide-y divide-line border border-line rounded-lg overflow-hidden">
                {suggested.map((o) => (
                  <div key={o.id} className="px-4 py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{o.customer_name} <span className="font-mono text-xs text-text-muted">{o.id}</span></div>
                      <div className="text-xs text-text-muted font-mono">
                        outstanding {money(o.outstanding)}
                        {o.same_phone && <span className="text-success"> · same phone number</span>}
                        {o.exact_amount && <span className="text-success"> · exact amount</span>}
                      </div>
                    </div>
                    <button onClick={() => handleMatch(o.id)} disabled={busy}
                      className="px-3 py-1.5 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft disabled:opacity-50 shrink-0">
                      Match
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <label className="block text-sm font-medium mb-1.5">Find the order this belongs to</label>
          <input
            autoFocus
            value={orderSearch}
            onChange={(e) => setOrderSearch(e.target.value)}
            placeholder="Customer name or phone (at least 3 characters)…"
            className="w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none mb-3"
          />

          {orderSearch.trim().length >= 3 && (
            <div className="divide-y divide-line border border-line rounded-lg overflow-hidden">
              {(orderResults?.data || []).length === 0 && (
                <div className="px-4 py-6 text-center text-text-muted text-sm">No orders match that search.</div>
              )}
              {(orderResults?.data || []).map((o) => {
                const outstanding = o.total - o.amount_paid;
                const exact = outstanding === selected.amount;
                return (
                  <div key={o.id} className="px-4 py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {o.customer_name} <span className="font-mono text-xs text-text-muted">{o.product_code}</span>
                      </div>
                      <div className="text-xs text-text-muted font-mono">
                        {o.customer_phone} · {o.status.replace(/_/g, ' ')} · outstanding {money(outstanding)}
                        {exact && <span className="text-success"> · exact match</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => handleMatch(o.id)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft disabled:opacity-50 shrink-0"
                    >
                      Match
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-text-muted text-xs mt-3">
            Matching records this payment against the order and updates its paid status. If the amount doesn't
            cover the full balance the order becomes partially paid, same as any other partial payment.
          </p>
        </div>
      )}

      {NEW && <CashHeld />}
    </div>
  );
}
