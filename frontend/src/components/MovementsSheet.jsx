import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { inventoryApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import Pager, { usePager } from './Pager';
import Sheet from './Sheet';
import { SkeletonRows } from './Skeleton';
import { EmptyRow } from './EmptyState';

// Why a quantity is what it is: every stock change for one product at one branch, newest first. Each row is a line
// in the movement ledger, the same record the reconcile check compares the cached quantity against.
//
//   <MovementsSheet product={{ id, name, sku }} storeParams={{ store_id }} onClose={close} />
//
// storeParams is empty for the caller's own branch, or { store_id } when a reviewer is looking at another one.

export const REASON_LABEL = {
  sale: 'Sale', void: 'Sale voided', restock: 'Restocked', adjustment: 'Adjusted', return: 'Customer return',
  requisition: 'Requisition', dispatch: 'Order dispatched', return_resellable: 'Return put back on the shelf',
  receipt: 'Shipment received', issue: 'Issued out', transfer_out: 'Left on a transfer', transfer_in: 'Arrived on a transfer',
  stocktake: 'Corrected to a count',
};
const REFERENCE_LABEL = {
  sale: 'Sale', order: 'Order', requisition: 'Requisition', adjustment: 'Adjustment',
  receipt: 'Receipt', issue: 'Issue', transfer: 'Transfer', stocktake: 'Count',
};

export const movementLabel = (reason) => REASON_LABEL[reason] || reason;
export const referenceLabel = (m) => (m.reference_type && m.reference_id != null ? `${REFERENCE_LABEL[m.reference_type] || m.reference_type} #${m.reference_id}` : '');
const when = (ts) => (ts ? String(ts).replace('T', ' ').slice(0, 16) : '');
const signed = (n) => (n > 0 ? `+${n}` : String(n));

export default function MovementsSheet({ product, storeParams = {}, onClose }) {
  const pager = usePager(25);
  const { data, isLoading, error } = useQuery({
    queryKey: ['inventory', 'movements', product.id, storeParams, pager.page, pager.pageSize],
    queryFn: () => inventoryApi.movements(product.id, { ...pager.params, ...storeParams }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const rows = data?.data || [];

  return (
    <Sheet onClose={onClose} size="lg" label={`Stock movements for ${product.name}`}>
      <h2 className="font-display font-700 text-lg mb-1">Stock movements</h2>
      <p className="text-xs text-text-muted mb-4">
        {product.name}{product.sku ? <span className="font-mono"> · {product.sku}</span> : null}. Newest first.
      </p>

      {error && <p role="alert" className="mb-3 text-sm text-danger">{getErrorMessage(error, 'Could not load the movements.')}</p>}

      <div className="max-h-[55vh] overflow-auto border border-line rounded-lg">
        <table className="w-full text-sm min-w-[520px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium text-right">Qty</th>
              <th className="px-3 py-2 font-medium">By</th>
              <th className="px-3 py-2 font-medium">Reference</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows cols={5} />}
            {!isLoading && !error && rows.length === 0 && <EmptyRow colSpan={5}>No movements recorded for this product.</EmptyRow>}
            {rows.map((m) => (
              <tr key={m.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{when(m.created_at)}</td>
                <td className="px-3 py-2">{movementLabel(m.reason)}</td>
                <td className={`px-3 py-2 text-right font-mono ${m.change_qty < 0 ? 'text-danger' : ''}`}>{signed(m.change_qty)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{m.user_name || <span className="text-text-muted">System</span>}</td>
                <td className="px-3 py-2 text-text-muted whitespace-nowrap">{referenceLabel(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="movements" />

      <button type="button" onClick={onClose} className="mt-4 w-full py-2.5 rounded-lg border border-line text-sm font-medium hover:bg-paper">Close</button>
    </Sheet>
  );
}
