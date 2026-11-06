import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ClipboardList, LogOut, Package, PackagePlus, ShoppingCart, Undo2 } from 'lucide-react';
import { cashSessionsApi } from '../api/endpoints';
import PageHeader from '../components/shell/PageHeader';
import ShiftWidget from '../components/ShiftWidget';
import { useAuth } from '../context/AuthContext';

const tileBase = 'flex items-center gap-3 rounded-xl border px-4 py-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent';
const tileClass = (primary) => `${tileBase} ${primary
  ? 'bg-ink text-white border-ink hover:bg-ink-soft'
  : 'bg-surface border-line hover:border-accent'}`;

// The cashier's home under the new layout (ut_ui=v2): what a shift usually starts with, one tap each, and how the shift
// stands. Each tile appears only when this person may do that thing, so the screen never offers a dead end. "New sale"
// takes focus on arrival, so Enter goes straight to the till.
export default function Start() {
  const { user, can } = useAuth();
  const saleRef = useRef(null);
  const [closeRequest, setCloseRequest] = useState(0);

  // Same query (and cache entry) as the shift widget below, so this is one request, not two.
  const { data: session } = useQuery({
    queryKey: ['cash-session-current'],
    queryFn: () => cashSessionsApi.current().then((r) => r.data.data),
    refetchInterval: 30_000,
  });

  useEffect(() => { saleRef.current?.focus(); }, []);

  const tiles = [
    { id: 'sale', label: 'New sale', hint: 'Open the till', to: '/terminal', icon: ShoppingCart, primary: true },
    { id: 'orders', label: 'Online orders', hint: 'Dispatch, payments and returns', to: '/orders', icon: Package },
    can('stock.receive') && { id: 'receive', label: 'Receive stock', hint: 'Book in a delivery', to: '/stock?tab=receive', icon: PackagePlus },
    can('stock.count') && { id: 'count', label: 'Count stock', hint: 'Check what is on the shelf', to: '/stock?tab=counts', icon: ClipboardList },
    (can('sales.void_request') || can('payments.refund_request')) && { id: 'void', label: 'Void or refund', hint: 'Ask a manager to approve', to: '/approvals', icon: Undo2 },
    session && { id: 'end', label: 'End shift', hint: 'Count the drawer and close', onClick: () => setCloseRequest((n) => n + 1), icon: LogOut },
  ].filter(Boolean);

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <PageHeader title="Start" description={user?.name ? `Hello, ${user.name}.` : undefined} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="start-tiles">
        {tiles.map((t) => {
          const Icon = t.icon;
          const body = (
            <>
              <Icon size={22} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">
                <span className="block font-display font-600 text-base leading-tight">{t.label}</span>
                <span className={`block text-xs mt-0.5 ${t.primary ? 'text-white/70' : 'text-text-muted'}`}>{t.hint}</span>
              </span>
            </>
          );
          return t.to ? (
            <Link key={t.id} to={t.to} ref={t.id === 'sale' ? saleRef : undefined} className={tileClass(t.primary)}>{body}</Link>
          ) : (
            <button key={t.id} type="button" onClick={t.onClick} className={tileClass(t.primary)}>{body}</button>
          );
        })}
      </div>

      <h2 className="font-mono text-[11px] uppercase tracking-wider text-text-muted mt-8 mb-2">Shift</h2>
      <ShiftWidget closeRequest={closeRequest} />
    </div>
  );
}
