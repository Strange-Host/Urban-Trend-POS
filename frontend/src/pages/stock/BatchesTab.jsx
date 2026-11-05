import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { stockApi } from '../../api/endpoints';
import { Segmented } from '../../components/Picker';
import { useAuth } from '../../context/AuthContext';
import { useToast, useDialog } from '../../context/UIContext';
import { Table } from './shared';
import { cardCls, kes } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// Batches & alerts: what is expiring, expired or recalled, and damaged stock. Recalling takes the batch off every shelf.
// ---------------------------------------------------------------------------------------------------------------------
const BATCH_STATE = {
  ok: ['OK', 'bg-paper text-text-muted border border-line'],
  expiring: ['Expiring soon', 'bg-accent text-accent-ink'],
  expired: ['Expired', 'bg-danger-soft text-danger'],
  recalled: ['Recalled', 'bg-danger-soft text-danger'],
};

function AlertTile({ label, value, sub, hot }) {
  return (
    <div className={`${cardCls} p-4 ${hot ? 'border-danger' : ''}`}>
      <div className="text-xs text-text-muted mb-1">{label}</div>
      <div className="font-display font-700 text-2xl tabular-nums">{value}</div>
      {sub && <div className="text-xs text-text-muted mt-1">{sub}</div>}
    </div>
  );
}

