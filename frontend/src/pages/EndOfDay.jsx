import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attendanceApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { PageHeader, StatusPill } from '../components/DataUI';
import { LoadingBlock } from '../components/Skeleton';

function time(ts) {
  return ts ? new Date(`${ts.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}

const REASON = { not_clocked_in: 'Not clocked in by the cutoff', unassigned: 'Had no owner' };

function Card({ title, count, children }) {
  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden mb-5">
      <div className="px-4 py-3 border-b border-line font-display font-600 text-sm">
        {title}{count !== undefined && <span className="ml-2 text-text-muted font-mono text-xs">{count}</span>}
      </div>
      {children}
    </div>
  );
}

const Empty = ({ children }) => <div className="p-6 text-center text-text-muted text-sm">{children}</div>;

export default function EndOfDay() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['end-of-day', date],
    queryFn: async () => (await attendanceApi.endOfDay(date || undefined)).data.data,
  });

  async function approve() {
    setBusy(true);
    setError('');
    try {
      await attendanceApi.approveEndOfDay({ date: data.work_date, note: note.trim() || undefined, acknowledged });
      setAcknowledged(false);
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['end-of-day'] });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const stillIn = data ? data.attendance.filter((a) => a.clock_in_at && !a.clock_out_at) : [];

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <PageHeader
        eyebrow="Attendance"
        title="End-of-day review"
        description="Check what was reassigned, who was absent or late, and what each person left in their handover note, then approve the day."
        actions={<Link to="/attendance" className="px-3.5 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted">Back to attendance</Link>}
      />

      <label className="block mb-5 text-sm">
        <span className="text-text-muted mr-2">Day</span>
        <input type="date" value={date || data?.work_date || ''} onChange={(e) => { setDate(e.target.value); setAcknowledged(false); setError(''); }}
          className="px-3 py-2 rounded-lg border border-line bg-surface" />
      </label>

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
      {loadError && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(loadError)}</div>}
      {isLoading && <LoadingBlock />}

      {data && (
        <>
          <Card title="Attendance" count={`${data.summary.absent} absent · ${data.summary.late} late`}>
            {data.attendance.length === 0 ? <Empty>No staff on record.</Empty> : (
              <table className="stack-sm w-full text-sm">
                <thead className="bg-paper text-text-muted font-mono text-xs uppercase">
                  <tr><th className="text-left px-4 py-3">Staff</th><th className="text-left px-4 py-3">In</th><th className="text-left px-4 py-3">Out</th><th className="text-left px-4 py-3">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.attendance.map((r) => (
                    <tr key={r.staff_id}>
                      <td className="px-4 py-3 font-medium">{r.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{time(r.clock_in_at)}</td>
                      <td className="px-4 py-3 font-mono text-xs">{time(r.clock_out_at)}</td>
                      <td className="px-4 py-3">
                        {r.status === 'absent' ? <StatusPill tone="danger">Absent</StatusPill>
                          : r.hours_late > 0 ? <StatusPill tone="danger">{`Late by ${r.hours_late}h`}</StatusPill>
                            : <StatusPill tone="success">On time</StatusPill>}
                        {r.clock_in_at && !r.clock_out_at && <span className="ml-2 text-xs text-text-muted">still clocked in</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Reassigned orders and leads" count={data.moves.length}>
            {data.moves.length === 0 ? <Empty>Nothing was reassigned.</Empty> : (
              <table className="stack-sm w-full text-sm">
                <thead className="bg-paper text-text-muted font-mono text-xs uppercase">
                  <tr><th className="text-left px-4 py-3">Item</th><th className="text-left px-4 py-3">From</th><th className="text-left px-4 py-3">To</th><th className="text-left px-4 py-3">Why</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.moves.map((m) => (
                    <tr key={m.id}>
                      <td className="px-4 py-3 capitalize">{m.entity_type} #{m.entity_id}</td>
                      <td className="px-4 py-3">{m.from_name || '—'}</td>
                      <td className="px-4 py-3">{m.to_name}</td>
                      <td className="px-4 py-3 text-text-muted">{REASON[m.reason] || m.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Handover notes" count={data.handovers.length}>
            {data.handovers.length === 0 ? <Empty>No one has handed over yet.</Empty> : (
              <ul className="divide-y divide-line">
                {data.handovers.map((h) => (
                  <li key={h.id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{h.staff_name}</span>
                      <StatusPill tone={h.dispatch_confirmed ? 'success' : 'danger'}>{h.dispatch_confirmed ? 'All dispatched' : `${h.undispatched_count} not dispatched`}</StatusPill>
                      <StatusPill tone={h.nairobi_confirmed ? 'success' : 'danger'}>{h.nairobi_confirmed ? 'Nairobi reconciled' : `${h.nairobi_unpaid_count} Nairobi unpaid`}</StatusPill>
                    </div>
                    {h.notes ? <p className="mt-1.5 text-text-muted whitespace-pre-wrap">{h.notes}</p> : <p className="mt-1.5 text-text-muted italic">No note.</p>}
                  </li>
                ))}
              </ul>
            )}
            {data.no_handover.length > 0 && (
              <div className="px-4 py-3 border-t border-line bg-danger-soft text-danger text-sm">
                No handover on file for: {data.no_handover.map((n) => n.name).join(', ')}.
              </div>
            )}
          </Card>

          {data.review ? (
            <div className="px-4 py-3 rounded-xl bg-paper border border-line text-sm">
              <strong>Approved</strong> by {data.review.reviewed_by_name} on {new Date(`${data.review.created_at.replace(' ', 'T')}Z`).toLocaleString()}.
              {data.review.note && <p className="mt-1 text-text-muted">{data.review.note}</p>}
            </div>
          ) : (
            <div className="bg-surface border border-line rounded-xl p-4">
              {stillIn.length > 0 && <p className="mb-3 text-sm text-danger">Can't approve yet: {stillIn.map((s) => s.name).join(', ')} still clocked in.</p>}
              {data.needs_acknowledgement && (
                <label className="flex items-start gap-2 mb-3 text-sm">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
                  <span>I have reviewed the reassigned work, attendance and handover notes above.</span>
                </label>
              )}
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Note for the record (optional)"
                className="w-full mb-3 px-3 py-2 rounded-lg border border-line bg-paper text-sm" />
              <button onClick={approve} disabled={busy || stillIn.length > 0 || (data.needs_acknowledgement && !acknowledged)}
                className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
                {busy ? 'Approving…' : 'Approve the day'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
