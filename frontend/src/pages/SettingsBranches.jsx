import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storesApi, suppliersApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast } from '../context/UIContext';
import { StatusPill } from '../components/DataUI';
import { SectionCard, Field, inputCls } from '../components/SettingsUI';
import Sheet from '../components/Sheet';

const errCls = 'mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm';
const primaryBtn = 'flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50';
const cancelBtn = 'flex-1 py-2.5 rounded-lg border border-line text-sm font-medium';

function ActiveToggle({ checked, onChange, disabled, hint }) {
  return (
    <label className="flex items-start gap-3 mb-4 cursor-pointer">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
      <span className="text-sm">Active{hint && <span className="block text-xs text-text-muted">{hint}</span>}</span>
    </label>
  );
}

/* --------------------------------- Branches -------------------------------- */

function BranchSheet({ branch, onClose }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = !!branch;
  const [form, setForm] = useState({ name: branch?.name || '', address: branch?.address || '', is_active: branch ? !!branch.is_active : true });
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (body) => (editing ? storesApi.update(branch.id, body) : storesApi.create(body)),
    onSuccess: () => {
      toast.success(editing ? 'Branch updated.' : 'Branch added.');
      // Branch pickers all over the app read ['stores'].
      queryClient.invalidateQueries({ queryKey: ['stores'] });
      onClose();
    },
    onError: (err) => setError(getErrorMessage(err, 'Could not save the branch.')),
  });

  function submit(e) {
    e.preventDefault();
    setError('');
    const name = form.name.trim();
    if (!name) { setError('Enter a branch name.'); return; }
    const body = { name, address: form.address.trim() };
    if (editing) body.is_active = form.is_active;   // a new branch is always created active
    save.mutate(body);
  }

  return (
    <Sheet onClose={onClose} size="sm" as="form" onSubmit={submit} label={editing ? 'Edit branch' : 'Add branch'}>
      <h2 className="font-display font-700 text-lg mb-4">{editing ? 'Edit branch' : 'Add branch'}</h2>
      {error && <div className={errCls}>{error}</div>}
      <Field label="Name"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
      <Field label="Address (optional)"><input className={inputCls} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
      {editing && (
        <ActiveToggle
          checked={form.is_active}
          disabled={!!branch.is_main}
          onChange={(v) => setForm({ ...form, is_active: v })}
          hint={branch.is_main ? 'The main store cannot be switched off.' : 'Switch off a branch you no longer trade from. Its history is kept.'}
        />
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} className={cancelBtn}>Cancel</button>
        <button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add branch'}</button>
      </div>
    </Sheet>
  );
}

export function BranchesSection() {
  const [sheet, setSheet] = useState(null);   // null | 'new' | branch
  const { data: stores = [], isLoading, error } = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list().then((r) => r.data.data) });

  return (
    <SectionCard title="Branches" description="Your main store and outlets. Switch a branch off instead of deleting it, so its sales and stock history stay intact.">
      {error && <div className={errCls}>{getErrorMessage(error, 'Could not load branches.')}</div>}
      {isLoading && <div className="text-text-muted text-sm">Loading…</div>}
      {stores.map((s) => (
        <div key={s.id} className="flex items-center gap-3 py-3 border-t border-line first:border-t-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{s.name}</div>
            {s.address && <div className="text-xs text-text-muted truncate">{s.address}</div>}
          </div>
          {s.is_main ? <StatusPill tone="accent">Main</StatusPill> : null}
          {!s.is_active && <StatusPill tone="neutral">Off</StatusPill>}
          <button type="button" onClick={() => setSheet(s)} aria-label={`Edit ${s.name}`} className="text-xs font-medium text-text hover:opacity-70">Edit</button>
        </div>
      ))}
      <button type="button" onClick={() => setSheet('new')} className="mt-3 px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted">+ Add branch</button>
      {sheet && <BranchSheet branch={sheet === 'new' ? null : sheet} onClose={() => setSheet(null)} />}
    </SectionCard>
  );
}

