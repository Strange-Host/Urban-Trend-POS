import Sheet from '../../components/Sheet';
import { Segmented } from '../../components/Picker';

/** Add or remove stock for one product, with a reason. */
export default function AdjustStockSheet({ adjusting, adjustForm, setAdjustForm, adjustError, onClose, onSubmit }) {
  return (
      <Sheet onClose={() => onClose()} size="sm" as="form" onSubmit={onSubmit}>
          <h2 className="font-display font-700 text-lg mb-1">Adjust stock</h2>
          <p className="text-text-muted text-sm mb-4">{adjusting.name} — currently {adjusting.total_stock}</p>

          {adjustError && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{adjustError}</div>}

          <Segmented
            value={adjustForm.mode} aria-label="Add or remove stock" className="mb-4"
            onChange={(mode) => setAdjustForm((f) => ({ ...f, mode, reason: mode === 'remove' && f.reason === 'restock' ? 'adjustment' : mode === 'add' && f.reason === 'adjustment' ? 'restock' : f.reason }))}
            options={[{ value: 'add', label: '＋ Add stock' }, { value: 'remove', label: '－ Remove stock' }]}
          />

          <label htmlFor="adjust-qty" className="block text-xs font-medium text-text-muted mb-1">How many units?</label>
          <input
            id="adjust-qty" type="text" inputMode="numeric" pattern="[0-9]*" enterKeyHint="done" autoComplete="off" maxLength={6}
            value={adjustForm.qty} onChange={(e) => setAdjustForm({ ...adjustForm, qty: e.target.value.replace(/\D/g, '') })}
            className="w-full px-3 py-3 rounded-lg border border-line outline-none focus:border-accent text-xl font-mono mb-2"
            placeholder="0"
          />
          <div className="flex gap-2 mb-3">
            {[1, 5, 10].map((n) => (
              <button key={n} type="button" onClick={() => setAdjustForm((f) => ({ ...f, qty: String((parseInt(f.qty, 10) || 0) + n) }))}
                className="flex-1 min-h-[44px] rounded-lg border border-line text-sm font-medium hover:bg-paper">+{n}</button>
            ))}
          </div>
          {(() => {
            const amount = parseInt(adjustForm.qty, 10) || 0;
            const after = (adjusting.total_stock || 0) + (adjustForm.mode === 'remove' ? -amount : amount);
            return amount > 0 && (
              <p className={`text-sm mb-3 ${after < 0 ? 'text-danger' : 'text-text-muted'}`}>
                Stock: {adjusting.total_stock || 0} → <b>{after}</b>{after < 0 ? ' (below zero)' : ''}
              </p>
            );
          })()}

          <div className="block text-xs font-medium text-text-muted mb-1">Reason</div>
          <Segmented
            value={adjustForm.reason} aria-label="Reason" className="mb-5"
            onChange={(reason) => setAdjustForm({ ...adjustForm, reason })}
            options={[{ value: 'restock', label: 'Restock' }, { value: 'adjustment', label: 'Count fix' }, { value: 'return', label: 'Return' }]}
          />

          <div className="flex gap-2">
            <button type="button" onClick={() => onClose()} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">
              Cancel
            </button>
            <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
              Apply
            </button>
          </div>
        </Sheet>
  );
}
