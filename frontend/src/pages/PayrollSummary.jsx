import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { payrollApi, staffApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { fetchAll } from '../api/fetchAll';

function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
}

function firstOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

export default function PayrollSummary() {
  const [staffId, setStaffId] = useState('');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lossForm, setLossForm] = useState({ amount: '', notes: '' });

  const { data: staffList } = useQuery({
    queryKey: ['staff', 'for-payroll'],
    queryFn: () => fetchAll(staffApi.list, { status: 'active' }),
  });

  const { data: summary, isLoading, refetch } = useQuery({
    queryKey: ['payroll', staffId, from, to],
    queryFn: () => payrollApi.summary(staffId, from, to).then((r) => r.data.data),
    enabled: !!staffId && !!from && !!to,
  });

  async function handleLossDeduction() {
    const amount = Math.round(parseFloat(lossForm.amount) * 100);
    if (!amount || amount <= 0) { setError('Enter an amount.'); return; }
    setBusy(true);
    setError('');
    try {
      await payrollApi.lossDeduction({ staff_id: Number(staffId), amount, notes: lossForm.notes || undefined });
      setLossForm({ amount: '', notes: '' });
      refetch();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not record that deduction.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl">
      <h1 className="font-display font-700 text-2xl mb-1">Payroll</h1>
      <p className="text-text-muted text-sm mb-5">
        Calculated live from attendance and secured sales (commission is paid only on money that is safe: deposited, matched or remitted).
        It can change as records change. For a figure that is frozen and paid, use Pay runs.
      </p>

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="flex-1 px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none"
        >
          <option value="">Select a staff member…</option>
          {(staffList || []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className="px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          className="px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none" />
      </div>

      {!staffId && (
        <div className="bg-surface border border-line rounded-xl p-10 text-center text-text-muted text-sm">
          Pick a staff member and a date range to see their pay summary.
        </div>
      )}

      {staffId && isLoading && <div className="text-text-muted text-sm">Calculating…</div>}

      {summary && (
        <>
          <div className="bg-surface border border-line rounded-xl p-5 mb-5">
            <div className="font-display font-700 text-lg mb-4">
              {summary.staff.name}
              <span className="text-text-muted font-body font-400 text-sm"> · {summary.period.start} to {summary.period.end}</span>
            </div>

            <div className="font-mono text-sm space-y-1.5">
              <div className="flex justify-between">
                <span>Daily retainer <span className="text-text-muted">({summary.dailyRetainer.daysLoggedIn} days)</span></span>
                <span>{money(summary.dailyRetainer.total)}</span>
              </div>
              <div className="flex justify-between">
                <span>
                  Commission{' '}
                  <span className="text-text-muted">
                    ({summary.commission.unitsSold} units · {summary.commission.tier} tier)
                  </span>
                </span>
                <span>{money(summary.commission.commissionTotal)}</span>
              </div>
              <div className="flex justify-between font-600 pt-1.5 border-t border-dashed border-line">
                <span>Gross pay</span><span>{money(summary.grossPay)}</span>
              </div>

              <div className="pt-3 space-y-1.5">
                {summary.attendanceDeductions.absenceTotal > 0 && (
                  <div className="flex justify-between text-danger">
                    <span>Absences</span><span>−{money(summary.attendanceDeductions.absenceTotal)}</span>
                  </div>
                )}
                {summary.attendanceDeductions.lateTotal > 0 && (
                  <div className="flex justify-between text-danger">
                    <span>Late arrivals</span><span>−{money(summary.attendanceDeductions.lateTotal)}</span>
                  </div>
                )}
                {summary.attendanceDeductions.missingHoursTotal > 0 && (
                  <div className="flex justify-between text-danger">
                    <span>Short hours</span><span>−{money(summary.attendanceDeductions.missingHoursTotal)}</span>
                  </div>
                )}
                {summary.adjustments.map((a) => (
                  <div key={a.id} className="flex justify-between text-danger">
                    <span>
                      {a.type === 'salary_advance' ? 'Salary advance' : 'Loss deduction'}
                      {a.notes && <span className="text-text-muted"> · {a.notes}</span>}
                    </span>
                    <span>−{money(a.amount)}</span>
                  </div>
                ))}
                {summary.totalDeductions === 0 && <div className="text-text-muted">No deductions.</div>}
              </div>

              <div className="flex justify-between font-display font-700 text-xl pt-3 border-t border-dashed border-line">
                <span>Net payable</span>
                <span className={summary.netPayable < 0 ? 'text-danger' : ''}>{money(summary.netPayable)}</span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-dashed border-line text-xs text-text-muted">
              Sales achievement: {money(summary.commission.achievedSales)} of {money(summary.commission.target)} target
              ({summary.commission.achievementPercent.toFixed(1)}%).
            </div>
          </div>

          {summary.attendanceDeductions.breakdown.length > 0 && (
            <details className="bg-surface border border-line rounded-xl p-5 mb-5">
              <summary className="cursor-pointer text-sm font-medium">Attendance deduction detail</summary>
              <div className="mt-3 font-mono text-xs space-y-1">
                {summary.attendanceDeductions.breakdown.map((b, i) => (
                  <div key={i} className="flex justify-between text-text-muted">
                    <span>{b.date} · {b.type.replace('_', ' ')}{b.hoursLate ? ` (${b.hoursLate}h)` : ''}{b.hoursMissing ? ` (${b.hoursMissing}h)` : ''}</span>
                    <span className="text-danger">−{money(b.amount)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="bg-surface border border-line rounded-xl p-5">
            <div className="font-display font-600 mb-1">Record a loss deduction</div>
            <p className="text-text-muted text-xs mb-3">
              For losses this employee is accountable for that didn't go through a requisition — a till
              shortfall, breakage. Salary advances are deducted automatically when approved in Requisitions.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="number" step="0.01" placeholder="Amount"
                value={lossForm.amount}
                onChange={(e) => setLossForm({ ...lossForm, amount: e.target.value })}
                className="sm:w-36 px-3 py-2 rounded-lg border border-line bg-surface text-sm font-mono outline-none focus:border-accent"
              />
              <input
                placeholder="What happened?"
                value={lossForm.notes}
                onChange={(e) => setLossForm({ ...lossForm, notes: e.target.value })}
                className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent"
              />
              <button
                onClick={handleLossDeduction}
                disabled={busy}
                className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
              >
                Record
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
