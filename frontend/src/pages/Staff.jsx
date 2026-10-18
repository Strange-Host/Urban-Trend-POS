import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { staffApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast, useDialog } from '../context/UIContext';
import StaffAccessModal from '../components/StaffAccessModal';
import useModules from '../hooks/useModules';
import Pager, { usePager } from '../components/Pager';
import { Segmented } from '../components/Picker';
import RemoveAccountSheet from '../components/RemoveAccountSheet';
import { passwordHint } from '../utils/passwordRules';

import Sheet from '../components/Sheet';
const emptyForm = { name: '', phone: '', email: '', password: '', pin: '', role: 'cashier' };
const ROLES = ['admin', 'manager', 'cashier'];

export default function Staff() {
  const toast = useToast();
  const dialog = useDialog();
  const { user: currentUser } = useAuth();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');   // active | inactive | all
  const [actionsFor, setActionsFor] = useState(null);           // the "more actions" sheet
  const [removing, setRemoving] = useState(null);               // the "remove this account" sheet
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [tempPassword, setTempPassword] = useState(null);
  const [accessFor, setAccessFor] = useState(null);
  const modules = useModules();
  const queryClient = useQueryClient();

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['staff', { search, roleFilter, statusFilter, page: pager.page, size: pager.pageSize }],
    queryFn: () => staffApi.list({ ...pager.params, search: search || undefined, role: roleFilter || undefined, status: statusFilter === 'all' ? undefined : statusFilter }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const staff = data?.data || [];

  function openNew() {
    setForm(emptyForm);
    setError('');
    setEditing({});
  }

  function openEdit(s) {
    setForm({ name: s.name, phone: s.phone || '', email: s.email, password: '', pin: '', role: s.role });
    setError('');
    setEditing(s);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    try {
      if (editing.id) {
        const payload = { name: form.name, phone: form.phone, email: form.email, role: form.role };
        if (form.password) payload.password = form.password;
        if (form.pin) payload.pin = form.pin;
        await staffApi.update(editing.id, payload);
      } else {
        await staffApi.create(form);
      }
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      setEditing(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save staff member.'));
    }
  }

  async function handleReactivate(s) {
    try {
      await staffApi.reactivate(s.id);
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      toast.success(`${s.name} can sign in again.`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not reactivate.'));
    }
  }

  async function handleUnlock(s) {
    try {
      await staffApi.unlockAccount(s.id);
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      toast.success(`${s.name}'s account is unlocked.`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not unlock.'));
    }
  }

  async function handleSignOutEverywhere(s) {
    if (!(await dialog.confirm({ message: `Sign ${s.name} out of every device they are using?`, danger: true }))) return;
    try {
      const { data } = await staffApi.signOutEverywhere(s.id);
      toast.success(data.data.ended ? `Signed out of ${data.data.ended} device${data.data.ended === 1 ? '' : 's'}.` : `${s.name} was not signed in anywhere.`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not sign them out.'));
    }
  }

  async function handleResetPassword(s) {
    if (!(await dialog.confirm(`Generate a temporary password for ${s.name}?`))) return;
    try {
      const { data } = await staffApi.resetPassword(s.id);
      setTempPassword({ name: s.name, password: data.data.temporaryPassword });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not reset password.'));
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display font-700 text-2xl">Staff</h1>
          <p className="text-text-muted text-sm mt-1">{staff.length} staff member{staff.length === 1 ? '' : 's'}</p>
        </div>
        <button
          onClick={openNew}
          className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap"
        >
          + Add staff
        </button>
      </div>

      <Segmented
        value={statusFilter} onChange={(v) => { setStatusFilter(v); pager.reset(); }} aria-label="Which accounts to show" className="mb-3 max-w-sm"
        options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]}
      />

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={search} onChange={(e) => { setSearch(e.target.value); pager.reset(); }}
          placeholder="Search name, phone, email…"
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm"
        />
        <select
          value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); pager.reset(); }}
          className="px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm"
        >
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Contact</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {!isLoading && staff.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No staff found.</td></tr>
            )}
            {staff.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-medium whitespace-nowrap">{s.name}</td>
                <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                  <div>{s.email}</div>
                  {s.phone && <div className="text-xs">{s.phone}</div>}
                </td>
                <td className="px-4 py-3 capitalize">{s.role}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-full ${s.status === 'active' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
                    {s.erased ? 'erased' : s.status}
                  </span>
                  {s.locked && <span className="ml-1.5 text-xs px-2 py-1 rounded-full bg-accent/25 text-ink">locked</span>}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <div className="flex gap-2 justify-start sm:justify-end">
                    {!s.erased && s.status === 'inactive' && (
                      <button onClick={() => handleReactivate(s)} className="min-h-[44px] sm:min-h-[36px] px-3 rounded-lg border border-line text-xs font-medium hover:border-text-muted">Reactivate</button>
                    )}
                    {!s.erased && (
                      <button onClick={() => openEdit(s)} className="min-h-[44px] sm:min-h-[36px] px-3 rounded-lg border border-line text-xs font-medium hover:border-text-muted">Edit</button>
                    )}
                    <button onClick={() => setActionsFor(s)} className="min-h-[44px] sm:min-h-[36px] px-3 rounded-lg border border-line text-xs font-medium hover:border-text-muted" aria-label={`More actions for ${s.name}`}>More ▾</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="staff members" />

      {editing !== null && (
        <Sheet onClose={() => setEditing(null)} size="sm" as="form" onSubmit={handleSave}>
            <h2 className="font-display font-700 text-lg mb-4">{editing.id ? 'Edit staff member' : 'New staff member'}</h2>
            {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

            <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
            <input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Phone</label>
            <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="0712345678"
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Email</label>
            <input required type="email" autoCapitalize="none" autoCorrect="off" spellCheck="false" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

            <label className="block text-xs font-medium text-text-muted mb-1">Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3">
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>

            <label className="block text-xs font-medium text-text-muted mb-1">
              {editing.id ? 'New password (leave blank to keep current)' : 'Password'}
            </label>
            <input required={!editing.id} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password" className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-1" />
            <p className="text-xs text-text-muted mb-3">{passwordHint(form.role)}</p>

            <label className="block text-xs font-medium text-text-muted mb-1">
              {editing.id ? 'New register PIN (optional)' : 'Register PIN (optional, 4-6 digits)'}
              {form.role !== 'cashier' && <span className="font-normal"> — only cashiers can use a PIN</span>}
            </label>
            <input value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              inputMode="numeric" autoComplete="off" placeholder="not 1234 or 0000"
              className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5" />

            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(null)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
              <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Save</button>
            </div>
          </Sheet>
      )}

      {actionsFor && (
        <Sheet onClose={() => setActionsFor(null)} size="sm" label={`Actions for ${actionsFor.name}`}>
          <h2 className="font-display font-700 text-lg mb-1">{actionsFor.name}</h2>
          <p className="text-sm text-text-muted mb-3 capitalize">{actionsFor.erased ? 'Erased account' : `${actionsFor.role} · ${actionsFor.status}`}</p>
          <div className="space-y-2 mb-4">
            {(() => {
              const s = actionsFor;
              const act = (label, hint, fn, tone) => (
                <button key={label} type="button" onClick={() => { setActionsFor(null); fn(); }}
                  className={`w-full text-left min-h-[56px] px-4 py-2 rounded-xl border hover:border-text-muted ${tone === 'danger' ? 'border-danger/40' : 'border-line'}`}>
                  <span className={`block text-sm font-medium ${tone === 'danger' ? 'text-danger' : ''}`}>{label}</span>
                  <span className="block text-xs text-text-muted">{hint}</span>
                </button>
              );
              return (
                <>
                  {s.locked && act('Unlock account', 'They were locked out after wrong passwords or PINs.', () => handleUnlock(s))}
                  {!s.erased && s.status === 'active' && modules.control && act('Access & permissions', 'What they can see and do, and sign-in codes.', () => setAccessFor(s))}
                  {!s.erased && s.status === 'active' && act('Reset password', 'Create a temporary password they must change.', () => handleResetPassword(s))}
                  {!s.erased && act('Sign out of all devices', 'Ends every sign-in this person has right now.', () => handleSignOutEverywhere(s))}
                  {!s.erased && s.status === 'inactive' && act('Reactivate', 'Let them sign in again.', () => handleReactivate(s))}
                  {s.id !== currentUser?.id && !(s.erased) && act('Remove account…', 'Deactivate, delete (unused accounts) or erase personal data.', () => setRemoving(s), 'danger')}
                  {s.erased && <p className="text-sm text-text-muted px-1">This account's personal data was erased. Their records are kept as “{s.name}”.</p>}
                </>
              );
            })()}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setActionsFor(null)} className="flex-1 min-h-[44px] rounded-lg border border-line text-sm font-medium">Close</button>
          </div>
        </Sheet>
      )}

      {removing && <RemoveAccountSheet staff={removing} onClose={() => setRemoving(null)} />}

      {accessFor && modules.control && <StaffAccessModal staff={accessFor} isSelf={accessFor.id === currentUser?.id} onClose={() => setAccessFor(null)} />}

      {tempPassword && (
        <Sheet onClose={() => setTempPassword(null)} size="sm">
            <h2 className="font-display font-700 text-lg mb-3">Temporary password</h2>
            <p className="text-sm text-text-muted mb-3">
              Share this with {tempPassword.name} directly — it won't be shown again, and there's no email/SMS delivery in this build.
            </p>
            <div className="font-mono text-lg px-3 py-2 rounded-lg bg-paper border border-line mb-5 text-center select-all">
              {tempPassword.password}
            </div>
            <button onClick={() => setTempPassword(null)} className="w-full py-2.5 rounded-lg bg-ink text-white text-sm font-medium">Done</button>
          </Sheet>
      )}
    </div>
  );
}