export default function BatchesTab({ storeParams, isOwnStore }) {
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [status, setStatus] = useState('all');

  const { data: alerts } = useQuery({ queryKey: ['stock', 'alerts', storeParams], queryFn: () => stockApi.alerts(storeParams).then((r) => r.data.data) });
  const { data: batches, isLoading } = useQuery({ queryKey: ['stock', 'batches', storeParams, status], queryFn: () => stockApi.batches({ ...storeParams, status }).then((r) => r.data.data) });
  const { data: damaged } = useQuery({ queryKey: ['stock', 'damaged', storeParams], queryFn: () => stockApi.damaged({ ...storeParams, limit: 10 }).then((r) => r.data) });

  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['stock'] }); queryClient.invalidateQueries({ queryKey: ['inventory'] }); };

  async function recall(b) {
    const label = `${b.product_name}${b.batch_no ? ` (batch ${b.batch_no})` : ''}`;
    const note = await dialog.prompt({
      message: `Recall ${label}? Every unit of it still in stock, at the main store or any outlet, comes off sale at once. This cannot be undone. What is the recall about?`,
      required: true, confirmLabel: 'Recall batch',
    });
    if (!note) return;
    try {
      const res = await stockApi.recallBatch(b.batch_id, note);
      const r = res.data.data;
      toast.success(`${r.pulled_from_shelves} unit(s) taken off sale. ${r.already_left_stock} had already left stock.`);
      refresh();
    } catch (err) { toast.error(getErrorMessage(err, 'Could not recall the batch.')); }
  }

  async function writeOff(b) {
    if (!(await dialog.confirm({ message: `Write off ${b.remaining} expired unit(s) of ${b.product_name}? They leave stock now.`, danger: true, confirmLabel: 'Write off' }))) return;
    try {
      await stockApi.issue({ product_id: b.product_id, quantity: b.remaining, reason: 'expired', batch_id: b.batch_id, note: b.batch_no ? `Batch ${b.batch_no}` : undefined });
      toast.success('Expired stock written off.');
      refresh();
    } catch (err) { toast.error(getErrorMessage(err, 'Could not write it off.')); }
  }

  const rows = batches || [];
  const c = alerts?.counts;
  return (
    <>
      {c && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <AlertTile label="Low stock" value={c.low_stock} sub="at or below reorder level" />
          <AlertTile label="Expiring soon" value={c.expiring} sub={`within ${alerts.expiry_alert_days} days`} hot={c.expiring > 0} />
          <AlertTile label="Expired in stock" value={c.expired} sub="still on a shelf" hot={c.expired > 0} />
          <AlertTile label="Recalled" value={c.recalled} sub="batches" hot={c.recalled > 0} />
          <AlertTile label="Damaged, 30 days" value={alerts.damaged.units} sub={alerts.damaged.value !== undefined ? kes(alerts.damaged.value) : `${alerts.damaged.issues} write-off(s)`} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-display font-700 text-sm">Batches</h2>
        <Segmented value={status} onChange={setStatus} aria-label="Batch status" className="max-w-md"
          options={[{ value: 'all', label: 'All' }, { value: 'expiring', label: 'Expiring' }, { value: 'expired', label: 'Expired' }, { value: 'recalled', label: 'Recalled' }]} />
      </div>
      <Table head={['Product', 'Batch', 'Expiry', 'Where', 'On shelf', 'Status', '']} loading={isLoading} empty={rows.length === 0 && 'No batches match. Batches with an expiry date, or that were recalled, appear here.'} min="min-w-[760px]">
        {rows.map((b) => {
          const [label, cls] = BATCH_STATE[b.state] || BATCH_STATE.ok;
          return (
            <tr key={`${b.batch_id}-${b.store_id}`} className="border-b border-line last:border-0 align-top">
              <td className="px-4 py-3">{b.product_name}<div className="text-xs text-text-muted font-mono">{b.sku}</div></td>
              <td className="px-4 py-3">{b.batch_no || <span className="text-text-muted">—</span>}<div className="text-xs text-text-muted">received {b.received_on}</div></td>
              <td className="px-4 py-3 whitespace-nowrap">
                {b.expiry_date ? <><span className="font-mono text-xs">{b.expiry_date}</span>{b.days_left !== null && <div className="text-xs text-text-muted">{b.days_left < 0 ? `${-b.days_left} day(s) ago` : `in ${b.days_left} day(s)`}</div>}</> : <span className="text-text-muted">No expiry</span>}
              </td>
              <td className="px-4 py-3">{b.store_name}</td>
              <td className="px-4 py-3 font-mono">{b.remaining}{b.state === 'recalled' && <div className="text-xs text-text-muted font-sans">{b.quarantined_qty} pulled, {b.units_gone} already left</div>}</td>
              <td className="px-4 py-3"><span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label}</span>{b.recall_note && <div className="text-xs text-text-muted mt-1">{b.recall_note}</div>}</td>
              <td className="px-4 py-3 whitespace-nowrap text-right">
                {isOwnStore && b.state === 'expired' && b.remaining > 0 && can('stock.receive') && <button onClick={() => writeOff(b)} className="text-xs text-danger hover:opacity-70 mr-3">Write off</button>}
                {b.state !== 'recalled' && can('stock.review') && <button onClick={() => recall(b)} className="text-xs text-danger hover:opacity-70">Recall</button>}
              </td>
            </tr>
          );
        })}
      </Table>

      <h2 className="font-display font-700 text-sm mt-8 mb-3">Damaged stock</h2>
      {damaged?.totals?.returns_awaiting_decision > 0 && (
        <p className="mb-3 px-3 py-2 rounded-lg bg-accent text-accent-ink text-sm">{damaged.totals.returns_awaiting_decision} damaged customer return(s) are waiting for an owner decision (write off or dispose) on the Orders page.</p>
      )}
      <Table head={['Date', 'Product', 'Qty', 'Note', 'Issued by']} empty={(damaged?.data || []).length === 0 && 'No damaged stock has been written off.'} min="min-w-[560px]">
        {(damaged?.data || []).map((d) => (
          <tr key={d.id} className="border-b border-line last:border-0">
            <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">{d.issued_on}</td>
            <td className="px-4 py-3">{d.product_name}<div className="text-xs text-text-muted font-mono">{d.sku}</div></td>
            <td className="px-4 py-3 font-mono">{d.quantity}{d.cost_value !== undefined && <div className="text-xs text-text-muted font-sans">{kes(d.cost_value)}</div>}</td>
            <td className="px-4 py-3 text-text-muted">{d.note || '—'}</td>
            <td className="px-4 py-3 whitespace-nowrap">{d.issued_by_name}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
