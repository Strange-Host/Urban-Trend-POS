import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { stockApi, reportsApi } from '../../api/endpoints';
import { useToast } from '../../context/UIContext';
import { Table } from './shared';
import { btnPrimary, inputCls, kes, toCents } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// Costing: buying price per received batch, and what the stock is worth under FIFO / average.
// ---------------------------------------------------------------------------------------------------------------------
export default function CostingTab({ storeParams }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [costs, setCosts] = useState({});
  const [busy, setBusy] = useState(false);

  const { data: waiting = [], isLoading } = useQuery({ queryKey: ['stock', 'awaiting-cost', storeParams], queryFn: () => stockApi.awaitingCost(storeParams).then((r) => r.data.data) });
  const { data: valuation } = useQuery({ queryKey: ['reports', 'valuation', storeParams], queryFn: () => reportsApi.inventoryValuation(storeParams).then((r) => r.data.data) });

  async function save() {
    const byReceipt = new Map();
    for (const w of waiting) {
      const raw = costs[w.item_id];
      if (raw === undefined || raw === '') continue;
      const c = toCents(raw);
      if (!Number.isFinite(c) || c < 0) return toast.error(`${w.product_name}: the buying price must be zero or more.`);
      if (!byReceipt.has(w.receipt_id)) byReceipt.set(w.receipt_id, []);
      byReceipt.get(w.receipt_id).push({ item_id: w.item_id, unit_cost: c });
    }
    if (byReceipt.size === 0) return toast.info('Enter at least one buying price.');
    setBusy(true);
    try {
      for (const [receiptId, items] of byReceipt) await stockApi.setCosts(receiptId, { items, update_product_cost: true });
      toast.success('Buying prices saved.');
      setCosts({});
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
    } catch (err) { toast.error(getErrorMessage(err, 'Could not save the buying prices.')); } finally { setBusy(false); }
  }

  const rows = valuation?.rows || [];
  const other = valuation && Object.keys(valuation.comparison).find((m) => m !== valuation.method);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="font-display font-700 text-sm">Batches waiting for a buying price</h2>
          <p className="text-xs text-text-muted mt-1 max-w-xl">Until a batch has a price, its stock is valued at the product&apos;s current cost. Sales made meanwhile keep that cost. Saving also makes the newest batch&apos;s price the product&apos;s cost.</p>
        </div>
        <button onClick={save} disabled={busy || waiting.length === 0} className={btnPrimary}>{busy ? 'Saving…' : 'Save prices'}</button>
      </div>
      <Table head={['Received', 'Product', 'Batch', 'Qty', 'Current cost', 'Buying price (KES)']} loading={isLoading} empty={waiting.length === 0 && 'Every received batch has a buying price.'} min="min-w-[720px]">
        {waiting.map((w) => (
          <tr key={w.item_id} className="border-b border-line last:border-0">
            <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">{w.received_on}{w.supplier_name && <div className="font-sans text-text-muted">{w.supplier_name}</div>}</td>
            <td className="px-4 py-3">{w.product_name}<div className="text-xs text-text-muted font-mono">{w.sku}</div></td>
            <td className="px-4 py-3">{w.batch_no || <span className="text-text-muted">—</span>}</td>
            <td className="px-4 py-3 font-mono">{w.quantity}</td>
            <td className="px-4 py-3 font-mono">{kes(w.catalog_cost)}</td>
            <td className="px-4 py-3"><input type="number" min="0" step="0.01" inputMode="decimal" aria-label={`Buying price for ${w.product_name}`} value={costs[w.item_id] ?? ''} onChange={(e) => setCosts({ ...costs, [w.item_id]: e.target.value })} className={`${inputCls} w-32`} /></td>
          </tr>
        ))}
      </Table>

      <div className="flex flex-wrap items-end justify-between gap-3 mt-8 mb-3">
        <div>
          <h2 className="font-display font-700 text-sm">Stock valuation</h2>
          {valuation && <p className="text-xs text-text-muted mt-1">Method: {valuation.method === 'fifo' ? 'FIFO' : 'Average cost'} (change it in Settings). Under {other === 'fifo' ? 'FIFO' : 'average cost'} the same stock would be worth {kes(valuation.comparison[other])}.</p>}
        </div>
        {valuation && <div className="text-right"><div className="text-xs text-text-muted">Total at cost</div><div className="font-display font-700 text-xl tabular-nums">{kes(valuation.totals.total_cost_value)}</div>{valuation.totals.uncosted_units > 0 && <div className="text-xs text-text-muted">{valuation.totals.uncosted_units} unit(s) not yet costed</div>}</div>}
      </div>
      <Table head={['Product', 'Branch', 'Units', 'Avg cost / unit', 'Value at cost', 'At selling price']} empty={rows.length === 0 && 'No stock to value.'} min="min-w-[680px]">
        {rows.map((r) => (
          <tr key={`${r.product_id}-${r.store_id}`} className="border-b border-line last:border-0">
            <td className="px-4 py-3">{r.name}<div className="text-xs text-text-muted font-mono">{r.sku}</div></td>
            <td className="px-4 py-3">{r.store_name}</td>
            <td className="px-4 py-3 font-mono">{r.quantity}{r.uncosted_units > 0 && <span className="ml-1 text-xs text-text-muted font-sans">({r.uncosted_units} uncosted)</span>}</td>
            <td className="px-4 py-3 font-mono">{kes(r.unit_cost)}</td>
            <td className="px-4 py-3 font-mono">{kes(r.cost_value)}</td>
            <td className="px-4 py-3 font-mono text-text-muted">{kes(r.retail_value)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
