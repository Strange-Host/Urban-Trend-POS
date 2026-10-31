import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast, useDialog } from '../../context/UIContext';
import { StatusPill } from '../DataUI';
import { money, shortDate, COST_KIND_LABELS, COST_TONE } from './format';

/**
 * Courier costs (fuel, return trip, ...) for one courier or for everyone, filtered by status.
 * Approve / reject are shown only to people with couriers.costs.approve, and never on a cost the
 * viewer entered themselves (the API refuses that: a cost needs a second person).
 */
export default function CostsPanel({ courierId, status, empty = 'No costs to show.', showCourier = !courierId }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const canDecide = can('couriers.costs.approve');

  const params = { ...(courierId ? { courier_id: courierId } : {}), ...(status ? { status } : {}) };
  const { data: costs = [], isLoading, error } = useQuery({
    queryKey: ['couriers', 'costs', params],
    queryFn: () => couriersApi.costs(params).then((r) => r.data.data),
    enabled: canDecide,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['couriers'] });
  const approve = useMutation({
    mutationFn: (id) => couriersApi.approveCost(id),
    onSuccess: () => { toast.success('Cost approved. It is now owed to the courier.'); refresh(); },
    onError: (err) => toast.error(getErrorMessage(err, 'Could not approve the cost.')),
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }) => couriersApi.rejectCost(id, { reason }),
    onSuccess: () => { toast.success('Cost rejected.'); refresh(); },
    onError: (err) => toast.error(getErrorMessage(err, 'Could not reject the cost.')),
  });

  async function onApprove(c) {
    const ok = await dialog.confirm({
      title: `Approve ${money(c.amount)}?`,
      message: `${COST_KIND_LABELS[c.kind] || c.kind} for ${c.courier_name}. Once approved it is owed to the courier and can be paid out.`,
      confirmLabel: 'Approve',
    });
    if (ok) approve.mutate(c.id);
  }
  async function onReject(c) {
    const reason = await dialog.prompt({
      title: `Reject ${money(c.amount)}?`, message: `${COST_KIND_LABELS[c.kind] || c.kind} for ${c.courier_name}.`,
      placeholder: 'Reason (shown on the record)', required: true, confirmLabel: 'Reject',
    });
    if (reason && reason.trim()) reject.mutate({ id: c.id, reason: reason.trim() });
  }

  if (!canDecide) return null;
  if (error) return <div className="px-4 py-3 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(error, 'Could not load courier costs.')}</div>;

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
      <table className="stack-sm w-full text-sm min-w-[640px]">
        <thead>
          <tr className="border-b border-line text-left text-text-muted">
            <th className="px-4 py-3 font-medium">Cost</th>
            <th className="px-4 py-3 font-medium">Entered by</th>
            <th className="px-4 py-3 font-medium text-right">Amount</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
          {!isLoading && costs.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-text-muted">{empty}</td></tr>}
          {costs.map((c) => {
            const own = c.recorded_by === user?.id;
            return (
              <tr key={c.id} className="border-b border-line last:border-0 align-top">
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {COST_KIND_LABELS[c.kind] || c.kind}{showCourier && <span className="text-text-muted font-normal"> · {c.courier_name}</span>}
                  </div>
                  <div className="text-xs text-text-muted">{c.description}{c.order_id ? ` · order #${c.order_id}` : ''}{c.receipt_ref ? ` · receipt ${c.receipt_ref}` : ''}</div>
                  {c.status === 'rejected' && c.decision_reason && <div className="text-xs text-danger mt-0.5">Rejected: {c.decision_reason}</div>}
                </td>
                <td className="px-4 py-3 text-xs text-text-muted">{c.recorded_by_name}<br />{shortDate(c.created_at)}</td>
                <td className="px-4 py-3 text-right font-mono">{money(c.amount)}</td>
                <td className="px-4 py-3">
                  <StatusPill tone={COST_TONE[c.status] || 'neutral'}>{c.status}</StatusPill>
                  {c.status === 'approved' && c.paid ? <> <StatusPill tone="success">paid</StatusPill></> : null}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {c.status === 'pending' && (own
                    ? <span className="text-xs text-text-muted" title="Someone else has to decide on a cost you entered">Awaiting someone else</span>
                    : (
                      <>
                        <button onClick={() => onApprove(c)} disabled={approve.isPending} className="text-xs font-medium text-success hover:opacity-70 mr-3 disabled:opacity-50">Approve</button>
                        <button onClick={() => onReject(c)} disabled={reject.isPending} className="text-xs font-medium text-danger hover:opacity-70 disabled:opacity-50">Reject</button>
                      </>
                    ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
