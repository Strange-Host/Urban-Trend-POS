import { useQuery } from '@tanstack/react-query';
import { approvalsApi, couriersApi, paymentReconciliationApi, stockApi } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import usePendingDecisionCount from './usePendingDecisionCount';

/** @typedef {'danger' | 'warning' | 'accent'} AttentionTone */
/** @typedef {{ id: string, label: string, count: number, detail: string, to: string, tone: AttentionTone }} AttentionItem */

const money = (/** @type {number} */ cents) => `KES ${Math.round(cents / 100).toLocaleString()}`;

/**
 * One source of the queue: asked only when this person may see it (a 403 would be noise), re-asked every minute.
 * @template T
 * @param {string} key
 * @param {boolean} enabled
 * @param {() => Promise<T>} fn
 */
function useSource(key, enabled, fn) {
  return useQuery({ queryKey: ['attention', key], queryFn: fn, enabled, retry: false, staleTime: 30_000, refetchInterval: 60_000 });
}

// What is waiting on a decision, from the places that already hold each one (no new endpoint: Phase 4 combines them here,
// and a single backend endpoint can replace this hook later without touching the screen). Each source is asked for a count
// only (limit 1), and only by people the API would let see it.
//
//   items      the sources with something waiting, worst first
//   quiet      names of the sources that were checked and are clear (for the "All clear" line)
//   count      how many things are waiting in total (the Attention tab's badge)
//   isLoading  true until every source this person can see has answered once
//
// { enabled: false } asks nothing and returns an empty queue: the Dashboard calls this on every render, but only the new
// layout (ut_ui=v2) shows it, so people on the current layout make no extra requests.
/** @param {{ enabled?: boolean }} [options] */
export default function useAttentionQueue({ enabled = true } = {}) {
  // AuthContext is not typed yet (R6 types it with the rest of context/); this is the part of it used here.
  const { can, hasRole } = /** @type {{ can: (permission: string) => boolean, hasRole: (...roles: string[]) => boolean }} */ (useAuth());
  const manager = enabled && Boolean(hasRole('admin', 'manager'));

  const mayReview = enabled && Boolean(can('approvals.review'));
  const mayReconcile = enabled && Boolean(can('payments.reconcile'));
  const mayReviewCounts = enabled && Boolean(can('stock.review') && can('stock.count'));
  const mayReviewTransfers = enabled && Boolean(can('stock.review') && can('stock.transfer'));
  const mayPayCouriers = enabled && Boolean(can('couriers.pay'));

  const approvals = useSource('approvals', mayReview, () => approvalsApi.list({ status: 'pending', limit: 1 }).then((r) => Number(r.data.pending) || 0));
  const unmatched = useSource('unmatched', mayReconcile, () => paymentReconciliationApi.unmatched({ page: 1, limit: 1 }).then((r) => Number(r.data.total) || 0));
  const counts = useSource('counts', mayReviewCounts, () => stockApi.counts({ status: 'submitted', limit: 1 }).then((r) => Number(r.data.total) || 0));
  const transfers = useSource('transfers', mayReviewTransfers, () => stockApi.transfers({ status: 'pending', limit: 1 }).then((r) => Number(r.data.total) || 0));
  const couriers = useSource('couriers', mayPayCouriers, () => couriersApi.payables().then((r) => /** @type {any[]} */ (r.data.data || [])));
  const damagedReturns = usePendingDecisionCount(manager);

  const owed = couriers.data || [];
  const owedTotal = owed.reduce((sum, c) => sum + (c.total_owed || 0), 0);

  /** @type {Array<AttentionItem & { asked: boolean }>} */
  const all = [
    { id: 'damaged', asked: manager, label: 'Damaged returns', count: damagedReturns, tone: 'danger', to: '/orders', detail: 'Waiting on the owner: write off or dispose' },
    { id: 'approvals', asked: mayReview, label: 'Void and refund requests', count: approvals.data || 0, tone: 'accent', to: '/approvals', detail: 'A cashier is waiting for a yes or no' },
    { id: 'unmatched', asked: mayReconcile, label: 'Unmatched M-Pesa', count: unmatched.data || 0, tone: 'warning', to: '/reconciliation', detail: 'Payments received that match no order yet' },
    { id: 'counts', asked: mayReviewCounts, label: 'Counts to review', count: counts.data || 0, tone: 'accent', to: '/stock?tab=counts', detail: 'Submitted stock counts, with any variance, waiting for approval' },
    { id: 'transfers', asked: mayReviewTransfers, label: 'Transfers to approve', count: transfers.data || 0, tone: 'accent', to: '/stock?tab=transfers', detail: 'Stock waiting to move between branches' },
    { id: 'couriers', asked: mayPayCouriers, label: 'Courier balances', count: owed.length, tone: 'warning', to: '/finance?tab=couriers', detail: owed.length ? `${money(owedTotal)} owed to riders, or costs waiting for approval` : 'Riders owed money, or costs waiting for approval' },
  ];

  const asked = all.filter((a) => a.asked);
  const rank = { danger: 0, warning: 1, accent: 2 };
  const items = asked.filter((a) => a.count > 0).sort((a, b) => rank[a.tone] - rank[b.tone]).map(({ asked: _asked, ...item }) => item);
  const quiet = asked.filter((a) => a.count === 0).map((a) => a.label);
  const loading = [
    [mayReview, approvals], [mayReconcile, unmatched], [mayReviewCounts, counts],
    [mayReviewTransfers, transfers], [mayPayCouriers, couriers],
  ].some(([on, q]) => on && /** @type {any} */ (q).isLoading);

  return { items, quiet, count: items.reduce((n, i) => n + i.count, 0), isLoading: loading };
}
