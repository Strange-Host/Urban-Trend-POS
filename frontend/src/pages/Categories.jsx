import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { categoriesApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';

const emptyForm = { name: '', parent_id: '' };

export default function Categories() {
  const toast = useToast();
  const dialog = useDialog();
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...} = edit
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const { data: categories, isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list().then((r) => r.data.data),
  });

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

  async function handleDelete(c) {
    if (!(await dialog.confirm({ message: `Delete "${c.name}"? This only works if no active products use it.`, danger: true }))) return;
    try {
      await categoriesApi.remove(c.id);
      queryClient.invalidateQueries({ queryKey: ['categories'] });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not delete category.'));
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
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3 text-text-muted">{c.parent_id ? nameById.get(c.parent_id) : '—'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => openEdit(c)} className="text-xs text-text-muted hover:text-text mr-3">Edit</button>
                  <button onClick={() => handleDelete(c)} className="text-xs text-danger hover:opacity-70">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <form
            onSubmit={handleSave}
            onClick={(e) => e.stopPropagation()}
            className="bg-surface rounded-xl p-6 w-full max-w-sm max-h-full overflow-y-auto"
          >
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
            <select
              value={form.parent_id}
              onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5"
            >
              <option value="">None — top level</option>
              {categories?.filter((c) => c.id !== editing.id).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            <div className="flex gap-2">
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
    </div>
  );
}
