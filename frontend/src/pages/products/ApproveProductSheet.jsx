import Sheet from '../../components/Sheet';

/** Approve a proposed product: the manager sets the buying and selling price. */
export default function ApproveProductSheet({ product: approving, form: approveForm, setForm: setApproveForm, error: approveError, canSeeCost, onClose, onSubmit }) {
  return (
      <Sheet onClose={() => onClose()} size="sm" as="form" onSubmit={onSubmit}>
          <h2 className="font-display font-700 text-lg mb-1">Approve product</h2>
          <p className="text-text-muted text-sm mb-4">{approving.name} <span className="font-mono">({approving.sku})</span></p>
          {approveError && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{approveError}</div>}

          {canSeeCost && (
            <>
              <label className="block text-xs font-medium text-text-muted mb-1">Buying (cost) price</label>
              <input type="number" step="0.01" min="0" value={approveForm.cost_price}
                onChange={(e) => setApproveForm({ ...approveForm, cost_price: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />
            </>
          )}
          <label className="block text-xs font-medium text-text-muted mb-1">Selling price</label>
          <input required type="number" step="0.01" min="0" value={approveForm.sell_price}
            onChange={(e) => setApproveForm({ ...approveForm, sell_price: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5" />

          <div className="flex gap-2">
            <button type="button" onClick={() => onClose()} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Approve</button>
          </div>
        </Sheet>
  );
}
