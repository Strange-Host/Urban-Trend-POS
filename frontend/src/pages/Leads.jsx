import { useState } from 'react';
import PageHeader from '../components/shell/PageHeader';
import StatCard from '../components/StatCard';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { leadsApi, staffApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast, useDialog } from '../context/UIContext';
import { createLeadWithConfirm } from '../utils/createLeadConfirm';
import Pager, { usePager } from '../components/Pager';
import { fetchAll } from '../api/fetchAll';
import Sheet from '../components/Sheet';
import ConvertLeadSheet from '../components/ConvertLeadSheet';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyRow } from '../components/EmptyState';
import NewLeadSheet from './leads/NewLeadSheet';
import LeadDetailSheet from './leads/LeadDetailSheet';
import { emptyForm, STATUS_LABELS, STATUS_COLORS } from './leads/constants';

export default function Leads() {
  const toast = useToast();
  const dialog = useDialog();
  const { hasRole } = useAuth();
  const canAssign = hasRole('admin', 'manager');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [converting, setConverting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', phone: '', email: '', notes: '' });
  const [editError, setEditError] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [activityForm, setActivityForm] = useState({ type: 'call', content: '' });
  const queryClient = useQueryClient();

  const pager = usePager(25);
  const { data: stats } = useQuery({ queryKey: ['leads', 'stats'], queryFn: () => leadsApi.stats().then((r) => r.data.data) });
  const { data, isLoading } = useQuery({
    queryKey: ['leads', { statusFilter, search, page: pager.page, size: pager.pageSize }],
    queryFn: () => leadsApi.list({ ...pager.params, status: statusFilter || undefined, search: search || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const leads = data?.data || [];

  const { data: staffList } = useQuery({
    queryKey: ['staff', 'for-assign'],
    queryFn: () => fetchAll(staffApi.list, { status: 'active' }),
    enabled: canAssign,
  });

  const { data: selectedLead } = useQuery({
    queryKey: ['leads', selectedId],
    queryFn: () => leadsApi.getById(selectedId).then((r) => r.data.data),
    enabled: !!selectedId,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['leads'] });
  }

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    try {
      const lead = await createLeadWithConfirm({
        create: leadsApi.create, confirm: dialog.confirm,
        payload: { ...form, assigned_staff_id: form.assigned_staff_id || undefined },
      });
      if (!lead) return; // they decided it was a duplicate - leave the form as it is
      invalidate();
      setCreating(false);
      setForm(emptyForm);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not create lead.'));
    }
  }

  function openEdit() {
    setEditForm({
      name: selectedLead.name || '', phone: selectedLead.phone || '', email: selectedLead.email || '', notes: selectedLead.notes || '',
    });
    setEditError('');
    setEditing(true);
  }

  async function handleEdit(e) {
    e.preventDefault();
    setEditError('');
    try {
      await leadsApi.update(selectedId, {
        name: editForm.name.trim(), phone: editForm.phone.trim(), email: editForm.email.trim() || undefined, notes: editForm.notes,
      });
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['leads', selectedId] });
      setEditing(false);
      toast.success('Lead updated.');
    } catch (err) {
      setEditError(getErrorMessage(err, 'Could not update the lead.'));
    }
  }

  async function handleDelete() {
    if (!(await dialog.confirm({
      title: `Delete ${selectedLead.name}?`,
      message: 'The lead disappears from the list. Orders already made from it are not affected.',
      danger: true, confirmLabel: 'Delete',
    }))) return;
    try {
      await leadsApi.remove(selectedId);
      invalidate();
      setSelectedId(null);
      toast.success('Lead deleted.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not delete the lead.'));
    }
  }

  async function handleStatusChange(status) {
    try {
      await leadsApi.changeStatus(selectedId, status, status === 'rescheduled' ? followUpDate : undefined);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['leads', selectedId] });
      setFollowUpDate('');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not update status.'));
    }
  }

  async function handleAddActivity(e) {
    e.preventDefault();
    if (!activityForm.content) return;
    try {
      await leadsApi.addActivity(selectedId, activityForm);
      queryClient.invalidateQueries({ queryKey: ['leads', selectedId] });
      setActivityForm({ type: 'call', content: '' });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not add activity.'));
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <PageHeader
        title="Leads"
        description="CRM pipeline for WhatsApp, walk-in, and referral leads."
        actions={(
          <button onClick={() => { setForm(emptyForm); setError(''); setCreating(true); }}
            className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft transition-colors whitespace-nowrap">
            + New lead
          </button>
        )}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatCard label="Total" value={stats?.total ?? '—'} />
        <StatCard label="New" value={stats?.new ?? '—'} />
        <StatCard label="Contacted" value={stats?.contacted ?? '—'} />
        <StatCard label="Converted" value={stats?.converted ?? '—'} />
        <StatCard label="Lost" value={stats?.cancelled ?? '—'} />
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input value={search} onChange={(e) => { setSearch(e.target.value); pager.reset(); }} placeholder="Search name or phone…"
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm" />
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); pager.reset(); }}
          className="px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Assigned to</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows cols={5} />}
            {!isLoading && leads.length === 0 && (
              <EmptyRow colSpan={5}>No leads found.</EmptyRow>
            )}
            {leads.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-medium whitespace-nowrap">
                  <div>{l.name}</div>
                  <div className="text-xs text-text-muted">{l.phone}</div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="capitalize">{l.source.replace('_', ' ')}</div>
                  {l.form_name && <div className="text-xs text-text-muted max-w-[200px] truncate">{l.form_name}</div>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{l.assigned_staff_name || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-full ${STATUS_COLORS[l.status]}`}>{STATUS_LABELS[l.status]}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setSelectedId(l.id)} className="text-xs text-text-muted hover:text-text">Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="leads" />

      {creating && (
        <NewLeadSheet form={form} setForm={setForm} error={error} canAssign={canAssign} staffList={staffList} onClose={() => setCreating(false)} onSubmit={handleCreate} />
      )}

      {selectedId && selectedLead && (
        <LeadDetailSheet
          lead={selectedLead} canAssign={canAssign}
          followUpDate={followUpDate} setFollowUpDate={setFollowUpDate}
          activityForm={activityForm} setActivityForm={setActivityForm}
          onClose={() => setSelectedId(null)} onStatusChange={handleStatusChange} onConvert={() => setConverting(true)}
          onAddActivity={handleAddActivity} onEdit={openEdit} onDelete={handleDelete}
        />
      )}

      {editing && selectedLead && (
        <Sheet onClose={() => setEditing(false)} size="sm" as="form" onSubmit={handleEdit}>
          <h2 className="font-display font-700 text-lg mb-4">Edit lead</h2>
          {editError && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{editError}</div>}
          <label htmlFor="lead-edit-name" className="block text-xs font-medium text-text-muted mb-1">Name</label>
          <input id="lead-edit-name" required value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />
          <label htmlFor="lead-edit-phone" className="block text-xs font-medium text-text-muted mb-1">Phone</label>
          <input id="lead-edit-phone" required value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />
          <label htmlFor="lead-edit-email" className="block text-xs font-medium text-text-muted mb-1">Email (optional)</label>
          <input id="lead-edit-email" type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />
          <label htmlFor="lead-edit-notes" className="block text-xs font-medium text-text-muted mb-1">Notes (optional)</label>
          <textarea id="lead-edit-notes" rows={3} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5" />
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Save</button>
          </div>
        </Sheet>
      )}

      {converting && selectedLead && (
        <ConvertLeadSheet
          lead={selectedLead}
          onClose={() => setConverting(false)}
          onConverted={() => queryClient.invalidateQueries({ queryKey: ['leads', selectedId] })}
        />
      )}
    </div>
  );
}
