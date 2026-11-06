import { useState } from 'react';
import PageHeader from '../components/shell/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { productsApi, categoriesApi, inventoryApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useDialog, useToast } from '../context/UIContext';
import { useAuth } from '../context/AuthContext';
import { SkeletonRows } from '../components/Skeleton';
import ProductFormSheet from './products/ProductFormSheet';
import ApproveProductSheet from './products/ApproveProductSheet';
import MoveProductSheet from './products/MoveProductSheet';
import AdjustStockSheet from './products/AdjustStockSheet';

const emptyForm = { sku: '', barcode: '', name: '', category_id: '', cost_price: '', sell_price: '' };
const emptyAdjustForm = { mode: 'add', qty: '', reason: 'restock' };

// catalogue 'shop': the products the shop stocks and sells at the till, with their stock.
// catalogue 'online': the Shopify/WooCommerce listings. The shop does not track their stock, so there is no stock column
// here and nothing to adjust; the only thing to do with one is add it to the shop.
export default function Products({ catalogue = 'shop' }) {
  const online = catalogue === 'online';
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
  const [moving, setMoving] = useState(null); // { product, to: 'shop' | 'online' } while the move sheet is open
  const [openingStock, setOpeningStock] = useState('');
  const [moveError, setMoveError] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['products', 'admin', catalogue, search, page],
    queryFn: () => productsApi.list({ q: search, page, pageSize: 20, catalogue }).then((r) => r.data),
  });

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list().then((r) => r.data.data),
  });

  const { data: pending } = useQuery({
    queryKey: ['products', 'pending'],
    queryFn: () => productsApi.listPending().then((r) => r.data.data),
    enabled: !online && (canApprove || canPropose),
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

  function openMove(product, to) {
    setOpeningStock('');
    setMoveError('');
    setMoving({ product, to });
  }

  async function handleMove(e) {
    e.preventDefault();
    setMoveError('');
    const { product, to } = moving;
    const payload = { catalogue: to };
    if (to === 'shop') {
      const units = openingStock === '' ? 0 : parseInt(openingStock, 10);
      if (Number.isNaN(units) || units < 0) { setMoveError('Enter how many you hold on the shelf now (0 or more).'); return; }
      if (units > 0) payload.opening_stock = units;
    } else if (product.total_stock > 0) {
      payload.clear_stock = true;
    }
    try {
      await productsApi.setCatalogue(product.id, payload);
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      toast.success(to === 'shop' ? `"${product.name}" is now sold in the shop.` : `"${product.name}" moved to the online products.`);
      setMoving(null);
    } catch (err) {
      setMoveError(getErrorMessage(err, 'Could not move this product.'));
    }
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
      <PageHeader
        title={online ? 'Online products' : 'Products'}
        description={online
          ? `${data?.total ?? '—'} listings from your online store. The shop does not track their stock.`
          : `${data?.total ?? '—'} products in catalog`}
        actions={!online && (canManage || canPropose) ? (
          <button
            onClick={openNew}
            className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors"
          >
            {canManage ? '+ Add product' : '+ Propose product'}
          </button>
        ) : null}
      />

      {!online && pending?.length > 0 && (
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
              {!online && <th className="px-4 py-3 font-medium text-right">Stock</th>}
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <SkeletonRows cols={6} />
            )}
            {!isLoading && data?.data.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                {online
                  ? 'No online products yet. Pull them from your store on the Shopify sync page and approve them there.'
                  : search ? `No products match "${search}".` : 'No products yet.'}
              </td></tr>
            )}
            {data?.data.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0 hover:bg-paper/50">
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3 font-mono text-text-muted">{p.sku}</td>
                <td className="px-4 py-3 text-text-muted">{p.category_name || '—'}</td>
                <td className="px-4 py-3 text-right font-mono">{(p.sell_price / 100).toFixed(2)}</td>
                {!online && (
                  <td className={`px-4 py-3 text-right font-mono ${p.total_stock <= 5 ? 'text-danger' : ''}`}>
                    {p.total_stock}
                  </td>
                )}
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {online ? (
                    canManage && <button onClick={() => openMove(p, 'shop')} className="text-xs font-medium text-text hover:opacity-70">Add to shop</button>
                  ) : (
                    <>
                      {canAdjust && <button onClick={() => openAdjust(p)} className="text-xs text-text-muted hover:text-text mr-3">Adjust stock</button>}
                      {canManage && <button onClick={() => openEdit(p)} className="text-xs text-text-muted hover:text-text mr-3">Edit</button>}
                      {canManage && p.shopify_variant_id && <button onClick={() => openMove(p, 'online')} className="text-xs text-text-muted hover:text-text mr-3">Move to online</button>}
                      {canManage && <button onClick={() => handleDelete(p.id)} className="text-xs text-danger hover:opacity-70">Remove</button>}
                    </>
                  )}
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
        <ProductFormSheet editing={editing} form={form} setForm={setForm} error={error} canManage={canManage} canSeeCost={canSeeCost} categories={categories} onClose={() => setEditing(null)} onSubmit={handleSave} />
      )}

      {approving && (
        <ApproveProductSheet product={approving} form={approveForm} setForm={setApproveForm} error={approveError} canSeeCost={canSeeCost} onClose={() => setApproving(null)} onSubmit={handleApprove} />
      )}

      {moving && (
        <MoveProductSheet moving={moving} openingStock={openingStock} setOpeningStock={setOpeningStock} moveError={moveError} onClose={() => setMoving(null)} onSubmit={handleMove} />
      )}

      {adjusting && (
        <AdjustStockSheet adjusting={adjusting} adjustForm={adjustForm} setAdjustForm={setAdjustForm} adjustError={adjustError} onClose={() => setAdjusting(null)} onSubmit={handleAdjust} />
      )}
    </div>
  );
}
