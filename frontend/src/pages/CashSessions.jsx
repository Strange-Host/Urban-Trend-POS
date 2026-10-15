import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { cashSessionsApi } from '../api/endpoints';
import Pager, { usePager } from '../components/Pager';

function variance(session) {
  if (session.closing_amount === null) return null;
  return session.closing_amount - session.expected_amount;
}

export default function CashSessions() {
  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['cash-sessions', { page: pager.page, size: pager.pageSize }],
    queryFn: () => cashSessionsApi.list(pager.params).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <h1 className="font-display font-700 text-2xl mb-1">Cash sessions</h1>
      <p className="text-text-muted text-sm mb-6">Shift-by-shift cash drawer reconciliation — opening float vs. what was actually counted at close.</p>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[760px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Cashier</th>
              <th className="px-4 py-3 font-medium">Opened</th>
              <th className="px-4 py-3 font-medium">Closed</th>
              <th className="px-4 py-3 font-medium text-right">Opening float</th>
              <th className="px-4 py-3 font-medium text-right">Expected</th>
              <th className="px-4 py-3 font-medium text-right">Counted</th>
              <th className="px-4 py-3 font-medium text-right">Variance</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {data?.data.length === 0 && !isLoading && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-text-muted">No cash sessions yet.</td></tr>
            )}
            {data?.data.map((s) => {
              const v = variance(s);
              return (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium">{s.cashier_name}</td>
                  <td className="px-4 py-3 text-text-muted">{new Date(s.opened_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-text-muted">{s.closed_at ? new Date(s.closed_at).toLocaleString() : <span className="text-success">open</span>}</td>
                  <td className="px-4 py-3 text-right font-mono">{(s.opening_amount / 100).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right font-mono">{s.expected_amount !== null ? (s.expected_amount / 100).toFixed(2) : '—'}</td>
                  <td className="px-4 py-3 text-right font-mono">{s.closing_amount !== null ? (s.closing_amount / 100).toFixed(2) : '—'}</td>
                  <td className={`px-4 py-3 text-right font-mono ${v === null ? '' : v === 0 ? 'text-success' : 'text-danger'}`}>
                    {v === null ? '—' : (v > 0 ? '+' : '') + (v / 100).toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="cash sessions" />
    </div>
  );
}
