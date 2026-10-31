import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { StatusPill } from './DataUI';

const PAGE = 5;

function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
}

function day(ts) {
  return ts ? new Date(`${ts.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

// Pass statusLabels/statusTones from the host page so the pills read exactly like the orders list.
export default function CustomerOrderHistory({ customerId, currentOrderId, onSelectOrder, statusLabels = {}, statusTones = {} }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-orders', customerId, page],
    queryFn: () => customersApi.orders(customerId, { page, limit: PAGE }).then((r) => r.data),
    enabled: !!customerId,
    placeholderData: keepPreviousData,
  });

  if (!customerId) return null;
  const s = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

  return (
    <div className="mb-4 border border-line rounded-lg">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2 text-left text-xs font-medium hover:bg-paper rounded-lg">
        <span>
          Customer order history
          {s && <span className="ml-2 text-text-muted font-mono">{s.orders} order{s.orders === 1 ? '' : 's'}{s.outstanding > 0 ? ` · ${money(s.outstanding)} owed` : ''}</span>}
        </span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="border-t border-line">
          {isLoading && <div className="p-3 text-xs text-text-muted">Loading…</div>}
          {error && <div className="p-3 text-xs text-danger">{getErrorMessage(error)}</div>}
          {data && (
            <>
              <div className="grid grid-cols-3 gap-2 px-3 py-2 text-xs font-mono text-text-muted border-b border-line">
                <div>Ordered<br /><span className="text-text">{money(s.total_ordered)}</span></div>
                <div>Paid<br /><span className="text-text">{money(s.total_paid)}</span></div>
                <div>Since<br /><span className="text-text">{day(s.first_order_at)}</span></div>
              </div>
              {(s.returned > 0 || s.cancelled > 0) && (
                <div className="px-3 py-1.5 text-xs text-text-muted border-b border-line">
                  {s.returned > 0 && `${s.returned} returned`}{s.returned > 0 && s.cancelled > 0 && ' · '}{s.cancelled > 0 && `${s.cancelled} cancelled`}
                </div>
              )}
              <ul className="divide-y divide-line">
                {data.data.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => onSelectOrder?.(o.id)} disabled={o.id === currentOrderId}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-paper disabled:bg-paper disabled:cursor-default">
                      <span>
                        <span className="font-mono font-medium">{o.product_code}</span>
                        <span className="ml-2 text-text-muted">{day(o.created_at)} · {o.item_count} item{o.item_count === 1 ? '' : 's'}{o.id === currentOrderId ? ' · this order' : ''}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="font-mono">{money(o.total)}</span>
                        <StatusPill tone={statusTones[o.status]}>{statusLabels[o.status] || o.status}</StatusPill>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {pages > 1 && (
                <div className="flex items-center justify-between px-3 py-2 text-xs border-t border-line">
                  <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="disabled:opacity-40">Newer</button>
                  <span className="text-text-muted">Page {page} of {pages}</span>
                  <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages} className="disabled:opacity-40">Older</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
