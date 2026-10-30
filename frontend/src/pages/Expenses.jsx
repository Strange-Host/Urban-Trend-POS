import { useState } from 'react';
import StatCard from '../components/StatCard';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { expensesApi, pettyCashApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';
import { useAuth } from '../context/AuthContext';
import Pager, { usePager } from '../components/Pager';

import Sheet from '../components/Sheet';
import Picker, { Segmented } from '../components/Picker';

const today = () => new Date().toISOString().slice(0, 10);
const emptyForm = { category_id: '', amount: '', description: '', expense_date: today(), paid_from: 'main' };
const kes = (cents) => `KES ${(cents / 100).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;

const STATUS_STYLE = {
  pending: 'bg-accent text-accent-ink',
  approved: 'bg-success-soft text-success',
  rejected: 'bg-danger-soft text-danger',
};
const STATUS_LABEL = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected' };

function StatusBadge({ status }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[status] || ''}`}>{STATUS_LABEL[status] || status}</span>;
}

export default function Expenses() {
  const toast = useToast();
  const dialog = useDialog();
  const { user, can } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canManage = can('expenses.manage');
  const canApprove = can('expenses.approve');

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [topup, setTopup] = useState(null); // null = closed
  const [topupError, setTopupError] = useState('');
  const queryClient = useQueryClient();

  const { data: categories } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expensesApi.listCategories().then((r) => r.data.data),
  });

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['expenses', 'list', { page: pager.page, size: pager.pageSize, statusFilter }],
    queryFn: () => expensesApi.list({ ...pager.params, status: statusFilter || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const expenses = data?.data || [];

  const { data: summary } = useQuery({
    queryKey: ['expenses', 'summary'],
    queryFn: () => expensesApi.summary().then((r) => r.data.data),
  });

  const { data: petty } = useQuery({
    queryKey: ['expenses', 'petty-cash'],
    queryFn: () => pettyCashApi.overview().then((r) => r.data.data),
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
    setForm({
      category_id: e.category_id, amount: (e.amount / 100).toString(), description: e.description || '',
      expense_date: e.expense_date, paid_from: e.paid_from || 'main',
    });
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
      paid_from: form.paid_from,
    };
    try {
      if (editing.id) await expensesApi.update(editing.id, payload);
      else await expensesApi.create(payload);
      invalidate();
      setEditing(null);
      if (!isAdmin) toast.info('Saved. It counts once someone else approves it.');
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

  async function handleApprove(e) {
    try {
      await expensesApi.approve(e.id);
      invalidate();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not approve expense.'));
    }
  }

  async function handleReject(e) {
    const note = await dialog.prompt({ message: 'Why is this expense being rejected? The person who recorded it will see this.', required: true, confirmLabel: 'Reject' });
    if (!note) return;
    try {
      await expensesApi.reject(e.id, note);
      invalidate();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not reject expense.'));
    }
  }

  async function handleTopup(ev) {
    ev.preventDefault();
    setTopupError('');
    try {
      await pettyCashApi.createTopup({
        amount: Math.round(Number(topup.amount) * 100),
        note: topup.note || undefined,
        topup_date: topup.topup_date,
      });
      invalidate();
      setTopup(null);
      if (!isAdmin) toast.info('Top-up recorded. It counts once someone else approves it.');
    } catch (err) {
      setTopupError(getErrorMessage(err, 'Could not record top-up.'));
    }
  }

  async function decideTopup(t, approve) {
    try {
      if (approve) {
        await pettyCashApi.approveTopup(t.id);
      } else {
        const note = await dialog.prompt({ message: 'Why is this top-up being rejected?', required: true, confirmLabel: 'Reject' });
        if (!note) return;
        await pettyCashApi.rejectTopup(t.id, note);
      }
      invalidate();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not update top-up.'));
    }
  }

  // Nobody approves their own entry (admins are the exception, and their own entries are approved on the spot anyway).
  const canDecide = (rec) => canApprove && rec.status === 'pending' && (isAdmin || rec.recorded_by_staff_id !== user?.id);
  const pendingTopups = (petty?.topups || []).filter((t) => t.status === 'pending');

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Expenses</h1>
          <p className="text-text-muted text-sm mt-1">Rent, utilities, supplies, wages, and other outgoings. An expense counts once it is approved.</p>
        </div>
        {canManage && (
          <button onClick={openNew}
            className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap">
            + Record expense
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <StatCard label="Approved (all time)" value={summary ? kes(summary.grand_total) : '—'} />
        {summary?.pending_count > 0 && (
          <StatCard label={`Waiting for approval (${summary.pending_count})`} value={kes(summary.pending_total)} />
        )}
        {summary?.by_category?.slice(0, 5).map((c) => (
          <StatCard key={c.category_id} label={c.category_name} value={kes(c.total)} />
        ))}
      </div>

      {petty && (
        <div className="mb-6 bg-surface border border-line rounded-xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display font-700 text-sm">Petty cash</h2>
              <p className="text-xs text-text-muted mt-0.5">Cash kept at the shop for small spends. Choose "Petty cash" when recording an expense paid from it.</p>
            </div>
            {canManage && (
              <button onClick={() => { setTopup({ amount: '', note: '', topup_date: today() }); setTopupError(''); }}
                className="px-3 py-2 rounded-lg border border-line text-sm font-medium hover:bg-paper whitespace-nowrap">+ Top up</button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
            <div><div className="text-xs text-text-muted">In the float</div><div className="font-mono font-medium">{kes(petty.balance)}</div></div>
            <div><div className="text-xs text-text-muted">Free to spend</div><div className={`font-mono font-medium ${petty.available < 0 ? 'text-danger' : ''}`}>{kes(petty.available)}</div></div>
            <div><div className="text-xs text-text-muted">Spent so far</div><div className="font-mono font-medium">{kes(petty.spent)}</div></div>
          </div>
          {pendingTopups.length > 0 && (
            <ul className="mt-3 border-t border-line pt-3 space-y-2">
              {pendingTopups.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span><StatusBadge status="pending" /> <span className="font-mono ml-1">{kes(t.amount)}</span> top-up by {t.recorded_by_name}{t.note ? ` — ${t.note}` : ''}</span>
                  {canApprove && (isAdmin || t.recorded_by_staff_id !== user?.id) && (
                    <span className="whitespace-nowrap">
                      <button onClick={() => decideTopup(t, true)} className="text-xs font-medium text-success hover:opacity-70 mr-3">Approve</button>
                      <button onClick={() => decideTopup(t, false)} className="text-xs text-danger hover:opacity-70">Reject</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Segmented
        value={statusFilter} aria-label="Filter by approval status" className="mb-4 max-w-md"
        onChange={(v) => { setStatusFilter(v); pager.reset(); }}
        options={[{ value: '', label: 'All' }, { value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]}
      />

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[680px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Amount</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {!isLoading && expenses.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">{statusFilter ? 'Nothing here.' : 'No expenses recorded yet.'}</td></tr>
            )}
            {expenses.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">{e.expense_date}</td>
                <td className="px-4 py-3 whitespace-nowrap">{e.category_name}</td>
                <td className="px-4 py-3 text-text-muted">
                  {e.description || '—'}
                  {e.paid_from === 'petty_cash' && <span className="ml-2 px-1.5 py-0.5 rounded bg-paper border border-line text-xs">petty cash</span>}
                  <div className="text-xs mt-0.5">by {e.recorded_by_name}</div>
                  {e.status === 'rejected' && e.review_note && <div className="text-xs text-danger mt-0.5">Rejected: {e.review_note}</div>}
                  {e.status === 'approved' && e.reviewed_by_name && e.reviewed_by_staff_id !== e.recorded_by_staff_id && (
                    <div className="text-xs mt-0.5">approved by {e.reviewed_by_name}</div>
                  )}
                </td>
                <td className="px-4 py-3"><StatusBadge status={e.status} /></td>
                <td className="px-4 py-3 text-right font-mono">{(e.amount / 100).toFixed(2)}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {canDecide(e) && (
                    <>
                      <button onClick={() => handleApprove(e)} className="text-xs font-medium text-success hover:opacity-70 mr-3">Approve</button>
                      <button onClick={() => handleReject(e)} className="text-xs text-danger hover:opacity-70 mr-3">Reject</button>
                    </>
                  )}
                  {canManage && <button onClick={() => openEdit(e)} className="text-xs text-text-muted hover:text-text mr-3">Edit</button>}
                  {canManage && (e.status !== 'approved' || isAdmin) && (
                    <button onClick={() => handleDelete(e)} className="text-xs text-danger hover:opacity-70">Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="expenses" />

      {editing !== null && (
        <Sheet onClose={() => setEditing(null)} size="sm" as="form" onSubmit={handleSave}>
            <h2 className="font-display font-700 text-lg mb-4">{editing.id ? 'Edit expense' : 'Record expense'}</h2>
            {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
            {editing.id && !isAdmin && editing.status !== 'pending' && (
              <p className="mb-3 px-3 py-2 rounded-lg bg-paper border border-line text-xs text-text-muted">
                Saving changes sends this expense back for approval.
              </p>
            )}

            <label className="block text-xs font-medium text-text-muted mb-1">Category</label>
            <Picker
              value={form.category_id} title="Expense category" aria-label="Expense category" className="mb-3"
              onChange={(v) => setForm({ ...form, category_id: v })}
              options={(categories || []).map((c) => ({ value: c.id, label: c.name }))}
            />

            <label className="block text-xs font-medium text-text-muted mb-1">Amount (KES)</label>
            <input required type="number" step="0.01" min="0" value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Paid from</label>
            <Segmented
              value={form.paid_from} aria-label="Paid from" className="mb-1"
              onChange={(v) => setForm({ ...form, paid_from: v })}
              options={[{ value: 'main', label: 'Main funds' }, { value: 'petty_cash', label: 'Petty cash' }]}
            />
            {form.paid_from === 'petty_cash' && petty && (
              <p className="text-xs text-text-muted mb-3">{kes(petty.available)} free to spend from the float.</p>
            )}
            {form.paid_from !== 'petty_cash' && <div className="mb-3" />}

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
          </Sheet>
      )}

      {topup !== null && (
        <Sheet onClose={() => setTopup(null)} size="sm" as="form" onSubmit={handleTopup}>
            <h2 className="font-display font-700 text-lg mb-4">Top up petty cash</h2>
            {topupError && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{topupError}</div>}

            <label className="block text-xs font-medium text-text-muted mb-1">Amount (KES)</label>
            <input required type="number" step="0.01" min="0.01" value={topup.amount}
              onChange={(e) => setTopup({ ...topup, amount: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Date</label>
            <input required type="date" value={topup.topup_date} onChange={(e) => setTopup({ ...topup, topup_date: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Note (optional)</label>
            <input value={topup.note} onChange={(e) => setTopup({ ...topup, note: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5" />

            <div className="flex gap-2">
              <button type="button" onClick={() => setTopup(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Record top-up</button>
            </div>
          </Sheet>
      )}
    </div>
  );
}
