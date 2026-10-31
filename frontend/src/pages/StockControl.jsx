import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { stockApi, suppliersApi, storesApi, productsApi, categoriesApi, inventoryApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';
import { useAuth } from '../context/AuthContext';
import Pager, { usePager } from '../components/Pager';
import Sheet from '../components/Sheet';
import Picker, { Segmented } from '../components/Picker';

// Main-store inventory control: receiving shipments, issuing stock out, transfers between branches (with approval),
// outlet opening/closing counts, and a who-did-what log. Buying prices never appear here - the storekeeper does not
// see or enter them; the person who approves a new product adds it.

const inputCls = 'w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent';
const labelCls = 'block text-xs font-medium text-text-muted mb-1';
const btnPrimary = 'px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap disabled:opacity-50';
const btnGhost = 'px-3 py-2 rounded-lg border border-line text-sm font-medium hover:bg-paper whitespace-nowrap';
const cardCls = 'bg-surface border border-line rounded-xl';

const kes = (cents) => `KES ${(cents / 100).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
const toCents = (v) => Math.round(parseFloat(v) * 100);
const when = (ts) => (ts ? String(ts).replace('T', ' ').slice(0, 16) : '');

const STATUS_STYLE = {
  pending: 'bg-accent text-accent-ink', submitted: 'bg-accent text-accent-ink',
  approved: 'bg-success-soft text-success', rejected: 'bg-danger-soft text-danger', cancelled: 'bg-paper text-text-muted border border-line',
};
const STATUS_LABEL = { pending: 'Waiting', submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', cancelled: 'Withdrawn' };
function Badge({ status }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[status] || ''}`}>{STATUS_LABEL[status] || status}</span>;
}

const ISSUE_REASONS = [
  { value: 'damaged', label: 'Damaged' }, { value: 'expired', label: 'Expired' }, { value: 'lost', label: 'Lost' },
  { value: 'internal_use', label: 'Used in the shop' }, { value: 'returned_to_supplier', label: 'Returned to supplier' }, { value: 'other', label: 'Other' },
];
const ACTIVITY_LABEL = {
  receipt: 'Received a shipment', issue: 'Issued stock out', transfer_out: 'Stock left on a transfer', transfer_in: 'Stock arrived on a transfer',
  stocktake: 'Stock corrected to a count', adjustment: 'Adjusted stock', restock: 'Restocked', return: 'Customer return', void: 'Sale voided', requisition: 'Requisition',
  dispatch: 'Order dispatched', return_resellable: 'Return put back on the shelf',
  count_opening_submitted: 'Submitted the opening count', count_closing_submitted: 'Submitted the closing count',
  count_opening_approved: 'Approved an opening count', count_closing_approved: 'Approved a closing count',
  count_opening_rejected: 'Rejected an opening count', count_closing_rejected: 'Rejected a closing count',
  transfer_requested: 'Requested a transfer', transfer_approved: 'Approved a transfer', transfer_rejected: 'Rejected a transfer', transfer_cancelled: 'Withdrew a transfer',
};

