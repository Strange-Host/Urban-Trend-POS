import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { productsApi, categoriesApi, inventoryApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useDialog } from '../context/UIContext';

const emptyForm = { sku: '', barcode: '', name: '', category_id: '', cost_price: '', sell_price: '' };
const emptyAdjustForm = { qty: '', reason: 'restock' };

export default function Products() {
  const dialog = useDialog();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...} = edit
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [adjusting, setAdjusting] = useState(null); // the product row being stock-adjusted, or null
  const [adjustForm, setAdjustForm] = useState(emptyAdjustForm);
  const [adjustError, setAdjustError] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['products', 'admin', search, page],
    queryFn: () => productsApi.list({ q: search, page, pageSize: 20 }).then((r) => r.data),
  });

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list().then((r) => r.data.data),
  });

  function openNew() {
    setForm(emptyForm);
    setError('');
    setEditing({});
  }

  function openEdit(p) {
    setForm({
      sku: p.sku, barcode: p.barcode || '', name: p.name,
      category_id: p.category_id || '', cost_price: (p.cost_price / 100).toString(),
      sell_price: (p.sell_price / 100).toString(),
    });
    setError('');
    setEditing(p);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const payload = {
      ...form,
      cost_price: Math.round((parseFloat(form.cost_price) || 0) * 100),
      sell_price: Math.round(parseFloat(form.sell_price) * 100),
      category_id: form.category_id || null,
      barcode: form.barcode || null,
    };
    try {
      if (editing.id) {
        await productsApi.update(editing.id, payload);
      } else {
        await productsApi.create(payload);
      }
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setEditing(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save product.'));
    }
  }

  async function handleDelete(id) {
    if (!(await dialog.confirm({ message: 'Deactivate this product? It will no longer appear at checkout.', danger: true }))) return;
    await productsApi.remove(id);
    queryClient.invalidateQueries({ queryKey: ['products'] });
  }

  function openAdjust(p) {
    setAdjustForm(emptyAdjustForm);
    setAdjustError('');
    setAdjusting(p);
  }

  async function handleAdjust(e) {
    e.preventDefault();
    setAdjustError('');
    try {
      await inventoryApi.adjust({ product_id: adjusting.id, change_qty: parseInt(adjustForm.qty, 10), reason: adjustForm.reason });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setAdjusting(null);
    } catch (err) {
      setAdjustError(getErrorMessage(err, 'Could not adjust stock.'));
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Products</h1>
          <p className="text-text-muted text-sm mt-1">{data?.total ?? '—'} products in catalog</p>
        </div>
        <button
          onClick={openNew}
          className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors"
        >
          + Add product
        </button>
      </div>

      <input
        type="text"
        placeholder="Search by name, SKU, or barcode…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        className="w-full max-w-sm mb-5 px-4 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none"
      />

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[780px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium font-mono">SKU</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium text-right">Price</th>
              <th className="px-4 py-3 font-medium text-right">Stock</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>
            )}
            {data?.data.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0 hover:bg-paper/50">
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3 font-mono text-text-muted">{p.sku}</td>
                <td className="px-4 py-3 text-text-muted">{p.category_name || '—'}</td>
                <td className="px-4 py-3 text-right font-mono">{(p.sell_price / 100).toFixed(2)}</td>
                <td className={`px-4 py-3 text-right font-mono ${p.total_stock <= 5 ? 'text-danger' : ''}`}>
                  {p.total_stock}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => openAdjust(p)} className="text-xs text-text-muted hover:text-text mr-3">Adjust stock</button>
                  <button onClick={() => openEdit(p)} className="text-xs text-text-muted hover:text-text mr-3">Edit</button>
                  <button onClick={() => handleDelete(p.id)} className="text-xs text-danger hover:opacity-70">Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex gap-2 mt-4">
          {Array.from({ length: data.totalPages }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              onClick={() => setPage(n)}
              className={`w-8 h-8 rounded-lg text-sm ${n === page ? 'bg-ink text-white' : 'bg-surface border border-line'}`}
            >
              {n}
            </button>
          ))}
        </div>
      )}

      {editing !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <form
            onSubmit={handleSave}
            onClick={(e) => e.stopPropagation()}
            className="bg-surface rounded-xl p-6 w-full max-w-md max-h-full overflow-y-auto"
          >
            <h2 className="font-display font-700 text-lg mb-4">{editing.id ? 'Edit product' : 'New product'}</h2>

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
                <select value={form.category_id} onChange={async (e) => {
                  if (e.target.value === '__new__') {
                    const name = await dialog.prompt('New category name:');
                    if (name && name.trim()) {
                      categoriesApi.create({ name: name.trim() }).then(({ data }) => {
                        queryClient.invalidateQueries({ queryKey: ['categories'] });
                        setForm((f) => ({ ...f, category_id: data.data.id }));
                      }).catch((err) => setError(getErrorMessage(err, 'Could not create category.')));
                    }
                  } else {
                    setForm({ ...form, category_id: e.target.value });
                  }
                }}
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent">
                  <option value="">None</option>
                  {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="__new__">+ New category…</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Cost price</label>
                <input type="number" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Sell price</label>
                <input required type="number" step="0.01" value={form.sell_price} onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent" />
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button type="button" onClick={() => setEditing(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">
                Cancel
              </button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {adjusting && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setAdjusting(null)}>
          <form onSubmit={handleAdjust} onClick={(e) => e.stopPropagation()} className="bg-surface rounded-xl p-6 w-full max-w-sm max-h-full overflow-y-auto">
            <h2 className="font-display font-700 text-lg mb-1">Adjust stock</h2>
            <p className="text-text-muted text-sm mb-4">{adjusting.name} — currently {adjusting.total_stock}</p>

            {adjustError && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{adjustError}</div>}

            <label className="block text-xs font-medium text-text-muted mb-1">Change (use negative to reduce)</label>
            <input
              type="number" required value={adjustForm.qty} onChange={(e) => setAdjustForm({ ...adjustForm, qty: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3"
              placeholder="e.g. 20 or -5"
            />

            <label className="block text-xs font-medium text-text-muted mb-1">Reason</label>
            <select value={adjustForm.reason} onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5">
              <option value="restock">Restock</option>
              <option value="adjustment">Stock count adjustment</option>
              <option value="return">Customer return</option>
            </select>

            <div className="flex gap-2">
              <button type="button" onClick={() => setAdjusting(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">
                Cancel
              </button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
                Apply
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
