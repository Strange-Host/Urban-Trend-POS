import { useQueryClient } from '@tanstack/react-query';
import { suppliersApi } from '../../api/endpoints';
import Picker from '../../components/Picker';
import ReceiveLineRow, { LINE_GRID } from './ReceiveLineRow';
import { inputCls, labelCls } from './helpers';

// The new layout's "New delivery" panel: supplier and delivery note, then the lines as a table, then Save draft and Save
// shipment. It holds no data of its own: Stock > Receive owns the form state and what the buttons do, so this and the old
// sheet go through the same checks and the same calls.
export default function ReceiveForm({
  error, draftId, suppliers, supplierId, setSupplierId, reference, setReference, note, setNote,
  lines, setLine, onAddLine, onRemoveLine, canCost, canManage, categories, topLevel, catLabel,
  busy, onSaveDraft, onSubmit, onClear,
}) {
  const queryClient = useQueryClient();
  return (
    <form onSubmit={onSubmit} className="rounded-xl border border-line bg-surface p-5" aria-labelledby="receive-form-title">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 id="receive-form-title" className="font-display text-base font-700">{draftId ? 'Finish a draft delivery' : 'New delivery'}</h2>
        {draftId && <button type="button" onClick={onClear} className="min-h-11 px-2 text-xs text-text-muted hover:text-text">Start a new delivery instead</button>}
      </div>
      {error && <div role="alert" className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Supplier</label>
          <Picker value={supplierId} onChange={setSupplierId} title="Supplier" aria-label="Supplier" allowClear clearLabel="No supplier"
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))} createLabel="+ New supplier…"
            onCreate={async (name) => {
              const res = await suppliersApi.create({ name });
              queryClient.invalidateQueries({ queryKey: ['suppliers'] });
              return { value: res.data.data.id, label: res.data.data.name };
            }} />
        </div>
        <div>
          <label className={labelCls} htmlFor="receive-reference">Delivery note number</label>
          <input id="receive-reference" value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="receive-note">Note (optional)</label>
          <input id="receive-note" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
        </div>
      </div>

      <div className={`hidden gap-3 pb-2 text-xs font-semibold text-text-muted md:grid ${LINE_GRID}`} aria-hidden="true">
        <span>Item</span><span>Quantity</span><span>Selling price</span><span>Buying price</span><span />
      </div>
      {lines.map((l, i) => (
        <ReceiveLineRow key={l.key} line={l} index={i} removable={lines.length > 1} canCost={canCost} canManage={canManage}
          categories={categories} topLevel={topLevel} catLabel={catLabel} setLine={setLine} onRemove={() => onRemoveLine(l.key)} />
      ))}
      <button type="button" onClick={onAddLine} className="mb-2 mt-1 min-h-11 text-sm text-text-muted hover:text-text">+ Add another line</button>

      <p className="mb-4 text-xs text-text-muted">
        Stock goes on the shelf when you save the shipment.{' '}
        {canCost
          ? 'New products wait for a manager to add the buying price and approve them.'
          : 'Buying prices are set by a manager or admin after the shipment is received.'}
      </p>

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onSaveDraft} disabled={busy} className="min-h-11 rounded-lg border border-ink px-4 text-sm font-semibold hover:bg-paper disabled:opacity-50">Save draft</button>
        <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-ink-soft disabled:opacity-50">{busy ? 'Saving…' : 'Save shipment'}</button>
      </div>
    </form>
  );
}
