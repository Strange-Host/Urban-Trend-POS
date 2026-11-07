import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { stockApi, suppliersApi, categoriesApi } from '../../api/endpoints';
import { usePager } from '../../components/Pager';
import Picker, { Segmented } from '../../components/Picker';
import Sheet from '../../components/Sheet';
import { useAuth } from '../../context/AuthContext';
import { useDialog, useToast } from '../../context/UIContext';
import useUiVersion from '../../hooks/useUiVersion';
import { ProductSearch } from './shared';
import ReceiveActivity from './ReceiveActivity';
import ReceiveForm from './ReceiveForm';
import ReceiveHistory from './ReceiveHistory';
import { btnPrimary, inputCls, labelCls, toCents } from './helpers';
import { draftBodyFromForm, linesFromDraft } from './receiptDraft';

// ---------------------------------------------------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------------------------------------------------
let lineSeq = 0;
const newLine = () => ({ key: ++lineSeq, mode: 'existing', product: null, qty: '', batchNo: '', expiry: '', cost: '', name: '', price: '', image: '', categoryId: '', subOn: false, parentId: '', subName: '' });

export default function ReceiveTab({ storeParams, isMainStore }) {
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  // Drafts arrive with the new layout (ut_ui=v2); with it off this form is exactly as it was.
  const { isV2 } = useUiVersion();
  const canManage = can('products.manage');
  const canCost = canManage && can('products.view_cost'); // only people who may see buying prices are offered the field
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([newLine()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftId, setDraftId] = useState(null); // the draft this form was opened from, if any
  const pager = usePager(25);

  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => suppliersApi.list().then((r) => r.data.data) });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list().then((r) => r.data.data), enabled: open || isV2 });
  const { data: drafts = [] } = useQuery({
    queryKey: ['stock', 'receipt-drafts'], // under 'stock', so a finished receive refreshes it with everything else
    queryFn: () => stockApi.receiptDrafts().then((r) => r.data.data),
    enabled: isV2 && isMainStore,
  });
  const { data, isLoading } = useQuery({
    queryKey: ['stock', 'receipts', storeParams, pager.page, pager.pageSize],
    queryFn: () => stockApi.receipts({ ...pager.params, ...storeParams }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const catLabel = (c) => { const p = c.parent_id && categories.find((x) => x.id === c.parent_id); return p ? `${p.name} › ${c.name}` : c.name; };
  const topLevel = categories.filter((c) => !c.parent_id);
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function reset() { setSupplierId(''); setReference(''); setNote(''); setLines([newLine()]); setError(''); setDraftId(null); }

  // Checks every line the way the server will and builds the receipt's items, or says what is wrong with the first bad line.
  function buildItems() {
    const items = [];
    for (const [i, l] of lines.entries()) {
      const where = `Line ${i + 1}`;
      const quantity = parseInt(l.qty, 10);
      if (!Number.isInteger(quantity) || quantity <= 0) return { error: `${where}: enter how many arrived.` };
      const batch = { batch_no: l.batchNo.trim() || undefined, expiry_date: l.expiry || undefined };
      if (canCost && l.cost !== '') {
        const c = toCents(l.cost);
        if (!Number.isFinite(c) || c < 0) return { error: `${where}: the buying price must be zero or more.` };
        batch.unit_cost = c;
      }
      if (l.mode === 'existing') {
        if (!l.product) return { error: `${where}: choose the product.` };
        items.push({ product_id: l.product.id, quantity, ...batch });
      } else {
        if (!l.name.trim()) return { error: `${where}: the new product needs a name.` };
        const price = toCents(l.price);
        if (!Number.isFinite(price) || price < 0) return { error: `${where}: enter the selling price.` };
        const np = { name: l.name.trim(), sell_price: price, image_url: l.image.trim() || undefined };
        if (l.subOn) {
          if (!l.subName.trim()) return { error: `${where}: name the new sub-category.` };
          if (!canManage && !l.parentId) return { error: `${where}: choose which category the sub-category goes in.` };
          np.new_category = { name: l.subName.trim(), parent_id: l.parentId ? Number(l.parentId) : undefined };
        } else if (l.categoryId) np.category_id = Number(l.categoryId);
        items.push({ quantity, new_product: np, ...batch });
      }
    }
    return { items };
  }

  // Saves the form as a draft: nothing is checked and no stock moves; it is only kept for later.
  async function saveDraft() {
    setError('');
    setBusy(true);
    try {
      const body = draftBodyFromForm({ supplierId, reference, note, lines, canCost });
      if (draftId) await stockApi.updateReceiptDraft(draftId, body);
      else await stockApi.saveReceiptDraft(body);
      toast.success('Draft saved. Nothing has been received yet.');
      queryClient.invalidateQueries({ queryKey: ['stock', 'receipt-drafts'] });
      reset(); setOpen(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save the draft.'));
    } finally { setBusy(false); }
  }

  async function openDraft(id) {
    setBusy(true);
    try {
      const b = (await stockApi.receiptDraft(id)).data.data.body;
      setSupplierId(b.supplier_id ?? ''); setReference(b.reference || ''); setNote(b.note || '');
      setLines(linesFromDraft(b, newLine)); setError(''); setDraftId(id); setOpen(true);
      setTimeout(() => document.getElementById('receive-form-title')?.scrollIntoView?.({ block: 'start' }), 0);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not open that draft.'));
    } finally { setBusy(false); }
  }

  async function deleteDraft(id) {
    if (!(await dialog.confirm({ message: 'Delete this draft? Nothing has been received, so no stock changes.', confirmLabel: 'Delete draft' }))) return;
    try {
      await stockApi.deleteReceiptDraft(id);
      queryClient.invalidateQueries({ queryKey: ['stock', 'receipt-drafts'] });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not delete that draft.'));
    }
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    const built = buildItems();
    if (built.error) return setError(built.error);
    const { items } = built;
    setBusy(true);
    try {
      const payload = { supplier_id: supplierId ? Number(supplierId) : undefined, reference: reference.trim() || undefined, note: note.trim() || undefined, items };
      // A draft is received by sending the final form into it and submitting it: the draft is removed in the same step the stock goes in.
      if (draftId) await stockApi.updateReceiptDraft(draftId, payload);
      const res = draftId ? await stockApi.submitReceiptDraft(draftId) : await stockApi.receive(payload);
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
  const notMainStore = <p className="mb-4 px-3 py-2 rounded-lg bg-paper border border-line text-sm text-text-muted">Shipments are received at the main store. Outlets are supplied by a transfer.</p>;

  // The new layout: the delivery form sits on the page beside the drafts and recent activity (no sheet), history below.
  if (isV2) {
    return (
      <>
        {isMainStore ? (
          <div className="mb-8 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(280px,1fr)]">
            <ReceiveForm
              error={error} draftId={draftId} suppliers={suppliers} supplierId={supplierId} setSupplierId={setSupplierId}
              reference={reference} setReference={setReference} note={note} setNote={setNote}
              lines={lines} setLine={setLine} onAddLine={() => setLines((ls) => [...ls, newLine()])}
              onRemoveLine={(key) => setLines((ls) => ls.filter((x) => x.key !== key))}
              canCost={canCost} canManage={canManage} categories={categories} topLevel={topLevel} catLabel={catLabel}
              busy={busy} onSaveDraft={saveDraft} onSubmit={save} onClear={reset}
            />
            <ReceiveActivity drafts={drafts} onOpenDraft={openDraft} onDeleteDraft={deleteDraft} busy={busy} receipts={receipts} />
          </div>
        ) : notMainStore}
        <h2 className="mb-3 font-display text-base font-700">Past shipments</h2>
        <ReceiveHistory receipts={receipts} isLoading={isLoading} pager={pager} data={data} />
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-text-muted max-w-xl">Record what arrived. Stock goes on the shelf at once. New products wait for a manager to add the buying price and approve them.</p>
        {isMainStore && <button onClick={() => { reset(); setOpen(true); }} className={btnPrimary}>+ Receive shipment</button>}
      </div>
      {!isMainStore && notMainStore}

      <ReceiveHistory receipts={receipts} isLoading={isLoading} pager={pager} data={data} />

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
                <div className={`grid grid-cols-1 ${canCost ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-3 mt-3 pt-3 border-t border-line`}>
                  <div><label className={labelCls}>Batch / lot no. (optional)</label><input value={l.batchNo} onChange={(e) => setLine(l.key, { batchNo: e.target.value })} className={inputCls} /></div>
                  <div><label className={labelCls}>Expiry date (if it expires)</label><input type="date" value={l.expiry} onChange={(e) => setLine(l.key, { expiry: e.target.value })} className={inputCls} /></div>
                  {canCost && <div><label className={labelCls}>Buying price per unit (KES)</label><input type="number" min="0" step="0.01" inputMode="decimal" value={l.cost} onChange={(e) => setLine(l.key, { cost: e.target.value })} className={inputCls} /></div>}
                </div>
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
