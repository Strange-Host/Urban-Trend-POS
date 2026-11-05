import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { stockApi } from '../../api/endpoints';
import { Table } from './shared';
import { ACTIVITY_LABEL, inputCls, labelCls, when } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------------------------------
export default function ActivityTab({ storeParams }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sales, setSales] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'activity', storeParams, from, to, sales],
    queryFn: () => stockApi.activity({ ...storeParams, from: from || undefined, to: to || undefined, include_sales: sales ? 1 : undefined }).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  const entries = data?.entries || [];
  return (
    <>
      <p className="text-sm text-text-muted mb-4 max-w-xl">Who did what with stock at this branch. Defaults to the last 7 days.</p>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div><label className={labelCls}>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} /></div>
        <div><label className={labelCls}>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} /></div>
        <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" checked={sales} onChange={(e) => setSales(e.target.checked)} /> Include sales</label>
      </div>
      {data?.summary?.length > 0 && (
        <div className="mb-6">
          <Table head={['Person', 'Actions', 'Units in', 'Units out']} min="min-w-[420px]">
            {data.summary.map((s) => (
              <tr key={s.staff_id ?? 'system'} className="border-b border-line last:border-0">
                <td className="px-4 py-3">{s.staff_name}</td><td className="px-4 py-3 font-mono">{s.actions}</td>
                <td className="px-4 py-3 font-mono">{s.units_in}</td><td className="px-4 py-3 font-mono">{s.units_out}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <Table head={['When', 'Who', 'What', 'Product', 'Qty']} loading={isLoading} empty={entries.length === 0 && 'Nothing recorded in this period.'}>
        {entries.map((e, i) => (
          <tr key={`${e.at}-${i}`} className="border-b border-line last:border-0">
            <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{when(e.at)}</td>
            <td className="px-4 py-3 whitespace-nowrap">{e.staff_name}</td>
            <td className="px-4 py-3">{ACTIVITY_LABEL[e.kind] || e.kind}{e.detail ? <span className="text-text-muted"> · {e.detail}</span> : null}</td>
            <td className="px-4 py-3 text-text-muted">{e.product_name || ''}</td>
            <td className={`px-4 py-3 font-mono ${e.change_qty < 0 ? 'text-danger' : ''}`}>{e.change_qty ? (e.change_qty > 0 ? `+${e.change_qty}` : e.change_qty) : ''}</td>
          </tr>
        ))}
      </Table>
      {data?.truncated && <p className="mt-2 text-xs text-text-muted">Showing the newest {entries.length}. Narrow the dates to see the rest.</p>}
    </>
  );
}
