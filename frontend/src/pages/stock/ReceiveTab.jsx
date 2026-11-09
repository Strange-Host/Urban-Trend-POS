import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { stockApi, suppliersApi, categoriesApi } from '../../api/endpoints';
import { usePager } from '../../components/Pager';
import { useAuth } from '../../context/AuthContext';
import { useDialog, useToast } from '../../context/UIContext';
import ReceiveActivity from './ReceiveActivity';
import ReceiveForm from './ReceiveForm';
import ReceiveHistory from './ReceiveHistory';
import { toCents } from './helpers';
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
  const canManage = can('products.manage');
  const canCost = canManage && can('products.view_cost'); // only people who may see buying prices are offered the field
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([newLine()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftId, setDraftId] = useState(null); // the draft this form was opened from, if any
  const pager = usePager(25);

  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: () => suppliersApi.list().then((r) => r.data.data) });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list().then((r) => r.data.data),  });
  const { data: drafts = [] } = useQuery({
    queryKey: ['stock', 'receipt-drafts'], // under 'stock', so a finished receive refreshes it with everything else
    queryFn: () => stockApi.receiptDrafts().then((r) => r.data.data),
    enabled: isMainStore,
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
      reset();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save the draft.'));
    } finally { setBusy(false); }
  }

  async function openDraft(id) {
    setBusy(true);
    try {
      const b = (await stockApi.receiptDraft(id)).data.data.body;
      setSupplierId(b.supplier_id ?? ''); setReference(b.reference || ''); setNote(b.note || '');
      setLines(linesFromDraft(b, newLine)); setError(''); setDraftId(id);
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
      reset();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save the shipment.'));
    } finally { setBusy(false); }
  }

  const receipts = data?.data || [];
  const notMainStore = <p className="mb-4 px-3 py-2 rounded-lg bg-paper border border-line text-sm text-text-muted">Shipments are received at the main store. Outlets are supplied by a transfer.</p>;

  // The delivery form sits on the page beside the drafts and recent activity (no sheet), history below.
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
