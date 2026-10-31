import { useQuery } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import StatCard from '../StatCard';
import Panel from '../Panel';
import CostsPanel from './CostsPanel';
import { money } from './format';

// Cross-courier view: who is owed what (riders), and the costs waiting for someone to approve them.
export default function PayablesOverview({ onOpenCourier }) {
  const { can } = useAuth();
  const canPay = can('couriers.pay');
  const canApprove = can('couriers.costs.approve');

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['couriers', 'payables'],
    queryFn: () => couriersApi.payables().then((r) => r.data.data),
    enabled: canPay,
  });

  const fees = rows.reduce((n, r) => n + r.fees_owed, 0);
  const costs = rows.reduce((n, r) => n + r.costs_owed, 0);
  const pending = rows.reduce((n, r) => n + r.pending_costs, 0);

  return (
    <div className="space-y-6">
      {canPay && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Total owed to riders" value={money(fees + costs)} />
            <StatCard label="Package fees" value={money(fees)} />
            <StatCard label="Approved costs" value={money(costs)} />
            <StatCard label="Costs awaiting approval" value={pending} sub={pending ? 'Not owed until approved' : undefined} />
          </div>

          {error && <div className="px-4 py-3 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(error, 'Could not load payables.')}</div>}
          <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
            <table className="stack-sm w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-line text-left text-text-muted">
                  <th className="px-4 py-3 font-medium">Rider</th>
                  <th className="px-4 py-3 font-medium text-right">Fees</th>
                  <th className="px-4 py-3 font-medium text-right">Costs</th>
                  <th className="px-4 py-3 font-medium text-right">Total owed</th>
                  <th className="px-4 py-3 font-medium text-right">Awaiting approval</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {isLoading && <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
                {!isLoading && rows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-text-muted">No rider is owed anything right now.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.courier.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 font-medium">{r.courier.name}<div className="text-xs text-text-muted font-normal">{r.unpaid_items} unpaid item{r.unpaid_items === 1 ? '' : 's'}</div></td>
                    <td className="px-4 py-3 text-right font-mono">{money(r.fees_owed)}</td>
                    <td className="px-4 py-3 text-right font-mono">{money(r.costs_owed)}</td>
                    <td className="px-4 py-3 text-right font-mono font-medium">{money(r.total_owed)}</td>
                    <td className="px-4 py-3 text-right font-mono">{r.pending_costs ? `${r.pending_costs} · ${money(r.pending_costs_amount)}` : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => onOpenCourier(r.courier.id, 'payables')} className="text-xs font-medium text-text-muted hover:text-text">Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {canApprove && (
        <Panel title="Costs awaiting approval" description="Fuel, return trips and other extras. A cost must be decided by someone other than the person who entered it.">
          <div className="px-5 pb-5">
            <CostsPanel status="pending" empty="Nothing waiting for approval." />
          </div>
        </Panel>
      )}
    </div>
  );
}
