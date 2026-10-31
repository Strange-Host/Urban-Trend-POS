import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import PayoutReceipt from './PayoutReceipt';
import { money, shortDate, METHOD_LABELS } from './format';

export default function PayoutsTab({ courier }) {
  const [open, setOpen] = useState(null);
  const { data: payouts = [], isLoading, error } = useQuery({
    queryKey: ['couriers', 'payouts', courier.id],
    queryFn: () => couriersApi.payouts({ courier_id: courier.id }).then((r) => r.data.data),
  });
  if (isLoading) return <p className="text-sm text-text-muted py-6">Loading…</p>;
  if (error) return <div className="px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(error, 'Could not load payouts.')}</div>;
  if (payouts.length === 0) return <p className="text-sm text-text-muted text-center py-8 border border-dashed border-line rounded-xl">No payouts to {courier.name} yet.</p>;
  return (
    <>
      <div className="border border-line rounded-xl overflow-hidden scroll-x">
        <table className="w-full text-sm min-w-[480px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Method</th>
              <th className="px-3 py-2 font-medium">Paid by</th>
              <th className="px-3 py-2 font-medium text-right">Total</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2">{shortDate(p.created_at)}</td>
                <td className="px-3 py-2">{METHOD_LABELS[p.method] || p.method}{p.payment_ref ? <span className="text-text-muted"> · {p.payment_ref}</span> : null}</td>
                <td className="px-3 py-2 text-text-muted">{p.paid_by_name}</td>
                <td className="px-3 py-2 text-right font-mono">{money(p.total)}<div className="text-[11px] text-text-muted">{p.item_count} item{p.item_count === 1 ? '' : 's'}</div></td>
                <td className="px-3 py-2 text-right"><button onClick={() => setOpen(p.id)} className="text-xs font-medium text-text-muted hover:text-text">Receipt</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <PayoutReceipt payoutId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
