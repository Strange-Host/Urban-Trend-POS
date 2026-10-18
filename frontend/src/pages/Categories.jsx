import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { categoriesApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast } from '../context/UIContext';

import Sheet from '../components/Sheet';
import Picker from '../components/Picker';
const emptyForm = { name: '', parent_id: '' };

export default function Categories() {
  const toast = useToast();
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...} = edit
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  // This screen also lists archived categories (the pickers elsewhere don't), hence its own query key under 'categories'.
  const { data: categories, isLoading } = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => categoriesApi.list({ include_archived: 1 }).then((r) => r.data.data),
  });
  const [deleting, setDeleting] = useState(null);   // the category being deleted (opens the "move products" sheet)

  const nameById = new Map((categories || []).map((c) => [c.id, c.name]));

  function openNew() {
    setForm(emptyForm);
    setError('');
    setEditing({});
  }

  function openEdit(c) {
    setForm({ name: c.name, parent_id: c.parent_id || '' });
    setError('');
    setEditing(c);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const payload = { name: form.name, parent_id: form.parent_id || null };
    try {
      if (editing.id) {
        await categoriesApi.update(editing.id, payload);
      } else {
        await categoriesApi.create(payload);
      }
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      setEditing(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save category.'));
    }
  }

  async function handleArchive(c, archived) {
    try {
      await (archived ? categoriesApi.archive(c.id) : categoriesApi.restore(c.id));
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      toast.success(archived ? `“${c.name}” was archived. It is hidden from pickers but kept on its products.` : `“${c.name}” is back.`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not change that category.'));
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Categories</h1>
          <p className="text-text-muted text-sm mt-1">{categories?.length ?? '—'} categories</p>
        </div>
        <button
          onClick={openNew}
          className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors"
        >
          + Add category
        </button>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[480px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Parent</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={3} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {categories?.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-text-muted">No categories yet.</td></tr>
            )}
            {categories?.map((c) => (
              <tr key={c.id} className={`border-b border-line last:border-0 ${c.is_archived ? 'opacity-60' : ''}`}>
                <td className="px-4 py-3 font-medium">
                  {c.name}
                  {c.is_archived ? <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-line text-text-muted font-medium align-middle">archived</span> : null}
                </td>
                <td className="px-4 py-3 text-text-muted">{c.parent_id ? nameById.get(c.parent_id) : '—'}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex gap-2 justify-start sm:justify-end flex-wrap">
                    <button onClick={() => openEdit(c)} className="min-h-[44px] sm:min-h-[36px] px-3 rounded-lg border border-line text-xs font-medium hover:border-text-muted">Edit</button>
                    <button onClick={() => handleArchive(c, !c.is_archived)} className="min-h-[44px] sm:min-h-[36px] px-3 rounded-lg border border-line text-xs font-medium hover:border-text-muted">
                      {c.is_archived ? 'Restore' : 'Archive'}
                    </button>
                    <button onClick={() => setDeleting(c)} className="min-h-[44px] sm:min-h-[36px] px-3 rounded-lg border border-danger/40 text-danger text-xs font-medium hover:bg-danger-soft">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== null && (
        <Sheet onClose={() => setEditing(null)} size="sm" as="form" onSubmit={handleSave}>
            <h2 className="font-display font-700 text-lg mb-4">{editing.id ? 'Edit category' : 'New category'}</h2>

            {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

            <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
            <input
              required autoFocus value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3"
              placeholder="e.g. Footwear"
            />

            <label className="block text-xs font-medium text-text-muted mb-1">Parent category (optional)</label>
            <Picker
              value={form.parent_id} title="Parent category" aria-label="Parent category" className="mb-5"
              onChange={(v) => setForm({ ...form, parent_id: v })}
              options={(categories || []).filter((c) => c.id !== editing.id && !c.is_archived).map((c) => ({ value: c.id, label: c.name }))}
              allowClear clearLabel="None — top level"
            />

            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">
                Cancel
              </button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
                Save
              </button>
            </div>
          </Sheet>
      )}

      {deleting && (
        <DeleteCategorySheet
          category={deleting} categories={categories || []}
          onClose={() => setDeleting(null)}
          onArchive={(c) => { setDeleting(null); handleArchive(c, true); }}
          onDone={() => { setDeleting(null); queryClient.invalidateQueries({ queryKey: ['categories'] }); queryClient.invalidateQueries({ queryKey: ['products'] }); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Delete a category: shows what is filed under it, and if anything is, asks where to move it first - all in one step.
// ---------------------------------------------------------------------------------------------------------------------
function DeleteCategorySheet({ category, categories, onClose, onArchive, onDone }) {
  const toast = useToast();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { data: usage, isLoading } = useQuery({
    queryKey: ['category-usage', category.id],
    queryFn: () => categoriesApi.usage(category.id).then((r) => r.data.data),
    staleTime: 0,
  });

  const options = categories.filter((c) => c.id !== category.id && !c.is_archived).map((c) => ({ value: c.id, label: c.name }));
  const parts = usage ? [
    usage.products ? `${usage.products} product${usage.products === 1 ? '' : 's'}${usage.inactiveProducts ? ` (${usage.inactiveProducts} switched off)` : ''}` : null,
    usage.staged ? `${usage.staged} item${usage.staged === 1 ? '' : 's'} waiting in the sync review` : null,
    usage.subcategories ? `${usage.subcategories} sub-categor${usage.subcategories === 1 ? 'y' : 'ies'}` : null,
  ].filter(Boolean) : [];
  const needsTarget = usage?.inUse && (usage.products > 0 || usage.staged > 0 || usage.other > 0);

  async function confirmDelete() {
    setBusy(true); setError('');
    try {
      await categoriesApi.remove(category.id, target || undefined);
      toast.success(`“${category.name}” was deleted.`);
      onDone();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not delete the category.'));
    } finally { setBusy(false); }
  }

  return (
    <Sheet onClose={onClose} size="sm" label={`Delete ${category.name}`}>
      <h2 className="font-display font-700 text-lg mb-1">Delete “{category.name}”?</h2>
      {isLoading && <p className="text-sm text-text-muted">Checking what uses it…</p>}
      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm" role="alert">{error}</div>}

      {usage && !usage.inUse && <p className="text-sm text-text-muted mb-4">Nothing uses this category, so it can simply be deleted.</p>}
      {usage && usage.inUse && (
        <>
          <p className="text-sm text-text-muted mb-3">Still in use by: <b className="text-text">{parts.join(', ') || 'other records'}</b>.</p>
          {needsTarget && (
            <>
              <label className="block text-xs font-medium text-text-muted mb-1">Move them to</label>
              <Picker value={target} onChange={setTarget} options={options} title="Move to which category?" aria-label="Move to which category" placeholder="Choose a category…" className="mb-3" />
            </>
          )}
          {usage.subcategories > 0 && <p className="text-xs text-text-muted mb-3">Its sub-categories move up one level.</p>}
          <p className="text-xs text-text-muted mb-4">Prefer to keep it on the products it already has? <button type="button" onClick={() => onArchive(category)} className="underline">Archive it instead</button>: it disappears from pickers but nothing changes on old products.</p>
        </>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 min-h-[44px] rounded-lg border border-line text-sm font-medium">Cancel</button>
        <button
          type="button" onClick={confirmDelete}
          disabled={busy || isLoading || (needsTarget && !target)}
          className="flex-1 min-h-[44px] rounded-lg bg-danger text-white text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'Deleting…' : needsTarget ? 'Move & delete' : 'Delete'}
        </button>
      </div>
    </Sheet>
  );
}
