import { useState } from 'react';

import Sheet from './Sheet';
// Shown before someone clocks out or closes their till when they still have
// open items (ported from the older system's logout check, built on this
// system's own data). It never blocks — leaving with open items is allowed — but
// it makes the person look at what they're leaving, lets them add a note for
// whoever picks it up, and the note + snapshot go in the activity log.
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

  return (
    <Sheet onClose={onCancel} size="md" zIndex={70} dismissOnBackdrop={false} label="Open items before you leave">
        <h2 className="font-display font-700 text-lg mb-1">Before you go</h2>
        <p className="text-sm text-text-muted mb-4">You still have items open. You can leave, but your manager will see this — add a note for whoever picks it up.</p>

        <Section title="Unpaid parcels" count={summary.unpaid_parcels.count}>
          {summary.unpaid_parcels.sample.map((o) => <li key={o.id}>{o.product_code || `#${o.id}`} · {money(o.total - o.amount_paid)} owed</li>)}
          {summary.unpaid_parcels.count > summary.unpaid_parcels.sample.length && <li>…and {summary.unpaid_parcels.count - summary.unpaid_parcels.sample.length} more ({money(summary.unpaid_parcels.amount)} in total)</li>}
        </Section>
        <Section title="COD orders not yet confirmed" count={summary.unconfirmed_cod.count}>
          {summary.unconfirmed_cod.sample.map((o) => <li key={o.id}>{o.product_code || `#${o.id}`} · {money(o.total)}</li>)}
          {summary.unconfirmed_cod.count > summary.unconfirmed_cod.sample.length && <li>…and {summary.unconfirmed_cod.count - summary.unconfirmed_cod.sample.length} more</li>}
        </Section>
        <Section title="Leads needing action" count={summary.leads_needing_action.count}>
          {summary.leads_needing_action.sample.map((l) => <li key={l.id}>{l.name} · {l.phone}{l.status === 'rescheduled' ? ' (follow-up due)' : ' (new)'}</li>)}
          {summary.leads_needing_action.count > summary.leads_needing_action.sample.length && <li>…and {summary.leads_needing_action.count - summary.leads_needing_action.sample.length} more</li>}
        </Section>

        <label className="block text-sm font-medium mb-1.5 mt-4" htmlFor="handover-notes">Note for the next person (optional)</label>
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