// Type-to-find a product (name, SKU or barcode). Shows what was chosen, with a button to change it.
function ProductSearch({ value, onChange, placeholder = 'Search by name or SKU…' }) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const { data: results = [] } = useQuery({
    queryKey: ['stock-product-search', term],
    enabled: term.length >= 2,
    queryFn: () => productsApi.list({ q: term, pageSize: 8 }).then((r) => r.data.data),
    staleTime: 15000,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-line bg-paper text-sm">
        <span className="truncate">{value.name} <span className="text-text-muted font-mono text-xs">{value.sku}</span></span>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-text-muted hover:text-text">Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className={inputCls} />
      {term.length >= 2 && (
        <ul className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-auto bg-surface border border-line rounded-lg shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-text-muted">No active product matches.</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => { onChange({ id: p.id, name: p.name, sku: p.sku }); setQ(''); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-paper">
                {p.name} <span className="text-text-muted font-mono text-xs">{p.sku}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Table({ head, children, empty, loading, min = 'min-w-[640px]' }) {
  return (
    <div className={`${cardCls} overflow-hidden scroll-x`}>
      <table className={`stack-sm w-full text-sm ${min}`}>
        <thead><tr className="border-b border-line text-left text-text-muted">{head.map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {loading && <tr><td colSpan={head.length} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
          {!loading && empty && <tr><td colSpan={head.length} className="px-4 py-8 text-center text-text-muted">{empty}</td></tr>}
          {children}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------------------------------------------------
let lineSeq = 0;
const newLine = () => ({ key: ++lineSeq, mode: 'existing', product: null, qty: '', name: '', price: '', image: '', categoryId: '', subOn: false, parentId: '', subName: '' });

function ReceiveTab({ storeParams, isMainStore }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canManage = can('products.manage');
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([newLine()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pager = usePager(25);

  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => suppliersApi.list().then((r) => r.data.data) });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list().then((r) => r.data.data), enabled: open });
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'receipts', storeParams, pager.page, pager.pageSize],
    queryFn: () => stockApi.receipts({ ...pager.params, ...storeParams }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const catLabel = (c) => { const p = c.parent_id && categories.find((x) => x.id === c.parent_id); return p ? `${p.name} › ${c.name}` : c.name; };
  const topLevel = categories.filter((c) => !c.parent_id);
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function reset() { setSupplierId(''); setReference(''); setNote(''); setLines([newLine()]); setError(''); }

  async function save(e) {
    e.preventDefault();
    setError('');
    const items = [];
    for (const [i, l] of lines.entries()) {
      const where = `Line ${i + 1}`;
      const quantity = parseInt(l.qty, 10);
      if (!Number.isInteger(quantity) || quantity <= 0) return setError(`${where}: enter how many arrived.`);
      if (l.mode === 'existing') {
        if (!l.product) return setError(`${where}: choose the product.`);
        items.push({ product_id: l.product.id, quantity });
      } else {
        if (!l.name.trim()) return setError(`${where}: the new product needs a name.`);
        const price = toCents(l.price);
        if (!Number.isFinite(price) || price < 0) return setError(`${where}: enter the selling price.`);
        const np = { name: l.name.trim(), sell_price: price, image_url: l.image.trim() || undefined };
        if (l.subOn) {
          if (!l.subName.trim()) return setError(`${where}: name the new sub-category.`);
          if (!canManage && !l.parentId) return setError(`${where}: choose which category the sub-category goes in.`);
          np.new_category = { name: l.subName.trim(), parent_id: l.parentId ? Number(l.parentId) : undefined };
        } else if (l.categoryId) np.category_id = Number(l.categoryId);
        items.push({ quantity, new_product: np });
      }
    }
    setBusy(true);
    try {
      const res = await stockApi.receive({ supplier_id: supplierId ? Number(supplierId) : undefined, reference: reference.trim() || undefined, note: note.trim() || undefined, items });
      const pending = res.data.data.items.filter((i) => i.product_status === 'pending').length;
      toast.success(`Received ${res.data.data.total_units} unit(s).`);
      if (pending) toast.info(`${pending} new product(s) are waiting for a manager to add the buying price and approve them.`);
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      reset(); setOpen(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save the shipment.'));
    } finally { setBusy(false); }
  }

  const receipts = data?.data || [];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-text-muted max-w-xl">Record what arrived. Stock goes on the shelf at once. New products wait for a manager to add the buying price and approve them.</p>
        {isMainStore && <button onClick={() => { reset(); setOpen(true); }} className={btnPrimary}>+ Receive shipment</button>}
      </div>
      {!isMainStore && <p className="mb-4 px-3 py-2 rounded-lg bg-paper border border-line text-sm text-text-muted">Shipments are received at the main store. Outlets are supplied by a transfer.</p>}

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

      {open && (
        <Sheet onClose={() => setOpen(false)} size="lg" as="form" onSubmit={save}>
          <h2 className="font-display font-700 text-lg mb-4">Receive a shipment</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

          <label className={labelCls}>Supplier</label>
          <Picker value={supplierId} onChange={setSupplierId} title="Supplier" aria-label="Supplier" className="mb-3" allowClear clearLabel="No supplier"
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))} createLabel="+ New supplier…"
            onCreate={async (name) => {
              const res = await suppliersApi.create({ name });
              queryClient.invalidateQueries({ queryKey: ['suppliers'] });
              return { value: res.data.data.id, label: res.data.data.name };
            }} />
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div><label className={labelCls}>Delivery note / invoice no.</label><input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} /></div>
            <div><label className={labelCls}>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} /></div>
          </div>

          <div className="space-y-3 mb-3">
            {lines.map((l, i) => (
              <div key={l.key} className="border border-line rounded-xl p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <Segmented value={l.mode} onChange={(mode) => setLine(l.key, { mode })} aria-label={`Line ${i + 1} type`} className="flex-1 max-w-xs"
                    options={[{ value: 'existing', label: 'Existing product' }, { value: 'new', label: 'New product' }]} />
                  {lines.length > 1 && <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-xs text-danger hover:opacity-70">Remove</button>}
                </div>
                {l.mode === 'existing' ? (
                  <div className="grid grid-cols-[1fr_6rem] gap-3">
                    <div><label className={labelCls}>Product</label><ProductSearch value={l.product} onChange={(product) => setLine(l.key, { product })} /></div>
                    <div><label className={labelCls}>Quantity</label><input type="number" min="1" inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className={inputCls} /></div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem_6rem] gap-3">
                      <div><label className={labelCls}>Name</label><input value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value })} className={inputCls} /></div>
                      <div><label className={labelCls}>Selling price (KES)</label><input type="number" min="0" step="0.01" inputMode="decimal" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} className={inputCls} /></div>
                      <div><label className={labelCls}>Quantity</label><input type="number" min="1" inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className={inputCls} /></div>
                    </div>
                    <div><label className={labelCls}>Image link (optional)</label><input value={l.image} onChange={(e) => setLine(l.key, { image: e.target.value })} placeholder="https://…" className={inputCls} /></div>
                    {!l.subOn ? (
                      <div>
                        <label className={labelCls}>Category</label>
                        <Picker value={l.categoryId} onChange={(v) => setLine(l.key, { categoryId: v })} title="Category" aria-label="Category" allowClear clearLabel="No category"
                          options={categories.map((c) => ({ value: c.id, label: catLabel(c) }))} />
                        <button type="button" onClick={() => setLine(l.key, { subOn: true })} className="mt-1 text-xs text-text-muted hover:text-text">+ Add a new sub-category instead</button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>Put it inside{canManage ? ' (blank = new top-level category)' : ''}</label>
                          <Picker value={l.parentId} onChange={(v) => setLine(l.key, { parentId: v })} title="Parent category" aria-label="Parent category" allowClear={canManage} clearLabel="Top level"
                            options={topLevel.map((c) => ({ value: c.id, label: c.name }))} />
                        </div>
                        <div>
                          <label className={labelCls}>New sub-category name</label>
                          <input value={l.subName} onChange={(e) => setLine(l.key, { subName: e.target.value })} className={inputCls} />
                          <button type="button" onClick={() => setLine(l.key, { subOn: false, subName: '', parentId: '' })} className="mt-1 text-xs text-text-muted hover:text-text">Use an existing category instead</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setLines((ls) => [...ls, newLine()])} className="text-sm text-text-muted hover:text-text mb-5">+ Add another line</button>

          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{busy ? 'Saving…' : 'Save shipment'}</button>
          </div>
        </Sheet>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------------------------------
function IssueTab({ storeParams, isOwnStore }) {
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

// ---------------------------------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------------------------------
function TransfersTab({ stores }) {
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const { user, can } = useAuth();
  const canReview = can('stock.review');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const [toStore, setToStore] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([{ key: 1, product: null, qty: '' }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'transfers', status, pager.page, pager.pageSize],
    queryFn: () => stockApi.transfers({ ...pager.params, status: status || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const others = stores.filter((s) => !s.is_current && s.is_active);
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['stock'] }); queryClient.invalidateQueries({ queryKey: ['inventory'] }); };

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!toStore) return setError('Choose where the stock is going.');
    const items = [];
    for (const [i, l] of lines.entries()) {
      const quantity = parseInt(l.qty, 10);
      if (!l.product || !Number.isInteger(quantity) || quantity <= 0) return setError(`Line ${i + 1}: choose a product and a quantity.`);
      items.push({ product_id: l.product.id, quantity });
    }
    setBusy(true);
    try {
      await stockApi.requestTransfer({ to_store_id: Number(toStore), note: note.trim() || undefined, items });
      toast.info('Requested. The stock moves once someone else approves it.');
      setOpen(false); setToStore(''); setNote(''); setLines([{ key: 1, product: null, qty: '' }]); refresh();
    } catch (err) { setError(getErrorMessage(err, 'Could not request the transfer.')); } finally { setBusy(false); }
  }

  async function decide(t, approve) {
    try {
      if (approve) {
        if (!(await dialog.confirm({ message: `Move ${t.total_units} unit(s) from ${t.from_store_name} to ${t.to_store_name}? The stock moves now.`, confirmLabel: 'Approve' }))) return;
        await stockApi.approveTransfer(t.id);
      } else {
        const reason = await dialog.prompt({ message: 'Why is this transfer being rejected?', required: true, confirmLabel: 'Reject' });
        if (!reason) return;
        await stockApi.rejectTransfer(t.id, reason);
      }
      refresh();
    } catch (err) { toast.error(getErrorMessage(err, 'Could not update the transfer.')); }
  }

  async function cancel(t) {
    if (!(await dialog.confirm({ message: 'Withdraw this transfer request?', danger: true, confirmLabel: 'Withdraw' }))) return;
    try { await stockApi.cancelTransfer(t.id); refresh(); } catch (err) { toast.error(getErrorMessage(err, 'Could not withdraw it.')); }
  }

  const rows = data?.data || [];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-text-muted max-w-xl">Ask to move stock to another branch. Nothing moves until a manager approves it; then it leaves one branch and arrives at the other together.</p>
        <button onClick={() => setOpen(true)} className={btnPrimary} disabled={others.length === 0}>+ New transfer</button>
      </div>
      <Segmented value={status} onChange={(v) => { setStatus(v); pager.reset(); }} aria-label="Filter transfers" className="mb-4 max-w-md"
        options={[{ value: '', label: 'All' }, { value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />

      <Table head={['#', 'From → To', 'Items', 'Status', '']} loading={isLoading} empty={rows.length === 0 && 'No transfers yet.'}>
        {rows.map((t) => (
          <tr key={t.id} className="border-b border-line last:border-0 align-top">
            <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{t.id}<div className="text-text-muted">{when(t.created_at)}</div></td>
            <td className="px-4 py-3">{t.from_store_name} → {t.to_store_name}<div className="text-xs text-text-muted">asked by {t.requested_by_name}{t.note ? ` — ${t.note}` : ''}</div></td>
            <td className="px-4 py-3 text-text-muted">{t.items.map((i) => <div key={i.id}>{i.quantity} × {i.product_name}</div>)}</td>
            <td className="px-4 py-3">
              <Badge status={t.status} />
              {t.reviewed_by_name && t.status !== 'pending' && <div className="text-xs text-text-muted mt-1">{t.status === 'cancelled' ? 'withdrawn' : t.status} by {t.reviewed_by_name}</div>}
              {t.status === 'rejected' && t.review_note && <div className="text-xs text-danger mt-0.5">{t.review_note}</div>}
            </td>
            <td className="px-4 py-3 text-right whitespace-nowrap">
              {t.status === 'pending' && canReview && (t.requested_by_staff_id !== user.id || user.role === 'admin') && (
                <>
                  <button onClick={() => decide(t, true)} className="text-xs font-medium text-success hover:opacity-70 mr-3">Approve</button>
                  <button onClick={() => decide(t, false)} className="text-xs text-danger hover:opacity-70 mr-3">Reject</button>
                </>
              )}
              {t.status === 'pending' && (t.requested_by_staff_id === user.id || user.role === 'admin') && <button onClick={() => cancel(t)} className="text-xs text-text-muted hover:text-text">Withdraw</button>}
            </td>
          </tr>
        ))}
      </Table>
      <Pager pager={pager} data={data} noun="transfers" />

      {open && (
        <Sheet onClose={() => setOpen(false)} size="md" as="form" onSubmit={save}>
          <h2 className="font-display font-700 text-lg mb-4">New transfer</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <label className={labelCls}>Send to</label>
          <Picker value={toStore} onChange={setToStore} title="Send to" aria-label="Send to" className="mb-3" options={others.map((s) => ({ value: s.id, label: s.name }))} />
          <div className="space-y-3 mb-3">
            {lines.map((l) => (
              <div key={l.key} className="grid grid-cols-[1fr_5rem_auto] gap-2 items-end">
                <div><label className={labelCls}>Product</label><ProductSearch value={l.product} onChange={(product) => setLine(l.key, { product })} /></div>
                <div><label className={labelCls}>Qty</label><input type="number" min="1" inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className={inputCls} /></div>
                {lines.length > 1 ? <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="pb-2 text-xs text-danger">Remove</button> : <span />}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setLines((ls) => [...ls, { key: Date.now(), product: null, qty: '' }])} className="text-sm text-text-muted hover:text-text mb-3">+ Add another product</button>
          <label className={labelCls}>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} mb-5`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{busy ? 'Sending…' : 'Request transfer'}</button>
          </div>
        </Sheet>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------------------------------------------------
function CountsTab({ storeParams, isOwnStore }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user, can } = useAuth();
  const canReview = can('stock.review');
  const [counting, setCounting] = useState(null);      // 'opening' | 'closing' | null
  const [counts, setCounts] = useState({});            // product_id -> typed value
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(null);    // count id
  const [adjust, setAdjust] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const pager = usePager(25);

  const { data: summary } = useQuery({ queryKey: ['stock', 'day-summary', storeParams], queryFn: () => stockApi.daySummary(storeParams).then((r) => r.data.data) });
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'counts', storeParams, pager.page, pager.pageSize],
    queryFn: () => stockApi.counts({ ...pager.params, ...storeParams }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const { data: inventory = [] } = useQuery({ queryKey: ['inventory', 'list'], queryFn: () => inventoryApi.list().then((r) => r.data.data), enabled: !!counting });
  const { data: detail } = useQuery({ queryKey: ['stock', 'count', reviewing], queryFn: () => stockApi.count(reviewing).then((r) => r.data.data), enabled: !!reviewing });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['stock'] }); queryClient.invalidateQueries({ queryKey: ['inventory'] }); };

  async function submit(e) {
    e.preventDefault();
    setError('');
    const items = Object.entries(counts).filter(([, v]) => v !== '' && v !== undefined).map(([id, v]) => ({ product_id: Number(id), counted_qty: parseInt(v, 10) }));
    if (items.length === 0) return setError('Enter the count for at least one product.');
    if (items.some((i) => !Number.isInteger(i.counted_qty) || i.counted_qty < 0)) return setError('Counts must be whole numbers, zero or more.');
    setBusy(true);
    try {
      const res = await stockApi.submitCount({ kind: counting, note: note.trim() || undefined, items });
      const c = res.data.data;
      toast.info(c.lines_with_variance ? `Submitted. ${c.units_short} short, ${c.units_over} over — a manager will review it.` : 'Submitted. Everything matched.');
      setCounting(null); setCounts({}); setNote(''); setFilter(''); refresh();
    } catch (err) { setError(getErrorMessage(err, 'Could not submit the count.')); } finally { setBusy(false); }
  }

  async function review(approve) {
    try {
      if (approve) await stockApi.approveCount(reviewing, { apply_adjustments: adjust, note: reviewNote.trim() || undefined });
      else {
        if (!reviewNote.trim()) return toast.error('Say why you are rejecting it.');
        await stockApi.rejectCount(reviewing, reviewNote.trim());
      }
      setReviewing(null); setAdjust(false); setReviewNote(''); refresh();
    } catch (err) { toast.error(getErrorMessage(err, 'Could not save the review.')); }
  }

  const rows = data?.data || [];
  const shown = inventory.filter((i) => !filter.trim() || `${i.product_name} ${i.sku}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const canDecide = detail && detail.status === 'submitted' && canReview && (detail.submitted_by_staff_id !== user.id || user.role === 'admin');

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-text-muted max-w-xl">Count the shelf at the start and end of the day. Differences are recorded and reviewed by a manager; counting alone never changes the stock figures.</p>
        {isOwnStore && (
          <div className="flex gap-2">
            <button onClick={() => { setError(''); setCounting('opening'); }} className={btnGhost}>Opening count</button>
            <button onClick={() => { setError(''); setCounting('closing'); }} className={btnPrimary}>Closing count</button>
          </div>
        )}
      </div>

      {summary && (
        <div className={`${cardCls} p-4 mb-6`}>
          <h2 className="font-display font-700 text-sm">Today</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Opening count: {summary.opening ? `${summary.opening.status === 'submitted' ? 'waiting for review' : summary.opening.status} (${summary.opening.submitted_by_name})` : 'not done yet'} · Closing count: {summary.closing ? `${summary.closing.status === 'submitted' ? 'waiting for review' : summary.closing.status} (${summary.closing.submitted_by_name})` : 'not done yet'}
          </p>
          {summary.opening && summary.closing && (
            <>
              <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
                <div><div className="text-xs text-text-muted">Missing</div><div className={`font-mono font-medium ${summary.totals.units_missing ? 'text-danger' : ''}`}>{summary.totals.units_missing}</div></div>
                <div><div className="text-xs text-text-muted">Surplus</div><div className="font-mono font-medium">{summary.totals.units_surplus}</div></div>
                <div><div className="text-xs text-text-muted">Products off</div><div className="font-mono font-medium">{summary.totals.products_with_difference}</div></div>
              </div>
              {summary.lines.some((l) => l.unexplained !== 0) && (
                <ul className="mt-3 border-t border-line pt-3 space-y-1 text-sm">
                  {summary.lines.filter((l) => l.unexplained !== 0).map((l) => (
                    <li key={l.product_id} className="flex justify-between gap-3">
                      <span>{l.product_name}</span>
                      <span className="text-text-muted">opened {l.opening_counted}, expected {l.expected_closing}, counted {l.closing_counted} · <span className={l.unexplained < 0 ? 'text-danger' : ''}>{l.unexplained > 0 ? '+' : ''}{l.unexplained}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <Table head={['Date', 'Count', 'By', 'Result', 'Status', '']} loading={isLoading} empty={rows.length === 0 && 'No counts yet.'}>
        {rows.map((c) => (
          <tr key={c.id} className="border-b border-line last:border-0">
            <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{c.count_date}</td>
            <td className="px-4 py-3 capitalize">{c.kind}</td>
            <td className="px-4 py-3 whitespace-nowrap">{c.submitted_by_name}</td>
            <td className="px-4 py-3 text-text-muted">{c.lines_with_variance ? <span className="text-danger">{c.units_short} short · {c.units_over} over</span> : 'Matched'} <span className="text-xs">({c.products_counted} products{c.products_not_counted ? `, ${c.products_not_counted} not counted` : ''})</span></td>
            <td className="px-4 py-3"><Badge status={c.status} />{c.adjustments_applied ? <span className="ml-1 text-xs text-text-muted">stock corrected</span> : null}</td>
            <td className="px-4 py-3 text-right"><button onClick={() => { setReviewing(c.id); setAdjust(false); setReviewNote(''); }} className="text-xs text-text-muted hover:text-text">{c.status === 'submitted' && canReview ? 'Review' : 'View'}</button></td>
          </tr>
        ))}
      </Table>
      <Pager pager={pager} data={data} noun="counts" />

      {counting && (
        <Sheet onClose={() => setCounting(null)} size="lg" as="form" onSubmit={submit}>
          <h2 className="font-display font-700 text-lg mb-1 capitalize">{counting} count</h2>
          <p className="text-xs text-text-muted mb-3">Type what you can see on the shelf. Leave a product blank to skip it. Do not look at the system figure first — count, then type.</p>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a product…" className={`${inputCls} mb-3`} />
          <div className="max-h-[45vh] overflow-auto border border-line rounded-lg mb-3">
            {shown.length === 0 && <div className="px-3 py-6 text-center text-sm text-text-muted">No products here.</div>}
            {shown.map((i) => (
              <div key={i.product_id} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-line last:border-0">
                <div className="min-w-0"><div className="text-sm truncate">{i.product_name}</div><div className="text-xs text-text-muted font-mono">{i.sku}</div></div>
                <input type="number" min="0" inputMode="numeric" value={counts[i.product_id] ?? ''} onChange={(e) => setCounts({ ...counts, [i.product_id]: e.target.value })} aria-label={`Counted ${i.product_name}`} className="w-24 px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-right" />
              </div>
            ))}
          </div>
          <label className={labelCls}>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} mb-4`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setCounting(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{busy ? 'Submitting…' : 'Submit count'}</button>
          </div>
        </Sheet>
      )}

      {reviewing && (
        <Sheet onClose={() => setReviewing(null)} size="lg">
          {!detail ? <div className="text-sm text-text-muted">Loading…</div> : (
            <>
              <h2 className="font-display font-700 text-lg mb-1 capitalize">{detail.kind} count · {detail.count_date}</h2>
              <p className="text-xs text-text-muted mb-3">{detail.store_name} · submitted by {detail.submitted_by_name} <Badge status={detail.status} />{detail.review_note ? ` — ${detail.review_note}` : ''}</p>
              <div className="max-h-[40vh] overflow-auto border border-line rounded-lg mb-3">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-line text-left text-text-muted"><th className="px-3 py-2 font-medium">Product</th><th className="px-3 py-2 font-medium text-right">System</th><th className="px-3 py-2 font-medium text-right">Counted</th><th className="px-3 py-2 font-medium text-right">Diff</th></tr></thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={l.product_id} className="border-b border-line last:border-0">
                        <td className="px-3 py-2">{l.product_name}</td>
                        <td className="px-3 py-2 text-right font-mono">{l.expected_qty}</td>
                        <td className="px-3 py-2 text-right font-mono">{l.counted_qty}</td>
                        <td className={`px-3 py-2 text-right font-mono ${l.variance < 0 ? 'text-danger' : ''}`}>{l.variance > 0 ? '+' : ''}{l.variance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.products_not_counted > 0 && <p className="text-xs text-text-muted mb-3">{detail.products_not_counted} product(s) with stock were not part of this count.</p>}
              {canDecide ? (
                <>
                  <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} /> Also correct the system stock to the counted figures</label>
                  <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Note (needed to reject)" className={`${inputCls} mb-3`} />
                  <div className="flex gap-2">
                    <button onClick={() => review(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium text-danger">Reject</button>
                    <button onClick={() => review(true)} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Approve</button>
                  </div>
                </>
              ) : <button onClick={() => setReviewing(null)} className="w-full py-2.5 rounded-lg border border-line text-sm font-medium">Close</button>}
            </>
          )}
        </Sheet>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------------------------------
function ActivityTab({ storeParams }) {
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

// ---------------------------------------------------------------------------------------------------------------------
export default function StockControl() {
  const { can } = useAuth();
  const [viewStore, setViewStore] = useState('');
  const { data: stores = [] } = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list().then((r) => r.data.data) });

  const tabs = [
    can('stock.receive') && { id: 'receive', label: 'Receive' },
    can('stock.receive') && { id: 'issue', label: 'Issue out' },
    can('stock.transfer') && { id: 'transfers', label: 'Transfers' },
    can('stock.count') && { id: 'counts', label: 'Counts' },
    can('stock.review') && { id: 'activity', label: 'Who did what' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.id);

  const current = stores.find((s) => s.is_current);
  const viewing = viewStore ? stores.find((s) => String(s.id) === String(viewStore)) : current;
  const isOwnStore = !viewStore || String(viewStore) === String(current?.id);
  const storeParams = isOwnStore ? {} : { store_id: viewStore };
  const canPickStore = can('stock.review') && stores.length > 1;

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="font-display font-700 text-2xl">Stock control</h1>
          <p className="text-text-muted text-sm mt-1">{viewing ? `${viewing.name}${viewing.is_main ? ' (main store)' : ''}` : 'Receiving, transfers and counts.'}</p>
        </div>
        {canPickStore && (
          <div className="sm:w-60">
            <Picker value={viewStore || (current ? String(current.id) : '')} onChange={(v) => setViewStore(String(v) === String(current?.id) ? '' : String(v))} title="Branch" aria-label="Branch"
              options={stores.map((s) => ({ value: String(s.id), label: s.name + (s.is_main ? ' (main)' : '') }))} />
          </div>
        )}
      </div>

      <div className="flex gap-1 mb-6 overflow-x-auto border-b border-line" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${tab === t.id ? 'border-ink text-text' : 'border-transparent text-text-muted hover:text-text'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'receive' && <ReceiveTab storeParams={storeParams} isMainStore={Boolean(viewing?.is_main) && isOwnStore} />}
      {tab === 'issue' && <IssueTab storeParams={storeParams} isOwnStore={isOwnStore} />}
      {tab === 'transfers' && <TransfersTab stores={stores} />}
      {tab === 'counts' && <CountsTab storeParams={storeParams} isOwnStore={isOwnStore} />}
      {tab === 'activity' && <ActivityTab storeParams={storeParams} />}
    </div>
  );
}
