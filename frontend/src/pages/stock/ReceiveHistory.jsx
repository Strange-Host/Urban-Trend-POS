import Pager from '../../components/Pager';
import { Badge, Table } from './shared';
import { kes } from './helpers';

// Every shipment received, newest first, with its batches, expiry dates, recalls and new-product status. Shared by both layouts.
export default function ReceiveHistory({ receipts, isLoading, pager, data }) {
  return (
    <>
      <Table head={['Date', 'Supplier', 'Received by', 'Units', 'Items']} loading={isLoading} empty={receipts.length === 0 && 'No shipments recorded yet.'}>
        {receipts.map((r) => (
          <tr key={r.id} className="border-b border-line last:border-0 align-top">
            <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">{r.received_on}</td>
            <td className="px-4 py-3">{r.supplier_name || <span className="text-text-muted">—</span>}{r.reference && <div className="text-xs text-text-muted">Ref {r.reference}</div>}</td>
            <td className="px-4 py-3 whitespace-nowrap">{r.received_by_name}</td>
            <td className="px-4 py-3 font-mono">{r.total_units}</td>
            <td className="px-4 py-3 text-text-muted">
              {r.items.map((i) => (
                <div key={i.id} className="flex items-center gap-2">
                  <span>{i.quantity} × {i.product_name}</span>
                  {i.batch_no && <span className="text-xs">batch {i.batch_no}</span>}
                  {i.expiry_date && <span className="px-1.5 py-0.5 rounded bg-paper border border-line text-xs">expires {i.expiry_date}</span>}
                  {i.recalled_at && <span className="px-1.5 py-0.5 rounded bg-danger-soft text-danger text-xs">recalled</span>}
                  {i.is_new_product === 1 && <span className="px-1.5 py-0.5 rounded bg-paper border border-line text-xs">new · {kes(i.sell_price)}</span>}
                  {i.product_status === 'pending' && <Badge status="pending" />}
                  {i.product_status === 'rejected' && <Badge status="rejected" />}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </Table>
      <Pager pager={pager} data={data} noun="shipments" />
    </>
  );
}
