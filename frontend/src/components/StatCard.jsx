// Was defined identically in Dashboard/Expenses/Leads/Payments/StaffLogs —
// one copy here, with a `size` prop covering the one real difference
// (Dashboard's cards are larger and support an optional `sub` line).
export default function StatCard({ label, value, sub, size = 'compact' }) {
  const isLarge = size === 'large';
  return (
    <div className={`bg-surface border border-line rounded-xl ${isLarge ? 'p-5' : 'p-4'}`}>
      <div className={`text-text-muted ${isLarge ? 'text-sm mb-2' : 'text-xs mb-1'}`}>{label}</div>
      <div className={`font-display font-700 ${isLarge ? 'text-3xl' : 'text-2xl'}`}>{value}</div>
      {sub && <div className="text-xs text-text-muted mt-1">{sub}</div>}
    </div>
  );
}
