import { useState } from 'react';

import Sheet from './Sheet';
// Shown every time someone clocks out or closes their till (ported from the older
// system's logout check, built on this system's own data). The note always reaches
// the managers (even when nothing is open) and, with the snapshot, goes in the
// activity log.
//
// Clocking out is a gate (requireConfirmations): the person confirms that every order assigned to them was
// dispatched and every Nairobi payment of theirs is reconciled. A box can only be ticked when it is true - the
// server checks too. If something is genuinely still open they can't tick it; they write a reason instead (or,
// when the shop is set to block clock-out, they can't leave until it's cleared). Closing a till is still just a
// prompt that never blocks.
const MIN_REASON_LENGTH = 10;

function Section({ title, count, children }) {
  if (!count) return null;
  return (
    <div className="mb-3">
      <div className="text-sm font-medium">{title} <span className="text-text-muted font-normal">({count})</span></div>
      <ul className="mt-1 text-xs text-text-muted space-y-0.5">{children}</ul>
    </div>
  );
}

const OPEN_GATE = { mode: 'reason', can_confirm_dispatched: true, can_confirm_nairobi: true, reason_required: false, blocked: false };

function Confirm({ id, checked, disabled, onChange, children, problem }) {
  return (
    <div className="mb-2">
      <label htmlFor={id} className={`flex items-start gap-2 text-sm ${disabled ? 'text-text-muted' : ''}`}>
        <input id={id} type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{children}</span>
      </label>
      {problem && <p className="ml-6 text-xs text-danger">{problem}</p>}
    </div>
  );
}

