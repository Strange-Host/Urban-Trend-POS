import { useState } from 'react';
import StatCard from '../components/StatCard';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { expensesApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';
import Pager, { usePager } from '../components/Pager';

const emptyForm = { category_id: '', amount: '', description: '', expense_date: new Date().toISOString().slice(0, 10) };

export default function Expenses() {
  const toast = useToast();
  const dialog = useDialog();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const { data: categories } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expensesApi.listCategories().then((r) => r.data.data),
  });

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['expenses', 'list', { page: pager.page, size: pager.pageSize }],
    queryFn: () => expensesApi.list(pager.params).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const expenses = data?.data || [];

  const { data: summary } = useQuery({
    queryKey: ['expenses', 'summary'],
    queryFn: () => expensesApi.summary().then((r) => r.data.data),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['expenses'] });
  }

  function openNew() {
    setForm({ ...emptyForm, category_id: categories?.[0]?.id || '' });
    setError('');
    setEditing({});
  }

  function openEdit(e) {
    setForm({ category_id: e.category_id, amount: (e.amount / 100).toString(), description: e.description || '', expense_date: e.expense_date });
    setError('');
    setEditing(e);
  }

  async function handleSave(ev) {
    ev.preventDefault();
    setError('');
    const payload = {
      category_id: Number(form.category_id),
      amount: Math.round(Number(form.amount) * 100),
      description: form.description || undefined,
      expense_date: form.expense_date,
    };
    try {
      if (editing.id) await expensesApi.update(editing.id, payload);
      else await expensesApi.create(payload);
      invalidate();
      setEditing(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save expense.'));
    }
  }

  async function handleDelete(e) {
    if (!(await dialog.confirm({ message: 'Delete this expense record?', danger: true }))) return;
    try {
      await expensesApi.remove(e.id);
      invalidate();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not delete expense.'));
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Expenses</h1>
          <p className="text-text-muted text-sm mt-1">Rent, utilities, supplies, wages, and other outgoings.</p>
        </div>
        <button onClick={openNew}
          className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap">
          + Record expense
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <StatCard label="Total (all time)" value={summary ? `KES ${(summary.grand_total / 100).toFixed(0)}` : '—'} />
        {summary?.by_category?.slice(0, 5).map((c) => (
          <StatCard key={c.category_id} label={c.category_name} value={`KES ${(c.total / 100).toFixed(0)}`} />
        ))}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[560px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium text-right">Amount</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {!isLoading && expenses.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No expenses recorded yet.</td></tr>
            )}
            {expenses.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">{e.expense_date}</td>
                <td className="px-4 py-3 whitespace-nowrap">{e.category_name}</td>
                <td className="px-4 py-3 text-text-muted">{e.description || '—'}</td>
                <td className="px-4 py-3 text-right font-mono">{(e.amount / 100).toFixed(2)}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => openEdit(e)} className="text-xs text-text-muted hover:text-text mr-3">Edit</button>
                  <button onClick={() => handleDelete(e)} className="text-xs text-danger hover:opacity-70">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="expenses" />

      {editing !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <form onSubmit={handleSave} onClick={(e) => e.stopPropagation()}
            className="bg-surface rounded-xl p-6 w-full max-w-sm max-h-[85vh] overflow-y-auto">
            <h2 className="font-display font-700 text-lg mb-4">{editing.id ? 'Edit expense' : 'Record expense'}</h2>
            {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

            <label className="block text-xs font-medium text-text-muted mb-1">Category</label>
            <select required value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3">
              {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            <label className="block text-xs font-medium text-text-muted mb-1">Amount (KES)</label>
            <input required type="number" step="0.01" min="0" value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Date</label>
            <input required type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Description (optional)</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5" />

            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
