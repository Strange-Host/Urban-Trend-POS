import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attendanceApi, telesalesApi, shiftApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import HandoverModal from '../components/HandoverModal';
import { useAuth } from '../context/AuthContext';
import { PageHeader, StatusPill } from '../components/DataUI';

function time(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}

export default function Attendance() {
  const { user, hasRole } = useAuth();
  const isManager = hasRole('admin', 'manager');
  const isAdmin = hasRole('admin');
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: todayData, isLoading } = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: () => attendanceApi.today().then((r) => r.data.data),
    enabled: isManager,
  });
  const rows = todayData || [];

  // A cashier can't call /attendance/today (manager-only), so their own
  // status comes from whether their clock-in/out attempts succeed. The
  // manager list already contains it for managers.
  const myRow = rows.find((r) => r.staff_id === user?.id);

  const [handover, setHandover] = useState(null); // open-items summary awaiting the person's decision

  async function doClock(action, label, handoverNotes) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await (action === 'in' ? attendanceApi.clockIn() : attendanceApi.clockOut(handoverNotes));
      setNotice(label);
      setHandover(null);
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
    } catch (err) {
      setHandover(null);
      setError(getErrorMessage(err, 'Could not record that.'));
    } finally {
      setBusy(false);
    }
  }

  // Clocking out always shows what you're leaving open and a box for a note to your manager (never blocks — if the
  // lookup fails, clock-out just proceeds).
  async function requestClockOut(label) {
    setError('');
    try {
      const { data } = await shiftApi.handover();
      setHandover({ summary: data.data, label });
      return;
    } catch { /* proceed without the prompt */ }
    await doClock('out', label);
  }

  async function handleRebalance() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data } = await telesalesApi.rebalance();
      const moved = (data.data.leads?.length || 0) + (data.data.orders?.length || 0);
      setNotice(moved === 0 ? 'Nothing needed reassigning.' : `Reassigned ${moved} item${moved === 1 ? '' : 's'}.`);
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    } catch (err) {
      setError(getErrorMessage(err, 'Rebalance failed.'));
    } finally {
      setBusy(false);
    }
  }

  const absent = rows.filter((r) => !r.clock_in_at);

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <PageHeader
        eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}
        title="Attendance"
        description="Clocking in is what marks you present for the day — leads and orders are only distributed to staff who have clocked in."
        meta={isManager && rows.length > 0 ? `${rows.length - absent.length} of ${rows.length}\npresent` : null}
      />

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
      {notice && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-success-soft text-success text-sm">{notice}</div>}

      {/* Self clock-in/out — available to everyone, including managers */}
      <div className="bg-surface border border-line rounded-xl p-5 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="font-display font-600">Your shift today</div>
            <div className="text-sm text-text-muted font-mono">
              {myRow
                ? `In ${time(myRow.clock_in_at)}${myRow.clock_out_at ? ` · Out ${time(myRow.clock_out_at)}` : ' · still clocked in'}`
                : 'Not clocked in yet today.'}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => doClock('in', 'Clocked in.')}
              disabled={busy}
              className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
            >
              Clock in
            </button>
            <button
              onClick={() => requestClockOut('Clocked out.')}
              disabled={busy}
              className="px-4 py-2.5 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50"
            >
              Clock out
            </button>
          </div>
        </div>
      </div>

      {isManager && (
        <>
          {absent.length > 0 && (
            <div className="mb-5 px-3.5 py-3 rounded-lg bg-danger-soft text-danger text-sm">
              <strong>{absent.length} not clocked in today:</strong>{' '}
              {absent.map((a) => a.name).join(', ')}.
              {isAdmin && (
                <>
                  {' '}Their open leads and orders are reassigned automatically after the cutoff hour.{' '}
                  <button onClick={handleRebalance} disabled={busy} className="underline disabled:opacity-50">
                    Run reassignment now
                  </button>
                </>
              )}
            </div>
          )}

          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-line font-display font-600 text-sm">
              Today · telesales team
            </div>
            {isLoading && <div className="p-6 text-text-muted text-sm">Loading…</div>}
            {!isLoading && rows.length === 0 && (
              <div className="p-8 text-center text-text-muted text-sm">
                No telesales staff on record yet.
              </div>
            )}
            {rows.length > 0 && (
              <table className="stack-sm w-full text-sm">
                <thead className="bg-paper text-text-muted font-mono text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-3">Staff</th>
                    <th className="text-left px-4 py-3">Clocked in</th>
                    <th className="text-left px-4 py-3">Clocked out</th>
                    <th className="text-left px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => (
                    <tr key={r.staff_id}>
                      <td className="px-4 py-3 font-medium">{r.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{time(r.clock_in_at)}</td>
                      <td className="px-4 py-3 font-mono text-xs">{time(r.clock_out_at)}</td>
                      <td className="px-4 py-3">
                        {!r.clock_in_at ? (
                          <StatusPill tone="danger">Absent</StatusPill>
                        ) : r.clock_out_at ? (
                          <StatusPill>Shift ended</StatusPill>
                        ) : (
                          <StatusPill tone="success">Present</StatusPill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      {handover && (
        <HandoverModal
          summary={handover.summary} actionLabel={handover.summary.has_open_items ? 'Clock out anyway' : 'Clock out'} busy={busy}
          onCancel={() => setHandover(null)} onConfirm={(notes) => doClock('out', handover.label, notes)}
        />
      )}
    </div>
  );
}