export default function HandoverModal({ summary, actionLabel, busy, onCancel, onConfirm, requireConfirmations = false }) {
  const [notes, setNotes] = useState('');
  const [dispatched, setDispatched] = useState(false);
  const [nairobi, setNairobi] = useState(false);
  const money = (c) => `KES ${((c || 0) / 100).toLocaleString('en-KE')}`;
  const open = summary.has_open_items;
  const gate = requireConfirmations ? (summary.gate || OPEN_GATE) : OPEN_GATE;
  const undispatched = summary.undispatched_orders || { count: 0, sample: [] };

  const reasonRequired = requireConfirmations && gate.reason_required;
  const reasonShort = reasonRequired && notes.trim().length < MIN_REASON_LENGTH;
  const missingTick = requireConfirmations && ((gate.can_confirm_dispatched && !dispatched) || (gate.can_confirm_nairobi && !nairobi));
  const canSubmit = !busy && !(requireConfirmations && gate.blocked) && !missingTick && !reasonShort;

  function submit() {
    if (!canSubmit) return;
    if (requireConfirmations) onConfirm(notes.trim(), { dispatched, nairobi });
    else onConfirm(notes.trim());
  }

  let intro = 'Nothing of yours is left open. Add a note for your manager if there is anything they should know.';
  if (requireConfirmations && gate.blocked) intro = "You can't clock out yet — clear the items marked below first, or ask a manager for help.";
  else if (reasonRequired) intro = "Something you were responsible for is still open. Tell your manager why, then you can leave — they'll be told.";
  else if (open) intro = 'You still have items open. You can leave, but your manager will see this — add a note for whoever picks it up.';

  return (
    <Sheet onClose={onCancel} size="md" zIndex={70} dismissOnBackdrop={false} label="Open items before you leave">
        <h2 className="font-display font-700 text-lg mb-1">Before you go</h2>
        <p className="text-sm text-text-muted mb-4">{intro}</p>

        <Section title="Orders waiting to be dispatched" count={requireConfirmations ? undispatched.count : 0}>
          {undispatched.sample.map((o) => <li key={o.id}>{o.product_code || `#${o.id}`} · {money(o.total)}</li>)}
          {undispatched.count > undispatched.sample.length && <li>…and {undispatched.count - undispatched.sample.length} more</li>}
        </Section>
        <Section title="Unpaid parcels" count={summary.unpaid_parcels.count}>
          {summary.unpaid_parcels.sample.map((o) => <li key={o.id}>{o.product_code || `#${o.id}`} · {money(o.total - o.amount_paid)} owed</li>)}
          {summary.unpaid_parcels.count > summary.unpaid_parcels.sample.length && <li>…and {summary.unpaid_parcels.count - summary.unpaid_parcels.sample.length} more ({money(summary.unpaid_parcels.amount)} in total)</li>}
        </Section>
        <Section title="Nairobi parcels not yet paid for" count={summary.nairobi_unpaid?.count}>
          {summary.nairobi_unpaid?.sample.map((o) => <li key={o.id}>{o.product_code || `#${o.id}`} · {money(o.total - o.amount_paid)} owed</li>)}
        </Section>
        <Section title="Shop cash you still hold" count={summary.custody_open?.count}>
          <li>{money(summary.custody_open?.amount)} taken at the shop and not yet deposited</li>
        </Section>
        <Section title="COD orders not yet confirmed" count={summary.unconfirmed_cod.count}>
          {summary.unconfirmed_cod.sample.map((o) => <li key={o.id}>{o.product_code || `#${o.id}`} · {money(o.total)}</li>)}
          {summary.unconfirmed_cod.count > summary.unconfirmed_cod.sample.length && <li>…and {summary.unconfirmed_cod.count - summary.unconfirmed_cod.sample.length} more</li>}
        </Section>
        <Section title="Leads needing action" count={summary.leads_needing_action.count}>
          {summary.leads_needing_action.sample.map((l) => <li key={l.id}>{l.name} · {l.phone}{l.status === 'rescheduled' ? ' (follow-up due)' : ' (new)'}</li>)}
          {summary.leads_needing_action.count > summary.leads_needing_action.sample.length && <li>…and {summary.leads_needing_action.count - summary.leads_needing_action.sample.length} more</li>}
        </Section>

        {summary.unmatched_payments?.count > 0 && (
          <p className="text-xs text-text-muted mb-3">
            {summary.unmatched_payments.count} payment{summary.unmatched_payments.count === 1 ? '' : 's'} ({money(summary.unmatched_payments.amount)}) still not matched to an order — worth a look in Payments.
          </p>
        )}

        {requireConfirmations && (
          <fieldset className="mt-4 mb-1 border-t border-line pt-3">
            <legend className="sr-only">Confirm before clocking out</legend>
            <Confirm
              id="confirm-dispatched" checked={dispatched} disabled={!gate.can_confirm_dispatched} onChange={setDispatched}
              problem={!gate.can_confirm_dispatched ? `${undispatched.count} assigned order${undispatched.count === 1 ? ' is' : 's are'} still waiting to be dispatched.` : null}
            >
              All the orders assigned to me have been dispatched
            </Confirm>
            <Confirm
              id="confirm-nairobi" checked={nairobi} disabled={!gate.can_confirm_nairobi} onChange={setNairobi}
              problem={!gate.can_confirm_nairobi ? `${summary.nairobi_unpaid?.count} Nairobi payment${summary.nairobi_unpaid?.count === 1 ? ' is' : 's are'} not reconciled yet (${money(summary.nairobi_unpaid?.amount)}).` : null}
            >
              All my Nairobi payments are reconciled
            </Confirm>
          </fieldset>
        )}

        <label className="block text-sm font-medium mb-1.5 mt-4" htmlFor="handover-notes">
          {reasonRequired ? `Why is this still open? (required, at least ${MIN_REASON_LENGTH} characters)` : 'Note for your manager (optional)'}
        </label>
        <textarea
          id="handover-notes" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Customer on UT000123 said they will pay tomorrow"
          className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50">Stay and finish up</button>
          <button type="button" onClick={submit} disabled={!canSubmit} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
            {busy ? 'Working…' : actionLabel}
          </button>
        </div>
    </Sheet>
  );
}
