import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { payrollApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/UIContext';
import { StatusPill } from '../components/DataUI';

// Locked payroll runs. A period is calculated as a DRAFT (re-calculate it as often as you like), reviewed, then
// APPROVED, which freezes every figure and fingerprints it, and finally marked PAID. Approving and paying are admin-only
// on the server; managers see the buttons so they know the step exists, but they are disabled for them.

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
const when = (utc) => (utc ? new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString() : '');
const STATUS = {
  draft: { tone: 'neutral', label: 'Draft' },
  approved: { tone: 'accent', label: 'Approved · locked' },
  paid: { tone: 'success', label: 'Paid · locked' },
};
const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleString(undefined, { month: 'long', year: 'numeric' });
const dayLabel = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const LINE_LABEL = {
  retainer_day: 'Retainer day', commission_order: 'Commission', late: 'Late', absence: 'Absence', missing_hours: 'Short hours',
  salary_advance: 'Salary advance', loss_deduction: 'Loss deduction',
};
const isDeduction = (kind) => !['retainer_day', 'commission_order'].includes(kind);

// The month whose pay is next to be calculated: the one that just finished.
function lastMonth() {
  const d = new Date();
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}
// A reversal is a loss deduction that carries the order it takes commission back from.
const lineLabel = (l) => (l.kind === 'loss_deduction' && (l.refText || '').startsWith('Commission reversed') ? 'Commission reversed' : LINE_LABEL[l.kind] || l.kind);
const payType = (i) => {
  if (i.commissionType === 'percentage') return `${i.percentBp / 100}% of sales`;
  if (i.commissionType === 'combined') return `${money(i.rate)}/unit + ${i.percentBp / 100}%`;
  return `${money(i.rate)} per unit`;
};
const errorCode = (err) => err?.response?.data?.error?.code;

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.draft;
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export default function PayrollRuns() {
  const qc = useQueryClient();
  const toast = useToast();
  const [month, setMonth] = useState(lastMonth());
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: runs, isLoading } = useQuery({ queryKey: ['payroll', 'runs'], queryFn: () => payrollApi.runs().then((r) => r.data.data) });
  const { data: cycle } = useQuery({ queryKey: ['payroll', 'cycle'], queryFn: () => payrollApi.cycle().then((r) => r.data.data) });

  async function calculate() {
    setBusy(true);
    setError('');
    try {
      const run = (await payrollApi.generateRun({ month })).data.data;
      qc.invalidateQueries({ queryKey: ['payroll'] });
      setSelectedId(run.id);
      toast.success('Draft calculated.');
    } catch (err) {
      setError(getErrorMessage(err, 'Could not calculate that period.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <h1 className="font-display font-700 text-2xl mb-1">Pay runs</h1>
      <p className="text-text-muted text-sm mb-5">
        Each month is worked, calculated, reviewed, approved (which locks the figures) and paid on the {cycle?.payDay ?? 3}rd of the next month. A locked run never changes,
        and commission is paid only on secured money, once per order. Commission targets start again every month.
      </p>

      {cycle && <CycleBanner cycle={cycle} />}

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm" role="alert">{error}</div>}

      <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-6">
        <label className="text-xs text-text-muted">Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="mt-1 block w-full px-3.5 py-2.5 rounded-lg border border-line bg-surface text-sm text-text focus:border-accent outline-none" />
        </label>
        <button onClick={calculate} disabled={busy || !month}
          className="px-4 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          Calculate draft
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[18rem_1fr] items-start">
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-3 font-display font-600 text-sm border-b border-line">Runs</div>
          {isLoading && <div className="p-4 text-sm text-text-muted">Loading…</div>}
          {runs && runs.length === 0 && <div className="p-4 text-sm text-text-muted">No runs yet. Pick a month and calculate a draft.</div>}
          <ul>
            {(runs || []).map((r) => (
              <li key={r.id}>
                <button onClick={() => setSelectedId(r.id)} aria-current={selectedId === r.id}
                  className={`w-full text-left px-4 py-3 border-b border-line last:border-0 hover:bg-bg ${selectedId === r.id ? 'bg-bg' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{r.periodStart} → {r.periodEnd}</span>
                    <StatusBadge status={r.status} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {selectedId
          ? <RunDetail key={selectedId} runId={selectedId} onError={setError} />
          : <div className="bg-surface border border-line rounded-xl p-10 text-center text-text-muted text-sm">Select a run to see who is paid what.</div>}
      </div>
    </div>
  );
}

// Where the cycle stands: the month just finished and whether its pay is calculated, locked, paid, due or late.
function CycleBanner({ cycle }) {
  const prev = cycle.previous;
  const status = prev.run ? prev.run.status : 'none';
  const text = {
    none: 'not calculated yet',
    draft: 'drafted, not yet approved',
    approved: 'approved and locked, not yet paid',
    paid: 'paid',
  }[status];
  const late = prev.overdue;
  const tone = late ? 'bg-danger-soft text-danger' : status === 'paid' ? 'bg-bg text-text-muted' : 'bg-bg text-text';
  return (
    <div className={`mb-4 px-3.5 py-2.5 rounded-lg text-sm ${tone}`} role={late ? 'alert' : undefined}>
      <span className="font-medium">{monthLabel(prev.month)} pay</span> is {text} · due {dayLabel(prev.payDate)}
      {late && ' · overdue'}
    </div>
  );
}

function RunDetail({ runId, onError }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [expanded, setExpanded] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [paying, setPaying] = useState(false);
  const [pay, setPay] = useState({ method: 'mpesa', ref: '', signedName: '' });
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: run, isLoading } = useQuery({ queryKey: ['payroll', 'runs', runId], queryFn: () => payrollApi.run(runId).then((r) => r.data.data) });
  const locked = !!run && run.status !== 'draft';
  const { data: verify } = useQuery({
    queryKey: ['payroll', 'runs', runId, 'verify', run?.status],
    queryFn: () => payrollApi.verifyRun(runId).then((r) => r.data.data),
    enabled: locked,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['payroll', 'runs'] });
  };
  async function act(fn, ok) {
    setBusy(true);
    onError('');
    try {
      await fn();
      refresh();
      toast.success(ok);
      return true;
    } catch (err) {
      if (errorCode(err) === 'RUN_STALE') { setStale(true); setConfirming(false); }
      else onError(getErrorMessage(err, 'That did not work.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const approve = async () => {
    if (await act(() => payrollApi.approveRun(runId), 'Run approved and locked.')) { setConfirming(false); setStale(false); }
  };
  const regenerate = async () => {
    if (await act(() => payrollApi.generateRun(run.periodStart, run.periodEnd), 'Draft recalculated.')) { setStale(false); setConfirming(false); }
  };
  const markPaid = async () => {
    if (await act(() => payrollApi.payRun(runId, pay.method, pay.ref, pay.signedName.trim(), run.checksum), 'Payout signed off and recorded.')) setPaying(false);
  };
  const toggle = (id) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (isLoading || !run) return <div className="text-sm text-text-muted">Loading…</div>;
  const needsRef = pay.method !== 'cash';
  const adminOnly = isAdmin ? undefined : 'Only an admin can do this';

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="font-display font-700 text-lg">{run.periodStart} → {run.periodEnd}</div>
          <StatusBadge status={run.status} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
          <Total label="Gross" value={money(run.totals.gross)} />
          <Total label="Deductions" value={money(run.totals.deductions)} />
          <Total label="Payable" value={money(run.totals.payable)} strong />
          <Total label="Owed back" value={money(run.totals.shortfall)} tone={run.totals.shortfall > 0 ? 'danger' : undefined} />
        </div>

        <div className="text-xs text-text-muted space-y-0.5">
          <div>Calculated by {run.createdByName || 'staff'} · {when(run.createdAt)}{run.payDate ? ` · pay date ${run.payDate}` : ''}</div>
          {run.approvedAt && <div>Approved by {run.approvedByName || 'admin'} · {when(run.approvedAt)}</div>}
          {run.status === 'paid' && (
            <div>Paid by {run.paidByName || 'admin'} · {when(run.paidAt)} · {run.paymentMethod}{run.paymentRef ? ` · ${run.paymentRef}` : ''}</div>
          )}
          {run.status === 'paid' && run.signedOffName && (
            <div>Signed off by {run.signedOffByName || 'admin'} as “{run.signedOffName}” · {when(run.signedOffAt)}</div>
          )}
          {locked && verify && (
            verify.intact
              ? <div className="text-success">Fingerprint verified · <span className="font-mono">{run.checksum.slice(0, 12)}…</span></div>
              : <div className="text-danger font-medium" role="alert">Fingerprint does not match. This run was altered after it was locked.</div>
          )}
        </div>
      </div>

      <div className="bg-surface border border-line rounded-xl p-5">
        {run.status === 'draft' && (
          <>
            {stale && (
              <div className="mb-3 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm" role="alert">
                Something changed since this draft was calculated (a payment was secured or a deduction added). Recalculate it, review it, then approve.
              </div>
            )}
            <p className="text-xs text-text-muted mb-3">
              A draft can be recalculated freely. Approving freezes these figures permanently and uses up the orders listed, so none can earn commission again.
            </p>
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">Lock this run permanently?</span>
                <button onClick={approve} disabled={busy || !isAdmin} title={adminOnly}
                  className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Yes, approve and lock</button>
                <button onClick={() => setConfirming(false)} className="px-4 py-2 rounded-lg border border-line text-sm">Cancel</button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button onClick={regenerate} disabled={busy} className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50">Recalculate</button>
                <button onClick={() => setConfirming(true)} disabled={busy || !isAdmin || run.items.length === 0 || stale} title={adminOnly}
                  className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Approve and lock</button>
              </div>
            )}
          </>
        )}

        {run.status === 'approved' && (
          paying ? (
            <div>
              <p className="text-xs text-text-muted mb-2">
                You are signing off these exact figures: payable {money(run.totals.payable)}, fingerprint <span className="font-mono">{run.checksum.slice(0, 12)}…</span>
              </p>
            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <label className="text-xs text-text-muted">Paid by
                <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}
                  className="mt-1 block px-3 py-2 rounded-lg border border-line bg-surface text-sm text-text outline-none focus:border-accent">
                  <option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="cash">Cash</option>
                </select>
              </label>
              {needsRef && (
                <label className="text-xs text-text-muted flex-1">Payment reference
                  <input value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} placeholder="e.g. M-Pesa code or bank reference"
                    className="mt-1 block w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-text outline-none focus:border-accent" />
                </label>
              )}
              <label className="text-xs text-text-muted flex-1">Sign off: type your full name
                <input value={pay.signedName} onChange={(e) => setPay({ ...pay, signedName: e.target.value })} placeholder={user?.name || 'Your full name'} autoComplete="off"
                  className="mt-1 block w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-text outline-none focus:border-accent" />
              </label>
              <button onClick={markPaid} disabled={busy || !isAdmin || !pay.signedName.trim() || (needsRef && !pay.ref.trim())} title={adminOnly}
                className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Confirm payment</button>
              <button onClick={() => setPaying(false)} className="px-4 py-2 rounded-lg border border-line text-sm">Cancel</button>
            </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => setPaying(true)} disabled={!isAdmin} title={adminOnly}
                className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Mark as paid</button>
              <span className="text-xs text-text-muted">Locked. Record the payment once the money has gone out.</span>
            </div>
          )
        )}

        {run.status === 'paid' && <div className="text-sm text-text-muted">This run is paid and final.</div>}
        {!isAdmin && run.status !== 'paid' && <div className="mt-3 text-xs text-text-muted">Only an admin can approve or pay a run.</div>}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        {run.items.length === 0 ? (
          <div className="p-6 text-sm text-text-muted text-center">Nobody is on payroll for this period: no attendance, secured sales or deductions.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-line">
                <th className="px-4 py-2.5 font-medium">Staff</th>
                <th className="px-2 py-2.5 font-medium text-right">Gross</th>
                <th className="px-2 py-2.5 font-medium text-right">Deductions</th>
                <th className="px-4 py-2.5 font-medium text-right">Payable</th>
              </tr>
            </thead>
            <tbody>
              {run.items.map((i) => (
                <ItemRows key={i.staffId} item={i} open={expanded.has(i.staffId)} onToggle={() => toggle(i.staffId)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Total({ label, value, strong, tone }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`font-mono ${strong ? 'font-700 text-base' : ''} ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</div>
    </div>
  );
}

function ItemRows({ item: i, open, onToggle }) {
  return (
    <>
      <tr className="border-b border-line last:border-0">
        <td className="px-4 py-3">
          <button onClick={onToggle} aria-expanded={open} className="text-left">
            <span className="font-medium">{i.staffName}</span>
            <span className="block text-xs text-text-muted">
              {i.daysWorked} days · {i.unitsSold} units · {i.commissionType && i.commissionType !== 'fixed' ? payType(i) : `${i.tier} tier`}
            </span>
          </button>
        </td>
        <td className="px-2 py-3 text-right font-mono">{money(i.gross)}</td>
        <td className="px-2 py-3 text-right font-mono text-danger">{i.deductions > 0 ? `−${money(i.deductions)}` : money(0)}</td>
        <td className="px-4 py-3 text-right font-mono font-600">
          {money(i.payable)}
          {i.shortfall > 0 && <span className="block text-xs text-danger font-400">owes {money(i.shortfall)}</span>}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-bg">
          <td colSpan={4} className="px-4 py-3">
            <div className="font-mono text-xs space-y-1">
              {i.lines.length === 0 && <div className="text-text-muted">No lines.</div>}
              {i.lines.map((l, idx) => (
                <div key={idx} className="flex justify-between gap-3 text-text-muted">
                  <span>
                    {l.refDate} · {lineLabel(l)}
                    {l.refText ? ` · ${l.refText}` : ''}
                    {l.quantity ? ` (${l.quantity}${l.kind === 'commission_order' ? ' units' : 'h'})` : ''}
                  </span>
                  <span className={isDeduction(l.kind) ? 'text-danger' : ''}>{isDeduction(l.kind) ? '−' : ''}{money(l.amountCents)}</span>
                </div>
              ))}
              <div className="pt-1 flex justify-between text-text">
                <span>Achievement {(i.achievementBp / 100).toFixed(1)}% of {money(i.target)} target · {payType(i)}</span>
                <span>Net {money(i.net)}</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
