import { useState } from 'react';

import Sheet from './Sheet';
// Shown every time someone clocks out or closes their till (ported from the older
// system's logout check, built on this system's own data). It never blocks —
// leaving with open items is allowed — but it makes the person look at what
// they're leaving, and lets them leave a note for their manager. The note always
// reaches the managers (even when nothing is open) and, with the snapshot, goes
// in the activity log.
function Section({ title, count, children }) {
  if (!count) return null;
  return (
    <div className="mb-3">
      <div className="text-sm font-medium">{title} <span className="text-text-muted font-normal">({count})</span></div>
      <ul className="mt-1 text-xs text-text-muted space-y-0.5">{children}</ul>
    </div>
  );
}

export default function HandoverModal({ summary, actionLabel, busy, onCancel, onConfirm }) {
  const [notes, setNotes] = useState('');
  const money = (c) => `KES ${((c || 0) / 100).toLocaleString('en-KE')}`;
  const open = summary.has_open_items;

  return (
    <Sheet onClose={onCancel} size="md" zIndex={70} dismissOnBackdrop={false} label="Open items before you leave">
        <h2 className="font-display font-700 text-lg mb-1">Before you go</h2>
        <p className="text-sm text-text-muted mb-4">
          {open
            ? 'You still have items open. You can leave, but your manager will see this — add a note for whoever picks it up.'
            : 'Nothing of yours is left open. Add a note for your manager if there is anything they should know.'}
        </p>

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

        <label className="block text-sm font-medium mb-1.5 mt-4" htmlFor="handover-notes">Note for your manager (optional)</label>
        <textarea
          id="handover-notes" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Customer on UT000123 said they will pay tomorrow"
          className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50">Stay and finish up</button>
          <button type="button" onClick={() => onConfirm(notes.trim())} disabled={busy} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
            {busy ? 'Working…' : actionLabel}
          </button>
        </div>
    </Sheet>
  );
}
