import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { productsApi } from '../../api/endpoints';
import { SkeletonRows } from '../../components/Skeleton';
import { cardCls, inputCls } from './helpers';

const STATUS_STYLE = {
  pending: 'bg-accent text-accent-ink', submitted: 'bg-accent text-accent-ink',
  approved: 'bg-success-soft text-success', rejected: 'bg-danger-soft text-danger', cancelled: 'bg-paper text-text-muted border border-line',
};
const STATUS_LABEL = { pending: 'Waiting', submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', cancelled: 'Withdrawn' };
export function Badge({ status }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[status] || ''}`}>{STATUS_LABEL[status] || status}</span>;
}

// Type-to-find a product (name, SKU or barcode). Shows what was chosen, with a button to change it.
export function ProductSearch({ value, onChange, placeholder = 'Search by name or SKU…', ariaLabel }) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const { data: results = [] } = useQuery({
    queryKey: ['stock-product-search', term],
    enabled: term.length >= 2,
    queryFn: () => productsApi.list({ q: term, pageSize: 8 }).then((r) => r.data.data),
    staleTime: 15000,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-line bg-paper text-sm">
        <span className="truncate">{value.name} <span className="text-text-muted font-mono text-xs">{value.sku}</span></span>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-text-muted hover:text-text">Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={ariaLabel} className={inputCls} />
      {term.length >= 2 && (
        <ul className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-auto bg-surface border border-line rounded-lg shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-text-muted">No active product matches.</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => { onChange({ id: p.id, name: p.name, sku: p.sku, sell_price: p.sell_price }); setQ(''); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-paper">
                {p.name} <span className="text-text-muted font-mono text-xs">{p.sku}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Table({ head, children, empty, loading, min = 'min-w-[640px]' }) {
  return (
    <div className={`${cardCls} overflow-hidden scroll-x`}>
      <table className={`stack-sm w-full text-sm ${min}`}>
        <thead><tr className="border-b border-line text-left text-text-muted">{head.map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {loading && <SkeletonRows cols={head.length} />}
          {!loading && empty && <tr><td colSpan={head.length} className="px-4 py-8 text-center text-text-muted">{empty}</td></tr>}
          {children}
        </tbody>
      </table>
    </div>
  );
}
