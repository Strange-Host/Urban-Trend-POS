// Was defined identically in Dashboard/Expenses/Leads/Payments/StaffLogs —
// one copy here, with a `size` prop covering the one real difference
// (Dashboard's cards are larger and support an optional `sub` line).
export default function StatCard({ label, value, sub, size = 'compact' }) {
  const isLarge = size === 'large';
  return (
    // `@container` + the @[..] sizes below: the number is sized by the card's own width,
    // so it shrinks in a narrow card (phone, or four-up at ~1000px) instead of wrapping.
    <div className={`@container bg-surface border border-line rounded-2xl ${isLarge ? 'p-4 sm:p-5' : 'p-4'}`}>
      <div className={`text-text-muted ${isLarge ? 'text-sm mb-3' : 'text-xs mb-1'}`}>{label}</div>
      <div className={`font-display font-700 tracking-tight tabular-nums ${isLarge ? 'text-xl @[9rem]:text-2xl @[13rem]:text-3xl' : 'text-2xl'}`}>{value}</div>
      {sub && <div className="text-xs text-text-muted mt-1.5">{sub}</div>}
    </div>
  );
}
