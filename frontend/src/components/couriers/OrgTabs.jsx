import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { useToast } from '../../context/UIContext';
import Sheet from '../Sheet';
import StatCard from '../StatCard';
import { StatusPill } from '../DataUI';
import { toCents } from '../../utils/splitPayment';
import { money, shortDate, inputCls } from './format';
import { LoadingBlock } from '../Skeleton';

const Err = ({ error, fallback }) => <div className="px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(error, fallback)}</div>;
const Empty = ({ children }) => <p className="text-sm text-text-muted text-center py-8 border border-dashed border-line rounded-xl">{children}</p>;

// ---------------------------------------------------------------- Standing

export function StandingTab({ courier }) {
  const { data: s, isLoading, error } = useQuery({
    queryKey: ['couriers', 'standing', courier.id],
    queryFn: () => couriersApi.standing(courier.id).then((r) => r.data.data),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <Err error={error} fallback="Could not load this organization's standing." />;
  return (
    <div>
      {s.paused && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">
          New collect-on-delivery parcels to {courier.name} are paused: the overdue balance is over its limit.
        </div>
      )}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Held, not remitted" value={money(s.outstanding)} />
        <StatCard label={`Overdue (after ${courier.overdue_after_days ?? 14} days)`} value={money(s.overdue)} />
        <StatCard label="Overdue limit" value={s.limit === null || s.limit === undefined ? 'None' : money(s.limit)} />
      </div>
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Age of what is held</h3>
      <ul className="border border-line rounded-lg divide-y divide-line text-sm">
        {s.buckets.map((b) => (
          <li key={b.label} className="px-3 py-2 flex justify-between"><span>{b.label} days</span><span className="font-mono">{money(b.cents)}</span></li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Collections

export function CollectionsTab({ courier }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ order_id: '', amount: '', collected_on: '' });
  const [error, setError] = useState('');

  const { data: rows = [], isLoading, error: loadError } = useQuery({
    queryKey: ['couriers', 'collections', courier.id],
    queryFn: () => couriersApi.collections(courier.id).then((r) => r.data.data),
  });

  const record = useMutation({
    mutationFn: (payload) => couriersApi.recordCollection(courier.id, payload),
    onSuccess: () => {
      toast.success('Collection recorded.');
      queryClient.invalidateQueries({ queryKey: ['couriers'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      setOpen(false); setForm({ order_id: '', amount: '', collected_on: '' });
    },
    onError: (err) => setError(getErrorMessage(err, 'Could not record the collection.')),
  });

  function submit(e) {
    e.preventDefault();
    setError('');
    const orderId = Number(form.order_id);
    const amount = toCents(form.amount);
    if (!Number.isInteger(orderId) || orderId <= 0) { setError('Enter the order number.'); return; }
    if (!amount) { setError('Enter the amount in KES, greater than zero.'); return; }
    record.mutate({ order_id: orderId, amount, ...(form.collected_on ? { collected_on: form.collected_on } : {}) });
  }

  return (
    <div>
      {!courier.collects_payment
        ? <Empty>{courier.name} does not collect payment, so there are no collections to record.</Empty>
        : (
          <>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-text-muted">Collected for customers and not yet on a statement.</p>
              <button onClick={() => { setError(''); setOpen(true); }} className="px-3.5 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">+ Record collection</button>
            </div>
            {isLoading && <LoadingBlock />}
            {loadError && <Err error={loadError} fallback="Could not load collections." />}
            {!isLoading && !loadError && rows.length === 0 && <Empty>No open collections.</Empty>}
            {rows.length > 0 && (
              <div className="border border-line rounded-xl overflow-hidden scroll-x">
                <table className="w-full text-sm min-w-[360px]">
                  <thead><tr className="border-b border-line text-left text-text-muted">
                    <th className="px-3 py-2 font-medium">Order</th><th className="px-3 py-2 font-medium">Collected</th><th className="px-3 py-2 font-medium text-right">Amount</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((k) => (
                      <tr key={k.id} className="border-b border-line last:border-0">
                        <td className="px-3 py-2">{k.product_code || `#${k.order_id}`}</td>
                        <td className="px-3 py-2 text-text-muted">{shortDate(k.collected_on)}</td>
                        <td className="px-3 py-2 text-right font-mono">{money(k.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

      {open && (
        <Sheet onClose={() => setOpen(false)} size="sm" as="form" onSubmit={submit} zIndex={60} label="Record collection">
          <h2 className="font-display font-700 text-lg mb-4">Record a collection by {courier.name}</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <label htmlFor="col-order" className="block text-xs font-medium text-text-muted mb-1">Order number</label>
          <input id="col-order" inputMode="numeric" value={form.order_id} onChange={(e) => setForm({ ...form, order_id: e.target.value })} className={`${inputCls} mb-3`} />
          <label htmlFor="col-amount" className="block text-xs font-medium text-text-muted mb-1">Amount collected (KES)</label>
          <input id="col-amount" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={`${inputCls} mb-3`} />
          <label htmlFor="col-date" className="block text-xs font-medium text-text-muted mb-1">Collected on (optional, defaults to today)</label>
          <input id="col-date" type="date" value={form.collected_on} onChange={(e) => setForm({ ...form, collected_on: e.target.value })} className={`${inputCls} mb-5`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={record.isPending} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{record.isPending ? 'Saving…' : 'Record'}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Statements

const blankStatement = { period_start: '', period_end: '', charge_entered: '', remitted: '', remittance_ref: '' };

export function StatementsTab({ courier }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blankStatement);
  const [picked, setPicked] = useState(new Set());
  const [error, setError] = useState('');

  const { data: statements = [], isLoading, error: loadError } = useQuery({
    queryKey: ['couriers', 'statements', courier.id],
    queryFn: () => couriersApi.statements(courier.id).then((r) => r.data.data),
  });
  const { data: openCollections = [] } = useQuery({
    queryKey: ['couriers', 'collections', courier.id],
    queryFn: () => couriersApi.collections(courier.id).then((r) => r.data.data),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: (payload) => couriersApi.createStatement(courier.id, payload),
    onSuccess: () => {
      toast.success('Statement recorded.');
      queryClient.invalidateQueries({ queryKey: ['couriers'] });
      setOpen(false); setForm(blankStatement); setPicked(new Set());
    },
    onError: (err) => setError(getErrorMessage(err, 'Could not record the statement.')),
  });

  const toggle = (id) => setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickedTotal = openCollections.filter((k) => picked.has(k.id)).reduce((n, k) => n + k.amount, 0);

  function submit(e) {
    e.preventDefault();
    setError('');
    if (picked.size === 0) { setError('Tick the parcels this statement covers.'); return; }
    const charge = toCents(form.charge_entered);
    const remitted = toCents(form.remitted);
    if (charge === null || remitted === null) { setError('Amounts must be in KES, for example 1500 or 1500.50.'); return; }
    create.mutate({
      period_start: form.period_start, period_end: form.period_end, collection_ids: [...picked],
      charge_entered: charge, remitted, remittance_ref: form.remittance_ref.trim() || null,
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-text-muted">Statements net our package fees off what the organization remits.</p>
        <button onClick={() => { setError(''); setOpen(true); }} className="px-3.5 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">+ New statement</button>
      </div>
      {isLoading && <LoadingBlock />}
      {loadError && <Err error={loadError} fallback="Could not load statements." />}
      {!isLoading && !loadError && statements.length === 0 && <Empty>No statements yet.</Empty>}
      {statements.length > 0 && (
        <div className="border border-line rounded-xl overflow-hidden scroll-x">
          <table className="w-full text-sm min-w-[560px]">
            <thead><tr className="border-b border-line text-left text-text-muted">
              <th className="px-3 py-2 font-medium">Period</th>
              <th className="px-3 py-2 font-medium text-right">Collected</th>
              <th className="px-3 py-2 font-medium text-right">Fees netted</th>
              <th className="px-3 py-2 font-medium text-right">Remitted</th>
              <th className="px-3 py-2 font-medium">Check</th>
            </tr></thead>
            <tbody>
              {statements.map((s) => {
                const clean = s.charge_variance === 0 && s.cash_variance === 0;
                return (
                  <tr key={s.id} className="border-b border-line last:border-0 align-top">
                    <td className="px-3 py-2">{shortDate(s.period_start)} → {shortDate(s.period_end)}{s.remittance_ref ? <div className="text-xs text-text-muted">{s.remittance_ref}</div> : null}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(s.collections)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(s.fees)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(s.remitted)}</td>
                    <td className="px-3 py-2 text-xs">
                      {clean ? <StatusPill tone="success">matches</StatusPill> : (
                        <div className="space-y-0.5">
                          {s.charge_variance !== 0 && <div className="text-danger">Charge differs by {money(Math.abs(s.charge_variance))}</div>}
                          {s.cash_variance !== 0 && <div className="text-danger">Cash {s.cash_variance > 0 ? 'short' : 'over'} by {money(Math.abs(s.cash_variance))}</div>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <Sheet onClose={() => setOpen(false)} size="md" as="form" onSubmit={submit} zIndex={60} label="New statement">
          <h2 className="font-display font-700 text-lg mb-4">New statement from {courier.name}</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label htmlFor="st-start" className="block text-xs font-medium text-text-muted mb-1">Period start</label>
              <input id="st-start" type="date" required value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label htmlFor="st-end" className="block text-xs font-medium text-text-muted mb-1">Period end</label>
              <input id="st-end" type="date" required value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div className="text-xs font-medium text-text-muted mb-1">Parcels covered</div>
          <div className="border border-line rounded-lg max-h-48 overflow-y-auto mb-1 divide-y divide-line text-sm">
            {openCollections.length === 0 && <div className="px-3 py-3 text-text-muted">No open collections to put on a statement.</div>}
            {openCollections.map((k) => (
              <label key={k.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer">
                <input type="checkbox" checked={picked.has(k.id)} onChange={() => toggle(k.id)} />
                <span className="flex-1">{k.product_code || `#${k.order_id}`} <span className="text-text-muted">· {shortDate(k.collected_on)}</span></span>
                <span className="font-mono">{money(k.amount)}</span>
              </label>
            ))}
          </div>
          <div className="text-xs text-text-muted mb-3">Collected on the {picked.size} ticked: <b className="font-mono text-text">{money(pickedTotal)}</b></div>
          <label htmlFor="st-charge" className="block text-xs font-medium text-text-muted mb-1">Their charge for these parcels (KES)</label>
          <input id="st-charge" inputMode="decimal" value={form.charge_entered} onChange={(e) => setForm({ ...form, charge_entered: e.target.value })} className={`${inputCls} mb-3`} />
          <label htmlFor="st-remitted" className="block text-xs font-medium text-text-muted mb-1">Amount remitted to us (KES)</label>
          <input id="st-remitted" inputMode="decimal" value={form.remitted} onChange={(e) => setForm({ ...form, remitted: e.target.value })} className={`${inputCls} mb-3`} />
          <label htmlFor="st-ref" className="block text-xs font-medium text-text-muted mb-1">Remittance reference (optional)</label>
          <input id="st-ref" maxLength={100} value={form.remittance_ref} onChange={(e) => setForm({ ...form, remittance_ref: e.target.value })} className={`${inputCls} mb-5`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={create.isPending} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{create.isPending ? 'Saving…' : 'Record statement'}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