/* -------------------------------- Suppliers -------------------------------- */

function SupplierSheet({ supplier, onClose }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = !!supplier;
  const [form, setForm] = useState({
    name: supplier?.name || '', phone: supplier?.phone || '', email: supplier?.email || '',
    address: supplier?.address || '', note: supplier?.note || '', is_active: supplier ? !!supplier.is_active : true,
  });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = useMutation({
    mutationFn: (body) => (editing ? suppliersApi.update(supplier.id, body) : suppliersApi.create(body)),
    onSuccess: () => {
      toast.success(editing ? 'Supplier updated.' : 'Supplier added.');
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      onClose();
    },
    onError: (err) => setError(getErrorMessage(err, 'Could not save the supplier.')),
  });

  function submit(e) {
    e.preventDefault();
    setError('');
    const name = form.name.trim();
    if (!name) { setError('Enter a supplier name.'); return; }
    const body = { name, phone: form.phone.trim(), email: form.email.trim(), address: form.address.trim(), note: form.note.trim() };
    if (editing) body.is_active = form.is_active;
    save.mutate(body);
  }

  return (
    <Sheet onClose={onClose} size="sm" as="form" onSubmit={submit} label={editing ? 'Edit supplier' : 'Add supplier'}>
      <h2 className="font-display font-700 text-lg mb-4">{editing ? 'Edit supplier' : 'Add supplier'}</h2>
      {error && <div className={errCls}>{error}</div>}
      <Field label="Name"><input className={inputCls} value={form.name} onChange={set('name')} autoFocus /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Phone"><input className={inputCls} value={form.phone} onChange={set('phone')} inputMode="tel" /></Field>
        <Field label="Email"><input className={inputCls} value={form.email} onChange={set('email')} type="email" /></Field>
      </div>
      <Field label="Address"><input className={inputCls} value={form.address} onChange={set('address')} /></Field>
      <Field label="Note"><textarea className={inputCls} rows={2} value={form.note} onChange={set('note')} /></Field>
      {editing && <ActiveToggle checked={form.is_active} onChange={(v) => setForm({ ...form, is_active: v })} hint="A switched-off supplier no longer appears when receiving stock." />}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} className={cancelBtn}>Cancel</button>
        <button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add supplier'}</button>
      </div>
    </Sheet>
  );
}

export function SuppliersSection() {
  const [sheet, setSheet] = useState(null);
  // Includes switched-off suppliers so they can be switched back on. Key sits under ['suppliers'] so every save refreshes both lists.
  const { data: suppliers = [], isLoading, error } = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => suppliersApi.list({ include_inactive: 1 }).then((r) => r.data.data),
  });

  return (
    <SectionCard title="Suppliers" description="Who you buy stock from. Correct a name or contact here; switch one off to hide it from the receiving screen.">
      {error && <div className={errCls}>{getErrorMessage(error, 'Could not load suppliers.')}</div>}
      {isLoading && <div className="text-text-muted text-sm">Loading…</div>}
      {!isLoading && !error && suppliers.length === 0 && <div className="text-text-muted text-sm mb-1">No suppliers yet.</div>}
      {suppliers.map((s) => (
        <div key={s.id} className="flex items-center gap-3 py-3 border-t border-line first:border-t-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{s.name}</div>
            {(s.phone || s.email) && <div className="text-xs text-text-muted truncate">{[s.phone, s.email].filter(Boolean).join(' · ')}</div>}
          </div>
          {!s.is_active && <StatusPill tone="neutral">Off</StatusPill>}
          <button type="button" onClick={() => setSheet(s)} aria-label={`Edit ${s.name}`} className="text-xs font-medium text-text hover:opacity-70">Edit</button>
        </div>
      ))}
      <button type="button" onClick={() => setSheet('new')} className="mt-3 px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted">+ Add supplier</button>
      {sheet && <SupplierSheet supplier={sheet === 'new' ? null : sheet} onClose={() => setSheet(null)} />}
    </SectionCard>
  );
}
