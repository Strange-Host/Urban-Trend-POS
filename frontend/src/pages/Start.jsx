import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { cashSessionsApi, ordersApi } from '../api/endpoints';
import PageHeader from '../components/shell/PageHeader';
import { CLOSE_SHIFT_TO } from '../components/shell/railModel';
import { useAuth } from '../context/AuthContext';
import useOfflineQueue from '../hooks/useOfflineQueue';

// The cashier's home: what a shift usually starts with, one tap each, and how the shift
// stands. Each tile appears only when this person may do that thing, so the screen never offers a dead end. "New sale"
// takes focus on arrival, so Enter goes straight to the till. It decides nothing and changes nothing: every tile is a link
// to a page or state that already exists. "End shift" opens the till with the close-shift form showing.

const kes = (cents) => `KES ${((Number(cents) || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

function Tile({ to, title, note, accent = false, className = '', tileRef }) {
  const look = accent ? 'bg-accent border-accent text-accent-ink' : 'bg-surface border-line text-text hover:border-text-muted';
  return (
    <Link to={to} ref={tileRef} className={`flex min-h-[10.5rem] flex-col justify-end rounded-xl border p-5 transition-colors ${focusRing} ${look} ${className}`}>
      <span className={`font-display font-700 tracking-tight ${accent ? 'text-3xl' : 'text-xl'}`}>{title}</span>
      {note && <span className={`mt-1 text-sm ${accent ? 'opacity-80' : 'text-text-muted'}`}>{note}</span>}
    </Link>
  );
}

export default function Start() {
  const { can } = useAuth();
  const saleRef = useRef(null);
  useEffect(() => { saleRef.current?.focus(); }, []);

  // Same query (and cache entry) as the till's shift widget, so it is one request, not two.
  const { data: session, isSuccess: shiftKnown } = useQuery({
    queryKey: ['cash-session-current'],
    queryFn: () => cashSessionsApi.current().then((r) => r.data.data),
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: toDispatch } = useQuery({
    queryKey: ['start-orders-to-dispatch'],
    queryFn: () => ordersApi.list({ status: 'awaiting_dispatch', limit: 1 }).then((r) => r.data.total),
    refetchInterval: 60_000,
    retry: false,
  });

  const queue = useOfflineQueue((s) => s.queue);
  const waiting = queue.filter((e) => !e.failed).length;
  const rejected = queue.filter((e) => e.failed).length;

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <PageHeader title="What are you doing?" />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="start-tiles">
        <Tile to="/terminal" accent title="New sale" note="Open the till" tileRef={saleRef} className="sm:col-span-2" />
        <Tile to="/orders" title="Online orders" note={typeof toDispatch === 'number' ? `${toDispatch} to dispatch` : 'Dispatch, payments and returns'} />
        {can('stock.receive') && <Tile to="/stock?tab=receive" title="Receive stock" note="Book in a delivery" />}
        {can('stock.count') && <Tile to="/stock?tab=counts" title="Count stock" note="Check what is on the shelf" />}
        {(can('sales.void_request') || can('payments.refund_request')) && <Tile to="/approvals" title="Void or refund" note="Ask a manager to approve" />}
        {session && <Tile to={CLOSE_SHIFT_TO} title="End shift" note="Count the cash and close the till" className="min-h-24 sm:col-span-3" />}
      </div>

      <dl className="mt-7 flex flex-wrap gap-x-14 gap-y-4 border-t border-line pt-5">
        <div>
          <dt className="text-[13px] text-text-muted">{session ? 'Shift opened' : 'Shift'}</dt>
          <dd className="text-xl font-semibold">
            {!shiftKnown ? '–' : session ? clock(session.opened_at) : <>Not open <Link to="/terminal" className="ml-1 text-sm font-normal underline">Open one at the till</Link></>}
          </dd>
        </div>
        {session && (
          <div>
            <dt className="text-[13px] text-text-muted">Sales this shift</dt>
            <dd className="text-xl font-semibold">{kes(session.sales_total)}</dd>
          </div>
        )}
        <div>
          <dt className="text-[13px] text-text-muted">Waiting to sync</dt>
          <dd className="text-xl font-semibold">{waiting} {waiting === 1 ? 'sale' : 'sales'}</dd>
        </div>
        {rejected > 0 && (
          <div>
            <dt className="text-[13px] text-danger">Rejected by the server</dt>
            <dd className="text-xl font-semibold text-danger">{rejected} {rejected === 1 ? 'sale' : 'sales'}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
