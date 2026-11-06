import { when } from './helpers';

// The shipments someone has started and not finished. Saving a draft puts no stock in; it only keeps the form.
// Continuing one reopens the form with everything as it was left.
export default function ReceiveDrafts({ drafts, onOpen, onDelete, busy }) {
  if (!drafts.length) return null;
  return (
    <section aria-label="Draft shipments" className="mb-5">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-text-muted mb-2">Drafts ({drafts.length})</h3>
      <ul className="bg-surface border border-line rounded-xl divide-y divide-line">
        {drafts.map((d) => (
          <li key={d.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">
                {d.supplier_name || 'No supplier yet'}{d.reference && <span className="text-text-muted font-normal"> · Ref {d.reference}</span>}
              </div>
              <div className="text-xs text-text-muted">
                {d.line_count} {d.line_count === 1 ? 'line' : 'lines'} · started by {d.created_by_name} · saved {when(d.updated_at)}
              </div>
            </div>
            <button type="button" disabled={busy} onClick={() => onOpen(d.id)} className="text-sm font-medium px-3 py-1.5 rounded-lg border border-line hover:border-accent disabled:opacity-50">Continue</button>
            <button type="button" disabled={busy} onClick={() => onDelete(d.id)} aria-label={`Delete draft${d.reference ? ` ${d.reference}` : ''}`} className="text-xs text-danger hover:opacity-70 disabled:opacity-50">Delete</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
