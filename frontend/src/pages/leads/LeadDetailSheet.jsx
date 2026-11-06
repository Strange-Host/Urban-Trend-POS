import Sheet from '../../components/Sheet';
import { NEXT_STATUSES, STATUS_COLORS, STATUS_LABELS } from './constants';

/** The side sheet for the picked lead: contact, status moves, convert, activity log, edit and delete. The page owns the data and handlers. */
export default function LeadDetailSheet({
  lead: selectedLead, canAssign, followUpDate, setFollowUpDate, activityForm, setActivityForm,
  onClose, onStatusChange, onConvert, onAddActivity, onEdit, onDelete,
}) {
  return (
      <Sheet onClose={() => onClose()} size="lg">
          <div className="flex items-start justify-between mb-1">
            <h2 className="font-display font-700 text-lg">{selectedLead.name}</h2>
            <span className={`text-xs px-2 py-1 rounded-full ${STATUS_COLORS[selectedLead.status]}`}>{STATUS_LABELS[selectedLead.status]}</span>
          </div>
          <p className="text-sm text-text-muted mb-3">
            <a href={`tel:${selectedLead.phone}`} className="underline">{selectedLead.phone}</a>
            {selectedLead.email ? ` · ${selectedLead.email}` : ''}
          </p>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-3">
            {(selectedLead.interested_product_name || selectedLead.form_name) && (<>
              <dt className="text-text-muted">Product / form</dt>
              <dd>{selectedLead.interested_product_name || selectedLead.form_name}{selectedLead.interested_product_name && selectedLead.form_name && selectedLead.form_name !== selectedLead.interested_product_name ? ` (${selectedLead.form_name})` : ''}</dd>
            </>)}
            <dt className="text-text-muted">Source</dt>
            <dd className="capitalize">{(selectedLead.source || '').replace('_', ' ')}</dd>
            <dt className="text-text-muted">Assigned to</dt>
            <dd>{selectedLead.assigned_staff_name || 'Unassigned'}</dd>
            <dt className="text-text-muted">Received</dt>
            <dd>{selectedLead.created_at}</dd>
          </dl>

          {selectedLead.notes && (
            <div className="mb-4 rounded-lg bg-paper border border-line px-3 py-2">
              <div className="text-xs font-medium text-text-muted mb-1">Details from the customer</div>
              <p className="text-sm whitespace-pre-line break-words">{selectedLead.notes}</p>
            </div>
          )}

          {NEXT_STATUSES[selectedLead.status]?.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-medium text-text-muted mb-2">Move to</div>
              <div className="flex flex-wrap gap-2">
                {NEXT_STATUSES[selectedLead.status].includes('rescheduled') && (
                  <div className="flex gap-1 items-center">
                    <input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)}
                      className="px-2 py-1.5 rounded-lg border border-line text-xs" />
                    <button onClick={() => onStatusChange('rescheduled')} disabled={!followUpDate}
                      className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:bg-paper disabled:opacity-40">
                      Reschedule
                    </button>
                  </div>
                )}
                {/* 'converted' is reached through "Convert to order" below, so a lead is never marked converted with no order. */}
                {NEXT_STATUSES[selectedLead.status].filter((s) => s !== 'rescheduled' && s !== 'converted').map((s) => (
                  <button key={s} onClick={() => onStatusChange(s)}
                    className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:bg-paper">
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {NEXT_STATUSES[selectedLead.status]?.includes('converted') || selectedLead.status === 'new' ? (
            <button onClick={() => onConvert()}
              className="w-full mb-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
              Convert to order
            </button>
          ) : null}
          {selectedLead.status === 'converted' && selectedLead.converted_order_id && (
            <p className="mb-4 text-sm text-text-muted">Converted to order #{selectedLead.converted_order_id}.</p>
          )}

          <form onSubmit={onAddActivity} className="mb-4 flex gap-2 flex-wrap">
            <select value={activityForm.type} onChange={(e) => setActivityForm({ ...activityForm, type: e.target.value })}
              className="px-2 py-2 rounded-lg border border-line text-xs">
              <option value="call">Call</option>
              <option value="message">Message</option>
              <option value="meeting">Meeting</option>
              <option value="note">Note</option>
            </select>
            <input value={activityForm.content} onChange={(e) => setActivityForm({ ...activityForm, content: e.target.value })}
              placeholder="Log an activity…"
              className="flex-1 min-w-[140px] px-3 py-2 rounded-lg border border-line text-xs" />
            <button type="submit" className="px-3 py-2 rounded-lg bg-ink text-white text-xs font-medium">Add</button>
          </form>

          <div className="text-xs font-medium text-text-muted mb-2">Activity</div>
          <div className="space-y-2 mb-2">
            {selectedLead.activities?.length === 0 && <p className="text-sm text-text-muted">No activity yet.</p>}
            {selectedLead.activities?.map((a) => (
              <div key={a.id} className="text-sm border-l-2 border-line pl-3">
                <div className="text-xs text-text-muted">{a.created_at} · {a.staff_name || 'System'} · <span className="capitalize">{a.type.replace('_', ' ')}</span></div>
                {a.content && <div>{a.content}</div>}
              </div>
            ))}
          </div>

          <div className="flex gap-2 mt-4">
            <button onClick={onEdit} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Edit lead</button>
            {canAssign && selectedLead.status !== 'converted' && (
              <button onClick={onDelete} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium text-danger">Delete lead</button>
            )}
          </div>
          <button onClick={() => onClose()} className="w-full mt-2 py-2.5 rounded-lg border border-line text-sm font-medium">Close</button>
        </Sheet>
  );
}
