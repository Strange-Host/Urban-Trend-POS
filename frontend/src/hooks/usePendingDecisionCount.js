import { useQuery } from '@tanstack/react-query';
import { ordersApi } from '../api/endpoints';

// How many damaged returns are waiting on the owner. Drives the badge on the Orders "Needs decision" tab.
/** @param {boolean} enabled */
export default function usePendingDecisionCount(enabled) {
  const { data } = useQuery({
    queryKey: ['orders', 'pending-owner-decision', 'count'],
    queryFn: () => ordersApi.pendingOwnerDecision({ page: 1, limit: 1 }).then((r) => r.data.total || 0),
    enabled,
    refetchInterval: 60_000,
  });
  return data || 0;
}
