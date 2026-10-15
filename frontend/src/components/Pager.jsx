import { useState, useCallback } from 'react';

const SIZES = [25, 50, 100];

/**
 * State for a paged list. Spread `params` into the API call: it sends the page number and the
 * size under BOTH names the backend uses (older modules say `pageSize`, newer ones `limit`), so
 * one hook works for every list. Call reset() whenever a filter/search/tab changes - staying on
 * page 7 of a list that now has 2 pages shows an empty table.
 */
export function usePager(initialSize = 25) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialSize);
  const reset = useCallback(() => setPage(1), []);
  const setPageSize = useCallback((n) => { setPageSizeState(n); setPage(1); }, []);
  return { page, pageSize, setPage, setPageSize, reset, params: { page, limit: pageSize, pageSize } };
}

function windowed(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const set = new Set([1, totalPages, page, page - 1, page + 1, page - 2, page + 2].filter((n) => n >= 1 && n <= totalPages));
  const out = [];
  [...set].sort((a, b) => a - b).forEach((n, i, arr) => {
    if (i > 0 && n - arr[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

/**
 * <Pager pager={pager} data={response} noun="orders" />
 * `data` is the API response ({ total, totalPages, page }). Renders nothing for an empty list, and
 * ALWAYS shows "Showing 1-25 of 312" when there is more than one page - so nobody is left
 * wondering whether the rest of the list exists.
 */
export default function Pager({ pager, data, noun = 'items', className = '' }) {
  if (!data || !data.total) return null;
  const total = data.total;
  const size = pager.pageSize;
  const totalPages = Math.max(data.totalPages || Math.ceil(total / size), 1);
  const page = Math.min(pager.page, totalPages);
  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  if (totalPages <= 1 && total <= SIZES[0]) {
    return <div className={`mt-3 text-xs text-text-muted ${className}`}>Showing all {total} {noun}</div>;
  }
  const btn = 'min-w-8 h-8 px-2 rounded-lg text-sm border border-line bg-surface hover:border-text-muted disabled:opacity-40 disabled:hover:border-line';
  return (
    <nav aria-label={`${noun} pages`} className={`mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${className}`}>
      <div className="text-xs text-text-muted">
        Showing <b className="text-text">{from}-{to}</b> of <b className="text-text">{total}</b> {noun}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1.5 text-xs text-text-muted mr-2">
          Per page
          <select value={size} onChange={(e) => pager.setPageSize(Number(e.target.value))} className="px-1.5 py-1 rounded-md border border-line bg-surface text-xs text-text">
            {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" className={btn} disabled={page <= 1} onClick={() => pager.setPage(page - 1)} aria-label="Previous page">‹ Prev</button>
        {windowed(page, totalPages).map((n, i) => (n === '…'
          ? <span key={`gap-${i}`} className="px-1 text-text-muted">…</span>
          : <button key={n} type="button" onClick={() => pager.setPage(n)} aria-current={n === page ? 'page' : undefined}
              className={`${btn} ${n === page ? '!bg-ink !text-white !border-ink' : ''}`}>{n}</button>))}
        <button type="button" className={btn} disabled={page >= totalPages} onClick={() => pager.setPage(page + 1)} aria-label="Next page">Next ›</button>
      </div>
    </nav>
  );
}
