import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { shopifyApi, categoriesApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';

import Picker from '../components/Picker';
const badgeStyles = {
  new: 'bg-success-soft text-success',
  update: 'bg-accent/20 text-accent-ink',
  unchanged: 'bg-line text-text-muted',
};

// Debounces a per-row save so we're not firing a PATCH on every keystroke —
// waits for a short pause in typing, then saves.
function useDebouncedSave(delay = 500) {
  const timers = useState(() => new Map())[0];
  return (key, fn) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, delay));
  };
}

export default function ShopifySync() {
  const toast = useToast();
  const dialog = useDialog();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [error, setError] = useState('');
  const [edits, setEdits] = useState({}); // { [stagingId]: { sku, category_id, saving, saved, error } }
  const queryClient = useQueryClient();
  const debouncedSave = useDebouncedSave();

  const [storeChoice, setStoreChoice] = useState('all');
  const [selected, setSelected] = useState(() => new Set());     // rows ticked for "set category" / "approve selected"
  const [visibleCount, setVisibleCount] = useState(50);          // long lists are drawn 50 at a time (kinder to phones)
  const [bulkBusy, setBulkBusy] = useState(false);

  // Refreshes by itself: a product changed in the store (live sync) or pulled by anyone shows up here without a reload.
  const { data: staged, isLoading } = useQuery({
    queryKey: ['shopify-staging'],
    queryFn: () => shopifyApi.listStaging('pending').then((r) => r.data.data),
    refetchInterval: 15_000,
  });

  const { data: connections = [] } = useQuery({
    queryKey: ['shopify-connections'],
    queryFn: () => shopifyApi.connections().then((r) => r.data.data),
    refetchInterval: 15_000,
  });

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list().then((r) => r.data.data),
  });

  function fieldValue(row, field) {
    return edits[row.id]?.[field] !== undefined ? edits[row.id][field] : (row[field] ?? '');
  }

  async function saveField(row, field, value) {
    setEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], [field]: value, saving: true, error: null } }));
    try {
      await shopifyApi.updateStaging(row.id, { [field]: value });
      setEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], saving: false, saved: true } }));
      queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
    } catch (err) {
      setEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], saving: false, error: getErrorMessage(err, 'Could not save.') } }));
    }
  }

  function handleSkuChange(row, value) {
    setEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], sku: value, saved: false } }));
    debouncedSave(`sku-${row.id}`, () => saveField(row, 'sku', value));
  }

  function handleCategoryChange(row, value) {
    saveField(row, 'category_id', value || null);
  }

  async function handleSync() {
    setSyncing(true);
    setError('');
    setSyncResult(null);
    try {
      const { data } = await shopifyApi.sync(storeChoice === 'all' ? undefined : Number(storeChoice));
      setSyncResult(data.data);
      queryClient.invalidateQueries({ queryKey: ['shopify-connections'] });
      queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
    } catch (err) {
      setError(getErrorMessage(err, 'Sync failed.'));
    } finally {
      setSyncing(false);
    }
  }

  async function handleApprove(id) {
    try {
      await shopifyApi.approve(id);
      queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not approve.'));
    }
  }

  async function handleReject(id) {
    await shopifyApi.reject(id);
    queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
  }

  const categoryOptions = (categories || []).map((c) => ({ value: c.id, label: c.name }));
  const rowNeedsCategory = (row) => row.match_status === 'new' && !fieldValue(row, 'category_id');
  const toggleSelected = (id) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // Runs an async job for each row, a few at a time, so a long selection doesn't hammer the server or the phone.
  async function inChunks(rows, job, size = 4) {
    const results = [];
    for (let i = 0; i < rows.length; i += size) {
      // eslint-disable-next-line no-await-in-loop
      results.push(...await Promise.allSettled(rows.slice(i, i + size).map(job)));
    }
    return results;
  }

  async function bulkSetCategory(categoryId) {
    const rows = (staged || []).filter((r) => selected.has(r.id) && r.match_status === 'new');
    if (!categoryId || rows.length === 0) { toast.error('Tick at least one new product first.'); return; }
    setBulkBusy(true);
    const results = await inChunks(rows, (r) => shopifyApi.updateStaging(r.id, { category_id: categoryId }));
    const failed = results.filter((r) => r.status === 'rejected').length;
    queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
    setBulkBusy(false);
    if (failed) toast.error(`Category set for ${rows.length - failed}. ${failed} could not be saved.`);
    else toast.success(`Category set for ${rows.length} product${rows.length === 1 ? '' : 's'}.`);
  }

  async function approveSelected() {
    const rows = (staged || []).filter((r) => selected.has(r.id));
    const ready = rows.filter((r) => !rowNeedsCategory(r));
    const waiting = rows.length - ready.length;
    if (ready.length === 0) { toast.error('The ticked products still need a category.'); return; }
    setBulkBusy(true);
    const results = await inChunks(ready, (r) => shopifyApi.approve(r.id));
    const failed = results.filter((r) => r.status === 'rejected').length;
    queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
    setSelected(new Set());
    setBulkBusy(false);
    const notes = [waiting ? `${waiting} still need a category` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
    if (notes) toast.error(`Approved ${ready.length - failed}. ${notes}.`);
    else toast.success(`Approved ${ready.length} product${ready.length === 1 ? '' : 's'}.`);
  }

  async function handleApproveAll() {
    if (!(await dialog.confirm(`Approve all ${staged.length} pending items? New products will be created and matched products updated.`))) return;
    const { data } = await shopifyApi.approveAll();
    queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
    if (data.data.failed.length > 0) {
      toast.error(`Approved ${data.data.approved}. ${data.data.failed.length} failed — usually a new product still missing a category. Check those rows.`);
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="font-display font-700 text-2xl">Shopify sync</h1>
      </div>
      <p className="text-text-muted text-sm mb-6">
        Pull your Shopify or WooCommerce catalog in for review. Nothing is added or changed in your product list until
        you approve it here. SKUs auto-assign if left blank — for a new product, just pick a category, then approve.
      </p>

      {connections.length === 0 && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-line bg-surface text-sm">
          <div className="font-medium mb-0.5">No store is connected yet</div>
          <div className="text-text-muted text-xs">
            Connect Shopify or WooCommerce first: <b>Settings → Income sources → Add income source</b>, then press <b>Connect</b>.
            Then come back here and press <b>Pull products</b>.
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3">
        {connections.length > 1 && (
          <select
            value={storeChoice} onChange={(e) => setStoreChoice(e.target.value)} aria-label="Which store to pull from"
            className="px-3 py-2.5 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent"
          >
            <option value="all">All connected stores</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.platform === 'shopify' ? 'Shopify' : 'WooCommerce'})</option>)}
          </select>
        )}
        <button
          onClick={handleSync}
          disabled={syncing || connections.length === 0}
          className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors disabled:opacity-50"
        >
          {syncing ? 'Pulling products…' : connections.length === 1 ? `Pull products from ${connections[0].name}` : 'Pull products'}
        </button>
        {staged?.length > 0 && (
          <button
            onClick={handleApproveAll}
            className="px-4 py-2.5 rounded-lg border border-line text-sm font-medium hover:border-text-muted transition-colors"
          >
            Approve all ({staged.length})
          </button>
        )}
      </div>

      {connections.length > 0 && (
        <ul className="mb-6 text-xs text-text-muted space-y-0.5">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium text-text">{c.name}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.live_sync_enabled ? 'bg-success-soft text-success' : 'bg-line text-text-muted'}`}>
                {c.live_sync_enabled ? 'Live sync ON' : 'Live sync off'}
              </span>
              <span>{c.last_synced_at ? `last pulled ${new Date(`${c.last_synced_at.replace(' ', 'T')}Z`).toLocaleString()}` : 'not pulled yet'}</span>
              {!c.live_sync_enabled && <Link to="/settings?tab=stores" className="underline">turn on live sync</Link>}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">
          {error}
        </div>
      )}

      {syncResult && (
        <div className="mb-6 px-3.5 py-2.5 rounded-lg bg-success-soft text-success text-sm">
          Pulled {syncResult.total} variant{syncResult.total === 1 ? '' : 's'} — {syncResult.created} new, {syncResult.updated} changed, {syncResult.unchanged} unchanged. Review below.
          {syncResult.results?.length > 1 && (
            <ul className="mt-1.5 text-xs space-y-0.5">
              {syncResult.results.map((r) => (
                <li key={r.id || r.name} className={r.ok ? '' : 'text-danger'}>
                  {r.name}: {r.ok ? `${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged` : `could not pull - ${r.error}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {staged?.length > 0 && (() => {
        const needing = staged.filter(rowNeedsCategory);
        return (
          <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
            <button
              type="button"
              onClick={() => setSelected(new Set(staged.filter(rowNeedsCategory).map((r) => r.id)))}
              disabled={needing.length === 0}
              className="min-h-[44px] px-3 rounded-lg border border-line font-medium hover:border-text-muted disabled:opacity-40"
            >
              Tick all needing a category ({needing.length})
            </button>
            <button type="button" onClick={() => setSelected(new Set(staged.map((r) => r.id)))} className="min-h-[44px] px-3 rounded-lg border border-line font-medium hover:border-text-muted">
              Tick all ({staged.length})
            </button>
            {selected.size > 0 && (
              <button type="button" onClick={() => setSelected(new Set())} className="min-h-[44px] px-3 text-text-muted underline">Clear ticks</button>
            )}
          </div>
        );
      })()}

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[840px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Product</th>
              <th className="px-4 py-3 font-medium font-mono">SKU</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium text-right">Price</th>
              <th className="px-4 py-3 font-medium text-right">Stock</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {staged?.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-text-muted">
                Nothing pending review. Press “Pull products” to bring in your catalog - or wait: with live sync on, changes in your store appear here by themselves.
              </td></tr>
            )}
            {staged?.slice(0, visibleCount).map((s) => {
              const isNew = s.match_status === 'new';
              const categoryId = fieldValue(s, 'category_id');
              const needsCategory = isNew && !categoryId;
              const rowState = edits[s.id] || {};
              return (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium">
                    <label className="flex items-start gap-3 min-h-[44px] sm:min-h-0 cursor-pointer">
                      <input
                        type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelected(s.id)}
                        aria-label={`Tick ${s.name}`} className="mt-0.5 w-5 h-5 shrink-0 accent-[var(--color-ink)]"
                      />
                      <span className="min-w-0 break-words">{s.name}</span>
                    </label>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      value={fieldValue(s, 'sku')}
                      onChange={(e) => handleSkuChange(s, e.target.value)}
                      placeholder="auto-assigned"
                      className="w-28 px-2 py-1 rounded-md border border-line bg-paper font-mono text-xs outline-none focus:border-accent placeholder:text-text-muted/60 placeholder:italic"
                    />
                  </td>
                  <td className="px-4 py-3">
                    {isNew ? (
                      <Picker
                        value={categoryId} title="Category" aria-label={`Category for ${s.name}`}
                        onChange={(v) => handleCategoryChange(s, v)}
                        options={categoryOptions} invalid={needsCategory} className="sm:w-44"
                        onCreate={async (name) => {
                          const { data } = await categoriesApi.create({ name });
                          queryClient.invalidateQueries({ queryKey: ['categories'] });
                          return data.data.id;
                        }}
                        createLabel="New category"
                      />
                    ) : (
                      <span className="text-xs text-text-muted">matches existing</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{(s.sell_price / 100).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right font-mono">{s.inventory_qty}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badgeStyles[s.match_status]}`}>
                      {s.match_status === 'new' ? 'New product' : s.match_status === 'update' ? 'Updates existing' : 'No change'}
                    </span>
                    {rowState.error && <div className="text-danger text-xs mt-1">{rowState.error}</div>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="w-full">
                    <div className="flex gap-2 sm:justify-end">
                      <button
                        type="button" onClick={() => handleReject(s.id)}
                        className="flex-1 sm:flex-none min-h-[44px] px-4 rounded-lg border border-danger/40 text-danger text-sm font-medium hover:bg-danger-soft"
                      >
                        Reject
                      </button>
                      <button
                        type="button" onClick={() => handleApprove(s.id)}
                        disabled={needsCategory || rowState.saving}
                        className="flex-1 sm:flex-none min-h-[44px] px-4 rounded-lg bg-success text-white text-sm font-medium hover:opacity-90 disabled:bg-line disabled:text-text-muted"
                      >
                        Approve
                      </button>
                    </div>
                    {needsCategory && <p className="mt-1.5 text-xs text-danger sm:text-right">Choose a category first</p>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {staged && staged.length > visibleCount && (
        <button type="button" onClick={() => setVisibleCount((n) => n + 50)} className="mt-3 w-full min-h-[48px] rounded-lg border border-line text-sm font-medium hover:border-text-muted">
          Show 50 more ({staged.length - visibleCount} not shown)
        </button>
      )}

      {selected.size > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 md:-mx-8 mt-4 px-4 md:px-8 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-surface border-t border-line shadow-[0_-6px_20px_rgb(0_0_0/0.08)]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium mr-auto">{selected.size} ticked</span>
            <div className="w-full sm:w-56">
              <Picker
                value="" onChange={bulkSetCategory} title="Set category for ticked products" aria-label="Set category for ticked products"
                placeholder="Set category…" options={categoryOptions} disabled={bulkBusy}
                onCreate={async (name) => {
                  const { data } = await categoriesApi.create({ name });
                  queryClient.invalidateQueries({ queryKey: ['categories'] });
                  return data.data.id;
                }}
                createLabel="New category"
              />
            </div>
            <button
              type="button" onClick={approveSelected} disabled={bulkBusy}
              className="flex-1 sm:flex-none min-h-[44px] px-5 rounded-lg bg-success text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {bulkBusy ? 'Working…' : `Approve ${selected.size}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
