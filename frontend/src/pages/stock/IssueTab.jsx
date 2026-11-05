import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { stockApi } from '../../api/endpoints';
import Pager, { usePager } from '../../components/Pager';
import Picker from '../../components/Picker';
import { useToast } from '../../context/UIContext';
import { ProductSearch, Table } from './shared';
import { ISSUE_REASONS, btnPrimary, cardCls, inputCls, labelCls } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------------------------------
export default function IssueTab({ storeParams, isOwnStore }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ product: null, qty: '', reason: 'damaged', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'issues', storeParams, pager.page, pager.pageSize],
    queryFn: () => stockApi.issues({ ...pager.params, ...storeParams }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  async function save(e) {
    e.preventDefault();
    setError('');
    const quantity = parseInt(form.qty, 10);
    if (!form.product) return setError('Choose the product.');
    if (!Number.isInteger(quantity) || quantity <= 0) return setError('Enter how many are leaving.');
    if (form.reason === 'other' && !form.note.trim()) return setError('Say what the stock was issued for.');
    setBusy(true);
    try {
      await stockApi.issue({ product_id: form.product.id, quantity, reason: form.reason, note: form.note.trim() || undefined });
      toast.success('Stock issued.');
      setForm({ product: null, qty: '', reason: 'damaged', note: '' });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    } catch (err) { setError(getErrorMessage(err, 'Could not issue the stock.')); } finally { setBusy(false); }
  }

  const rows = data?.data || [];
  return (
    <>
      {isOwnStore && (
        <form onSubmit={save} className={`${cardCls} p-4 mb-6`}>
          <h2 className="font-display font-700 text-sm mb-3">Issue stock out</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_6rem_12rem] gap-3 mb-3">
            <div><label className={labelCls}>Product</label><ProductSearch value={form.product} onChange={(product) => setForm({ ...form, product })} /></div>
            <div><label className={labelCls}>Quantity</label><input type="number" min="1" inputMode="numeric" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>Why</label><Picker value={form.reason} onChange={(reason) => setForm({ ...form, reason })} title="Reason" aria-label="Reason" options={ISSUE_REASONS} /></div>
          </div>
          <label className={labelCls}>Note{form.reason === 'other' ? '' : ' (optional)'}</label>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={`${inputCls} mb-3`} />
          <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Saving…' : 'Issue stock'}</button>
        </form>
      )}
      <Table head={['Date', 'Product', 'Qty', 'Why', 'Issued by']} loading={isLoading} empty={rows.length === 0 && 'Nothing has been issued.'}>
        {rows.map((i) => (
          <tr key={i.id} className="border-b border-line last:border-0">
            <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">{i.issued_on}</td>
            <td className="px-4 py-3">{i.product_name}<div className="text-xs text-text-muted font-mono">{i.sku}</div></td>
            <td className="px-4 py-3 font-mono">{i.quantity}</td>
            <td className="px-4 py-3">{ISSUE_REASONS.find((r) => r.value === i.reason)?.label}{i.note && <div className="text-xs text-text-muted">{i.note}</div>}</td>
            <td className="px-4 py-3 whitespace-nowrap">{i.issued_by_name}</td>
          </tr>
        ))}
      </Table>
      <Pager pager={pager} data={data} noun="issues" />
    </>
  );
}
