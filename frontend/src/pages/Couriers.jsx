import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { couriersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast, useDialog } from '../context/UIContext';
import { StatusPill } from '../components/DataUI';

const empty = { name: '', phone: '', vehicle: '', courier_type: 'boda', notes: '' };
const money = (c) => `KES ${((c || 0) / 100).toLocaleString('en-KE')}`;
const inputCls = 'w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm';

// Named riders/agents, so "who has the unpaid parcels?" has a real answer
// instead of just "boda" or "G4S". Past orders keep pointing at the courier
// who carried them, so couriers are deactivated, never deleted.
export default function Couriers() {
  const { can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const manage = can('couriers.manage');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: couriers = [], isLoading } = useQuery({
    queryKey: ['couriers', 'all'],
    queryFn: () => couriersApi.list({ all: 1 }).then((r) => r.data.data),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['couriers'] });

  function openNew() { setForm(empty); setError(''); setEditing({}); }
  function openEdit(c) {
    setForm({ name: c.name, phone: c.phone || '', vehicle: c.vehicle || '', courier_type: c.courier_type, notes: c.notes || '' });
    setError('');
    setEditing(c);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { name: form.name.trim(), phone: form.phone.trim() || null, vehicle: form.vehicle.trim() || null, courier_type: form.courier_type, notes: form.notes.trim() || null };
      if (editing.id) await couriersApi.update(editing.id, payload);
      else await couriersApi.create(payload);
      refresh();
      setEditing(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save the courier.'));
    } finally {
      setSaving(false);
    }
  }

  async function setActive(c, active) {
    if (!active && !(await dialog.confirm({ title: `Deactivate ${c.name}?`, message: 'They stop appearing in the courier picker. Past orders keep their name.', danger: true, confirmLabel: 'Deactivate' }))) return;
    try {
      await couriersApi.update(c.id, { is_active: active });
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not update the courier.'));
    }
  }

  const owed = couriers.filter((c) => c.is_active).reduce((n, c) => n + c.unpaid_amount, 0);

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Couriers</h1>
          <p className="text-text-muted text-sm mt-1">
            {couriers.filter((c) => c.is_active).length} active · {money(owed)} currently with couriers, not yet paid
          </p>
        </div>
        {manage && <button onClick={openNew} className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft whitespace-nowrap">+ Add courier</button>}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Courier</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium text-right">Unpaid parcels</th>
              <th className="px-4 py-3 font-medium text-right">Owed</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {!isLoading && couriers.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-text-muted">No couriers yet. Add your riders and agents so unpaid parcels can be traced to a person.</td></tr>}
            {couriers.map((c) => (
              <tr key={c.id} className={`border-b border-line last:border-0 ${c.is_active ? '' : 'opacity-60'}`}>
                <td className="px-4 py-3">
                  <div className="font-medium">{c.name} {!c.is_active && <StatusPill tone="neutral">inactive</StatusPill>}</div>
                  <div className="text-xs text-text-muted">{[c.phone, c.vehicle].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="px-4 py-3">{c.courier_type === 'g4s' ? 'G4S' : 'Boda'}</td>
                <td className="px-4 py-3 text-right font-mono">{c.unpaid_parcels}</td>
                <td className="px-4 py-3 text-right font-mono">{money(c.unpaid_amount)}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {manage && (
                    <>
                      <button onClick={() => openEdit(c)} className="text-xs text-text-muted hover:text-text mr-3">Edit</button>
                      {c.is_active
                        ? <button onClick={() => setActive(c, false)} className="text-xs text-danger hover:opacity-70">Deactivate</button>
                        : <button onClick={() => setActive(c, true)} className="text-xs text-text-muted hover:text-text">Reactivate</button>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="bg-surface rounded-xl p-6 w-full max-w-sm">
            <h2 className="font-display font-700 text-lg mb-4">{editing.id ? 'Edit courier' : 'New courier'}</h2>
            {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
            <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
            <input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inputCls} mb-3`} />
            <label className="block text-xs font-medium text-text-muted mb-1">Phone</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0712345678" className={`${inputCls} mb-3`} />
            <label className="block text-xs font-medium text-text-muted mb-1">Vehicle / plate (optional)</label>
            <input value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} className={`${inputCls} mb-3`} />
            <label className="block text-xs font-medium text-text-muted mb-1">Type</label>
            <select value={form.courier_type} onChange={(e) => setForm({ ...form, courier_type: e.target.value })} className={`${inputCls} mb-3`}>
              <option value="boda">Boda</option>
              <option value="g4s">G4S</option>
            </select>
            <label className="block text-xs font-medium text-text-muted mb-1">Notes (optional)</label>
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={`${inputCls} mb-5`} />
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
