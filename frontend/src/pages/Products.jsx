import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { productsApi, categoriesApi, inventoryApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useDialog, useToast } from '../context/UIContext';
import { useAuth } from '../context/AuthContext';

import Sheet from '../components/Sheet';
import Picker, { Segmented } from '../components/Picker';
const emptyForm = { sku: '', barcode: '', name: '', category_id: '', cost_price: '', sell_price: '' };
const emptyAdjustForm = { mode: 'add', qty: '', reason: 'restock' };

export default function Products() {
  const dialog = useDialog();
  const toast = useToast();
  const { can } = useAuth();
  // What this person may do. The server enforces every one of these; the screen just doesn't offer the rest.
  const canManage = can('products.manage');
  const canPropose = can('products.propose');
  const canApprove = can('products.approve');
  const canSeeCost = can('products.view_cost');
  const canAdjust = can('inventory.adjust');
  const [approving, setApproving] = useState(null); // the proposed product being approved, or null
  const [approveForm, setApproveForm] = useState({ cost_price: '', sell_price: '' });
  const [approveError, setApproveError] = useState('');
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

  const { data: pending } = useQuery({
    queryKey: ['products', 'pending'],
    queryFn: () => productsApi.listPending().then((r) => r.data.data),
    enabled: canApprove || canPropose,
  });

  function openApprove(p) {
    setApproveForm({ cost_price: canSeeCost && p.cost_price ? (p.cost_price / 100).toString() : '', sell_price: (p.sell_price / 100).toString() });
    setApproveError('');
    setApproving(p);
  }

  async function handleApprove(e) {
    e.preventDefault();
    setApproveError('');
    const payload = { sell_price: Math.round(parseFloat(approveForm.sell_price) * 100) };
    if (canSeeCost) payload.cost_price = Math.round((parseFloat(approveForm.cost_price) || 0) * 100);
    try {
      await productsApi.approve(approving.id, payload);
      queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success(`"${approving.name}" approved and added to the catalog.`);
      setApproving(null);
    } catch (err) {
      setApproveError(getErrorMessage(err, 'Could not approve product.'));
    }
  }

  async function handleReject(p) {
    const note = await dialog.prompt({ message: `Why are you rejecting "${p.name}"? The storekeeper will see this.`, required: true, confirmLabel: 'Reject' });
    if (!note) return;
    try {
      await productsApi.reject(p.id, note);
      queryClient.invalidateQueries({ queryKey: ['products'] });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not reject product.'));
    }
  }

  function openNew() {
    setForm(emptyForm);
    setError('');
    setEditing({});
  }

  function openEdit(p) {
    setForm({
      sku: p.sku, barcode: p.barcode || '', name: p.name,
      category_id: p.category_id || '', cost_price: p.cost_price != null ? (p.cost_price / 100).toString() : '',
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
    if (!canSeeCost) delete payload.cost_price; // buying price is not theirs to set
    try {
      if (editing.id) {
        await productsApi.update(editing.id, payload);
      } else {
        const res = await productsApi.create(payload);
        if (res.data?.data?.approval_status === 'pending') toast.success('Sent for approval. It will appear in the catalog once a manager approves it.');
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
      const amount = parseInt(adjustForm.qty, 10);
      if (!amount || amount < 1) { setAdjustError('Enter how many units (1 or more).'); return; }
      await inventoryApi.adjust({ product_id: adjusting.id, change_qty: adjustForm.mode === 'remove' ? -amount : amount, reason: adjustForm.reason });
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
        {(canManage || canPropose) && (
          <button
            onClick={openNew}
            className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors"
          >
            {canManage ? '+ Add product' : '+ Propose product'}
          </button>
        )}
      </div>

      {pending?.length > 0 && (
        <div className="mb-6 bg-surface border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-line flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full bg-accent text-accent-ink text-xs font-medium">{pending.length}</span>
            <h2 className="font-display font-700 text-sm">{canApprove ? 'Waiting for your approval' : 'Waiting for approval'}</h2>
          </div>
          <ul>
            {pending.map((p) => (
              <li key={p.id} className="px-4 py-3 border-b border-line last:border-0 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-text-muted font-mono">
                    {p.sku} · KES {(p.sell_price / 100).toFixed(2)}{p.submitted_by_name ? ` · proposed by ${p.submitted_by_name}` : ''}
                  </div>
                </div>
                {canApprove ? (
                  <div className="flex gap-3 whitespace-nowrap">
                    <button onClick={() => openApprove(p)} className="text-xs font-medium text-success hover:opacity-70">Approve</button>
                    <button onClick={() => handleReject(p)} className="text-xs text-danger hover:opacity-70">Reject</button>
                  </div>
                ) : (
                  <span className="text-xs text-text-muted">Not in the catalog yet</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

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
                  {canAdjust && <button onClick={() => openAdjust(p)} className="text-xs text-text-muted hover:text-text mr-3">Adjust stock</button>}
                  {canManage && <button onClick={() => openEdit(p)} className="text-xs text-text-muted hover:text-text mr-3">Edit</button>}
                  {canManage && <button onClick={() => handleDelete(p.id)} className="text-xs text-danger hover:opacity-70">Remove</button>}
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
        <Sheet onClose={() => setEditing(null)} size="md" as="form" onSubmit={handleSave}>
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
              <button type="button" onClick={() => setEditing(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">
                Cancel
              </button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
                Save
              </button>
            </div>
          </Sheet>
      )}

      {approving && (
        <Sheet onClose={() => setApproving(null)} size="sm" as="form" onSubmit={handleApprove}>
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
              <button type="button" onClick={() => setApproving(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Approve</button>
            </div>
          </Sheet>
      )}

      {adjusting && (
        <Sheet onClose={() => setAdjusting(null)} size="sm" as="form" onSubmit={handleAdjust}>
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
              <button type="button" onClick={() => setAdjusting(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">
                Cancel
              </button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
                Apply
              </button>
            </div>
          </Sheet>
      )}
    </div>
  );
}
