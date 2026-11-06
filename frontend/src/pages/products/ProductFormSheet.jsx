import { useQueryClient } from '@tanstack/react-query';
import { categoriesApi } from '../../api/endpoints';
import Sheet from '../../components/Sheet';
import Picker from '../../components/Picker';

/** New / edit / propose product form. The page owns the form state and the save call. */
export default function ProductFormSheet({ editing, form, setForm, error, canManage, canSeeCost, categories, onClose, onSubmit }) {
  const queryClient = useQueryClient();
  return (
      <Sheet onClose={() => onClose()} size="md" as="form" onSubmit={onSubmit}>
          <h2 className="font-display font-700 text-lg mb-4">{editing.id ? 'Edit product' : canManage ? 'New product' : 'Propose a product'}</h2>
          {!canManage && !editing.id && (
            <p className="mb-3 px-3 py-2 rounded-lg bg-paper border border-line text-xs text-text-muted">
              A manager reviews new products and sets the buying price before they appear in the catalog or at the till.
            </p>
          )}

          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">SKU</label>
              <input required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Barcode</label>
              <input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Category</label>
              <Picker
                value={form.category_id} title="Category" aria-label="Category"
                onChange={(v) => setForm({ ...form, category_id: v })}
                options={(categories || []).map((c) => ({ value: c.id, label: c.name }))}
                allowClear clearLabel="None" createLabel="New category"
                onCreate={canManage ? async (name) => {
                  const { data } = await categoriesApi.create({ name });
                  queryClient.invalidateQueries({ queryKey: ['categories'] });
                  return data.data.id;
                } : undefined}
              />
            </div>
            {canSeeCost && (
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Cost price</label>
                <input type="number" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent" />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Sell price</label>
              <input required type="number" step="0.01" value={form.sell_price} onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent" />
            </div>
          </div>

          <div className="flex gap-2 mt-5">
            <button type="button" onClick={() => onClose()} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">
              Cancel
            </button>
            <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
              Save
            </button>
          </div>
        </Sheet>
  );
}
