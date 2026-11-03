import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ordersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useDialog, useToast } from '../context/UIContext';

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });

// When one customer has asked for more than one product (several forms, several orders), say so and offer to merge
// them into one order and one parcel. Nothing is merged without an explicit yes: the dialog below is that permission,
// and the server refuses a merge that was not confirmed. Only orders still awaiting dispatch, with nothing paid, qualify.
export default function MergeOrdersNotice({ order, onMerged, onSelect }) {
  const dialog = useDialog();
  const toast = useToast();
  const queryClient = useQueryClient();
  const enabled = order.status === 'awaiting_dispatch';

  const { data: groups = [] } = useQuery({
    queryKey: ['orders', 'merge-groups', order.id],
    queryFn: () => ordersApi.mergeGroups(order.id).then((r) => r.data.data),
    enabled,
  });
  const group = groups[0];
  if (!enabled || !group) return null;

  const keepId = group.suggested_keep_order_id;
  const others = group.orders.filter((o) => o.id !== keepId);
  const label = (o) => o.product_code || `#${o.id}`;

  async function merge() {
    const ok = await dialog.confirm({
      title: `Merge ${group.orders.length} orders into one?`,
      message: `${group.customer_name} asked for products on ${group.orders.length} separate orders. Merging puts every item on ${label(group.orders.find((o) => o.id === keepId))}, `
        + `works out one delivery fee for one parcel (combined ${money(group.combined_subtotal)} before delivery), and cancels ${others.map(label).join(', ')}. Has the customer agreed?`,
      confirmLabel: 'Yes, merge them',
    });
    if (!ok) return;
    try {
      await ordersApi.mergeOrders(keepId, others.map((o) => o.id));
      toast.success('Orders merged into one.');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onMerged?.(keepId);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not merge those orders.'));
    }
  }

  return (
    <div className="mb-4 px-3 py-3 rounded-lg border border-accent/40 bg-accent/10 text-sm" role="status">
      <div className="font-medium mb-1">{group.customer_name} has asked for more than one product</div>
      <p className="text-xs text-text-muted mb-2">{group.orders.length} orders are waiting for dispatch from the same customer. They can be merged into one.</p>
      <ul className="text-xs font-mono space-y-1 mb-3">
        {group.orders.map((o) => (
          <li key={o.id} className="flex justify-between gap-2">
            <button type="button" onClick={() => onSelect?.(o.id)} className={`text-left truncate hover:underline ${o.id === order.id ? 'font-600' : ''}`}>
              {label(o)} · {o.items.map((i) => `${i.quantity} × ${i.product_name}`).join(', ')}
            </button>
            <span>{money(o.subtotal)}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={merge} className="w-full py-2 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft">Merge into one order…</button>
    </div>
  );
}
