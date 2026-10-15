// Shared primitives for the restyle. The point of putting these here
// rather than restyling each page inline is that "dense table" and
// "context panel" should look identical on Orders, Reconciliation and
// Attendance — if each page hand-rolls its own, they drift within a month.
//
// Deliberately NOT used by POSTerminal: the register keeps its light,
// large-target, glance-able layout. A cashier looking at it 200 times a
// shift under shop lighting has different needs than someone studying a
// reconciliation queue.

/* ------------------------------ Page header ------------------------------ */

// The monospace uppercase eyebrow above a bold display title — the
// "AUDIT READY / 1 VARIANCE" pattern. `meta` is the right-aligned
// counterpart ("6 lines · 5 counted").
export function PageHeader({ eyebrow, title, description, meta, actions }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-6">
      <div className="min-w-0">
        {eyebrow && (
          <div className="flex items-center gap-2 mb-1.5">
            <span className="h-px w-6 bg-accent shrink-0" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">{eyebrow}</span>
          </div>
        )}
        <h1 className="font-display font-700 text-2xl tracking-tight">{title}</h1>
        {description && <p className="text-text-muted text-sm mt-1 max-w-2xl">{description}</p>}
      </div>
      {(meta || actions) && (
        <div className="flex items-center gap-3 shrink-0">
          {meta && <div className="font-mono text-xs text-text-muted text-right whitespace-pre-line">{meta}</div>}
          {actions}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Dense table ------------------------------ */

export function DataTable({ columns, rows, keyField = 'id', onRowClick, selectedKey, empty, loading }) {
  if (loading) {
    return <div className="bg-surface border border-line rounded-xl p-6 text-text-muted text-sm">Loading…</div>;
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="bg-surface border border-line rounded-xl p-10 text-center text-text-muted text-sm">
        {empty || 'Nothing here yet.'}
      </div>
    );
  }

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="scroll-x">
        <table className="stack-sm w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`font-mono text-[11px] uppercase tracking-wider text-text-muted font-500 px-4 py-2.5 ${
                    col.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = row[keyField];
              const selected = selectedKey != null && key === selectedKey;
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-b border-line last:border-0 transition-colors ${
                    onRowClick ? 'cursor-pointer' : ''
                  } ${selected ? 'bg-accent/10' : onRowClick ? 'hover:bg-paper' : ''}`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-2.5 ${col.align === 'right' ? 'text-right' : ''} ${col.mono ? 'font-mono text-xs' : ''}`}
                    >
                      {col.render ? col.render(row) : row[col.key]}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------- Context panel ---------------------------- */

// The persistent right-hand panel from both reference designs. On mobile
// it's just a stacked card — a 400px side panel on a phone would leave
// neither column usable.
export function ContextPanel({ title, meta, children, empty }) {
  return (
    <div className="bg-surface border border-line rounded-xl lg:sticky lg:top-6">
      {(title || meta) && (
        <div className="px-4 py-3 border-b border-line flex items-start justify-between gap-3">
          <div className="font-display font-600 text-sm">{title}</div>
          {meta && <div className="font-mono text-[11px] text-text-muted text-right shrink-0">{meta}</div>}
        </div>
      )}
      <div className="p-4">
        {children || <div className="text-text-muted text-sm text-center py-10">{empty}</div>}
      </div>
    </div>
  );
}

// A timestamped entry inside a ContextPanel — the "Item movement" list
// pattern (time on the left, what happened on the right).
export function TimelineEntry({ time, title, detail }) {
  return (
    <div className="flex gap-3 py-2.5 border-b border-line last:border-0">
      <div className="font-mono text-[11px] text-text-muted w-20 shrink-0 leading-relaxed">{time}</div>
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        {detail && <div className="font-mono text-[11px] text-text-muted mt-0.5">{detail}</div>}
      </div>
    </div>
  );
}

/* --------------------------- Accent action bar --------------------------- */

// The full-width accent bar pinned to the bottom of a working surface,
// holding a summary on the left and the primary action on the right.
export function ActionBar({ label, summary, detail, meta, children }) {
  return (
    <div className="bg-accent text-accent-ink rounded-xl px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
      <div className="min-w-0 flex-1">
        {label && (
          <div className="font-mono text-[10px] uppercase tracking-wider opacity-70 leading-tight">{label}</div>
        )}
        <div className="font-display font-700 text-xl leading-tight">{summary}</div>
        {detail && <div className="font-mono text-xs opacity-80 mt-0.5">{detail}</div>}
      </div>
      {meta && <div className="font-mono text-xs opacity-80 text-right shrink-0">{meta}</div>}
      {children}
    </div>
  );
}

/* ------------------------------- Status pill ------------------------------ */

const TONES = {
  neutral: 'bg-line text-text-muted',
  accent: 'bg-accent/20 text-accent-ink',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
};

export function StatusPill({ tone = 'neutral', children }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/* --------------------------------- KPI tile -------------------------------- */

export function KpiTile({ label, value, delta, deltaTone = 'neutral' }) {
  return (
    <div className="bg-surface border border-line rounded-xl px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="font-display font-700 text-2xl mt-1 leading-none">{value}</div>
      {delta && (
        <div className={`font-mono text-[11px] mt-1.5 ${deltaTone === 'danger' ? 'text-danger' : deltaTone === 'success' ? 'text-success' : 'text-text-muted'}`}>
          {delta}
        </div>
      )}
    </div>
  );
}
