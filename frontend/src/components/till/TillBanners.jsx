// What the till says about the connection and the offline queue. Always drawn across the top of the till, above the
// product columns and the ticket, so a cashier cannot miss that they are selling against a stale stock count, that sales
// are waiting to send, or that the server turned one down. Wording and actions are as they have always been.
export default function TillBanners({ online, pendingCount, syncing, onRetry, failedEntries, onDiscard }) {
  if (online && pendingCount === 0 && failedEntries.length === 0) return null;
  return (
    <div className="space-y-2 border-b border-line bg-paper px-4 py-3 xl:px-6" role="region" aria-label="Offline status">
      {!online && (
        <div className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          <strong>Offline.</strong> Sales are being saved on this device and will send
          automatically when the connection returns. Stock counts shown may be out of date,
          and stock can't be checked until then.
        </div>
      )}
      {online && pendingCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-accent/15 px-3.5 py-2.5 text-sm">
          <span>
            {syncing ? 'Sending' : 'Waiting to send'} {pendingCount} offline sale{pendingCount === 1 ? '' : 's'}…
          </span>
          {!syncing && (
            <button onClick={onRetry} className="min-h-11 shrink-0 px-2 underline">Retry now</button>
          )}
        </div>
      )}
      {failedEntries.length > 0 && (
        <div className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          <strong>{failedEntries.length} offline sale{failedEntries.length === 1 ? '' : 's'} the server rejected.</strong>
          <ul className="mt-1.5 space-y-1">
            {failedEntries.map((e) => (
              <li key={e.clientSaleId} className="flex items-start justify-between gap-3 font-mono text-xs">
                <span>
                  {new Date(e.ringedUpAt).toLocaleString()} — {(e.payload.payments.reduce((n, p) => n + p.amount, 0) / 100).toFixed(2)}: {e.lastError}
                </span>
                <button onClick={() => onDiscard(e.clientSaleId)} className="min-h-11 shrink-0 px-2 underline">Dismiss</button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs">
            These were rung up but couldn't be recorded — re-ring them if the goods left the shop,
            then dismiss. Nothing is discarded automatically.
          </p>
        </div>
      )}
    </div>
  );
}
