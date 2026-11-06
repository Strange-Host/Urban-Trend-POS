import Sheet from '../../components/Sheet';
import { SOURCES } from './constants';

/** The "New lead" form sheet. The page owns the form state and the create call. */
export default function NewLeadSheet({ form, setForm, error, canAssign, staffList, onClose, onSubmit }) {
  return (
      <Sheet onClose={() => onClose()} size="sm" as="form" onSubmit={onSubmit}>
          <h2 className="font-display font-700 text-lg mb-4">New lead</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

          <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
          <input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

          <label className="block text-xs font-medium text-text-muted mb-1">Phone</label>
          <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="0712345678"
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

          <label className="block text-xs font-medium text-text-muted mb-1">Email (optional)</label>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3" />

          <label className="block text-xs font-medium text-text-muted mb-1">Source</label>
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3">
            {SOURCES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>

          {canAssign && (
            <>
              <label className="block text-xs font-medium text-text-muted mb-1">Assign to (optional)</label>
              <select value={form.assigned_staff_id} onChange={(e) => setForm({ ...form, assigned_staff_id: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-3">
                <option value="">Unassigned</option>
                {staffList?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </>
          )}

          <label className="block text-xs font-medium text-text-muted mb-1">Notes (optional)</label>
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none focus:border-accent mb-5" />

          <div className="flex gap-2">
            <button type="button" onClick={() => onClose()} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">Create</button>
          </div>
        </Sheet>
  );
}
