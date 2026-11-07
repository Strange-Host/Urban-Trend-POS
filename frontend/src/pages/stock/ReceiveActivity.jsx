import ReceiveDrafts from './ReceiveDrafts';

// The panel beside the delivery form: the drafts someone has started, then the latest shipments in a line each.
export default function ReceiveActivity({ drafts, onOpenDraft, onDeleteDraft, busy, receipts }) {
  const recent = receipts.slice(0, 5);
  return (
    <aside className="rounded-xl border border-line bg-surface p-5" aria-label="Drafts and recent activity">
      <ReceiveDrafts drafts={drafts} onOpen={onOpenDraft} onDelete={onDeleteDraft} busy={busy} />
      <h2 className="mb-3 font-display text-base font-700">Recent activity</h2>
      {recent.length === 0 && <p className="text-sm text-text-muted">Nothing has been received yet.</p>}
      <ul className="divide-y divide-line">
        {recent.map((r) => {
          const waiting = r.items.filter((i) => i.product_status === 'pending').length;
          return (
            <li key={r.id} className="py-2.5 first:pt-0">
              <div className="text-sm font-semibold">Received {r.total_units} {r.total_units === 1 ? 'unit' : 'units'}</div>
              <div className="text-xs text-text-muted">
                {r.received_on} · {r.supplier_name || 'No supplier'}{r.reference ? ` · Ref ${r.reference}` : ''}
                {waiting > 0 && <> · {waiting} new {waiting === 1 ? 'product' : 'products'} waiting for approval</>}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
