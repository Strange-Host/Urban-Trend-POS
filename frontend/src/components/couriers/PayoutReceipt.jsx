import { useQuery } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import Sheet from '../Sheet';
import { money, shortDate, COST_KIND_LABELS, METHOD_LABELS } from './format';
import { LoadingBlock } from '../Skeleton';

// The record of one payout, read back from the server (GET /couriers/payouts/:id): fee lines and cost lines apart.
export default function PayoutReceipt({ payoutId, onClose }) {
  const { data: p, isLoading, error } = useQuery({
    queryKey: ['couriers', 'payout', payoutId],
    queryFn: () => couriersApi.payout(payoutId).then((r) => r.data.data),
  });

  return (
    <Sheet onClose={onClose} size="md" label="Payout receipt" zIndex={60}>
      <h2 className="font-display font-700 text-lg mb-1">Payout #{payoutId}</h2>
      {isLoading && <LoadingBlock />}
      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(error, 'Could not load the payout.')}</div>}
      {p && (
        <>
          <p className="text-sm text-text-muted mb-4">
            {p.courier_name} · {shortDate(p.created_at)} · {METHOD_LABELS[p.method] || p.method}{p.payment_ref ? ` ${p.payment_ref}` : ''} · paid by {p.paid_by_name}
          </p>

          <h3 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Package fees</h3>
          <ul className="mb-4 text-sm border border-line rounded-lg divide-y divide-line">
            {p.fee_lines.length === 0 && <li className="px-3 py-2 text-text-muted">None in this payout.</li>}
            {p.fee_lines.map((l) => (
              <li key={l.id} className="px-3 py-2 flex justify-between gap-3">
                <span>Order {l.order_code || (l.order_id ? `#${l.order_id}` : '')}</span><span className="font-mono">{money(l.amount)}</span>
              </li>
            ))}
          </ul>

          <h3 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Courier costs</h3>
          <ul className="mb-4 text-sm border border-line rounded-lg divide-y divide-line">
            {p.cost_lines.length === 0 && <li className="px-3 py-2 text-text-muted">None in this payout.</li>}
            {p.cost_lines.map((l) => (
              <li key={l.id} className="px-3 py-2 flex justify-between gap-3">
                <span>{COST_KIND_LABELS[l.kind] || l.kind}: {l.description}{l.receipt_ref ? ` (${l.receipt_ref})` : ''}</span>
                <span className="font-mono">{money(l.amount)}</span>
              </li>
            ))}
          </ul>

          <div className="text-sm space-y-1 mb-5">
            <div className="flex justify-between"><span className="text-text-muted">Fees</span><span className="font-mono">{money(p.fees_total)}</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Costs</span><span className="font-mono">{money(p.costs_total)}</span></div>
            <div className="flex justify-between font-medium text-base pt-1 border-t border-line"><span>Total paid</span><span className="font-mono">{money(p.total)}</span></div>
          </div>
        </>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Close</button>
      </div>
    </Sheet>
  );
}
