// Loading placeholders. A grey shape in the place the content will be reads as "on its way" and does not make
// the page jump when the data arrives, which a line of "Loading…" text does. Every placeholder keeps a visually
// hidden "Loading…" for screen readers, and the pulse stops for people who ask their device for less motion.

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`motion-safe:animate-pulse rounded-md bg-line ${className}`} />;
}

const LINE_WIDTHS = ['w-full', 'w-5/6', 'w-2/3', 'w-3/4', 'w-1/2'];

/** A few text-line bars: the stand-in for a list or paragraph that is still loading. */
export function LoadingBlock({ lines = 3, className = '' }) {
  return (
    <div role="status" className={`space-y-3 py-4 ${className}`}>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} className={`h-4 ${LINE_WIDTHS[i % LINE_WIDTHS.length]}`} />)}
    </div>
  );
}

const CELL_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-1/3', 'w-5/6', 'w-1/2'];

/** Table body rows for a table that is loading: `cols` cells wide, a few rows tall. */
export function SkeletonRows({ cols, rows = 4 }) {
  return Array.from({ length: rows }, (_, r) => (
    <tr key={r} className="border-t border-line" aria-hidden={r === 0 ? undefined : 'true'}>
      {Array.from({ length: cols }, (_, c) => (
        <td key={c} className="px-4 py-3.5">
          {r === 0 && c === 0 && <span className="sr-only" role="status">Loading…</span>}
          <Skeleton className={`h-4 ${CELL_WIDTHS[(r + c) % CELL_WIDTHS.length]}`} />
        </td>
      ))}
    </tr>
  ));
}

/** A row of stat-card shaped placeholders (dashboard numbers). */
export function SkeletonCards({ count = 4, className = '' }) {
  return (
    <div role="status" className={`grid grid-cols-2 md:grid-cols-4 gap-4 ${className}`}>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-surface border border-line rounded-xl p-4 sm:p-5" aria-hidden="true">
          <Skeleton className="h-3.5 w-1/3 mb-4" />
          <Skeleton className="h-7 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/** Whole-page placeholder shown while a page's code is still downloading. */
export function PageSkeleton() {
  return (
    <div role="status" className="p-4 md:p-8 max-w-6xl">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true">
        <Skeleton className="h-3 w-24 mb-3" />
        <Skeleton className="h-8 w-64 mb-2" />
        <Skeleton className="h-4 w-96 max-w-full mb-8" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
