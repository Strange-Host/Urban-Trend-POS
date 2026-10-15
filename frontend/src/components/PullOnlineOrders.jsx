import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ordersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 60, label: 'Last 60 days' },
];

// Brings the orders that still need shipping from a connected Shopify / WooCommerce
// store into the Orders page, where they can be confirmed, dispatched, handed to a
// courier and paid against. Already-shipped and cancelled online orders are not
// imported (they stay in Sales history only). Safe to press repeatedly.
export default function PullOnlineOrders({ onPulled }) {
  const { can } = useAuth();
  const allowed = can('orders.pull_online');
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const rootRef = useRef(null);

  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['orders', 'online-sources'],
    queryFn: () => ordersApi.onlineSources().then((r) => r.data.data),
    enabled: allowed,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (sources.length > 0 && !sources.some((s) => String(s.id) === String(sourceId))) setSourceId(String(sources[0].id));
  }, [sources]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  if (!allowed || isLoading) return null;

  async function pull() {
    setBusy(true);
    setResult(null);
    try {
      const res = await ordersApi.pullOnline(Number(sourceId), days);
      setResult({ ok: true, data: res.data.data });
      onPulled?.();
    } catch (err) {
      setResult({ ok: false, text: getErrorMessage(err, 'Could not pull orders.') });
    } finally {
      setBusy(false);
    }
  }

  const d = result?.data;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft whitespace-nowrap"
      >
        Pull online orders
      </button>

      {open && (
        <div role="dialog" aria-label="Pull online orders" className="absolute right-0 mt-2 z-40 w-[22rem] max-w-[calc(100vw-2rem)] bg-surface border border-line rounded-xl shadow-xl p-4">
          {sources.length === 0 ? (
            <div className="text-sm">
              <div className="font-medium mb-1">No store connected yet</div>
              <p className="text-text-muted text-xs">Connect Shopify or WooCommerce first: <b>Settings → Income sources → Add income source</b>, then press <b>Connect</b>.</p>
            </div>
          ) : (
            <>
              <div className="font-medium text-sm mb-1">Pull orders that still need shipping</div>
              <p className="text-xs text-text-muted mb-3">Brings in unshipped orders from your online store so you can confirm, dispatch and track them here. Orders already shipped or cancelled are skipped. Safe to repeat.</p>

              {sources.length > 1 && (
                <>
                  <label className="block text-xs font-medium text-text-muted mb-1" htmlFor="pull-source">Store</label>
                  <select id="pull-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm mb-3 outline-none focus:border-accent">
                    {sources.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.platform === 'shopify' ? 'Shopify' : 'WooCommerce'})</option>)}
                  </select>
                </>
              )}
              <label className="block text-xs font-medium text-text-muted mb-1" htmlFor="pull-days">Look back</label>
              <select id="pull-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm mb-3 outline-none focus:border-accent">
                {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
              </select>
              <button type="button" onClick={pull} disabled={busy || !sourceId} className="w-full py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
                {busy ? 'Pulling…' : sources.length === 1 ? `Pull from ${sources[0].name}` : 'Pull orders'}
              </button>

              {result && !result.ok && <div className="mt-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-xs">{result.text}</div>}
              {d && (
                <div className={`mt-3 px-3 py-2 rounded-lg text-xs ${d.failed ? 'bg-accent/10 text-text' : 'bg-success-soft text-success'}`}>
                  <div className="font-medium mb-0.5">
                    {d.imported} new order{d.imported === 1 ? '' : 's'} added
                    {d.cancelled ? `, ${d.cancelled} cancelled to match the store` : ''}
                  </div>
                  <div className="text-text-muted">
                    Checked {d.found} from the last {d.days} days · {d.skipped} already here · {d.ignored} skipped (already shipped or cancelled)
                  </div>
                  {d.failed > 0 && <div className="mt-1 text-text">{d.failed} could not be added: {d.errors.join('; ')}</div>}
                  {d.hint && <div className="mt-1 text-text-muted">{d.hint}</div>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
