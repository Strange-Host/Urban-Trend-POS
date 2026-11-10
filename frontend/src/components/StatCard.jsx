import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import Sparkline from './Sparkline';

// Was defined identically in Dashboard/Expenses/Leads/Payments/StaffLogs —
// one copy here, with a `size` prop covering the one real difference
// (Dashboard's cards are larger and support an optional `sub` line).
//
// Large cards can also show how the number is moving:
//   delta: { pct, label }  — percentage change against the previous period; pct null = nothing to compare
//   spark: number[]        — a tiny trend line next to the number
// (more of the number is "good" here: revenue-style figures; up is green, down is red)
function Delta({ pct, label }) {
  if (pct === null || pct === undefined) return null;
  const flat = Math.abs(pct) < 0.5;
  const Icon = flat ? Minus : pct > 0 ? TrendingUp : TrendingDown;
  const tone = flat ? 'text-text-muted' : pct > 0 ? 'text-success' : 'text-danger';
  return (
    <div className="flex items-center gap-1.5 text-xs mt-1.5 flex-wrap">
      <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${tone}`}>
        <Icon size={14} strokeWidth={2} aria-hidden="true" />
        {flat ? '0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`}
      </span>
      {label && <span className="text-text-muted">{label}</span>}
    </div>
  );
}

export default function StatCard({ label, value, sub, size = 'compact', delta, spark, onClick, active = false }) {
  const isLarge = size === 'large';
  // With `onClick` the card becomes a button (used as a filter tile); `active` marks the selected one.
  const interactive = typeof onClick === 'function';
  const Tag = interactive ? 'button' : 'div';
  const interactiveClasses = interactive
    ? `text-left w-full cursor-pointer transition-colors hover:border-accent focus-visible:outline-none focus-visible:border-accent ${active ? 'border-accent ring-1 ring-accent' : ''}`
    : '';
  return (
    // `@container` + the @[..] sizes below: the number is sized by the card's own width,
    // so it shrinks in a narrow card (phone, or four-up at ~1000px) instead of wrapping.
    <Tag {...(interactive ? { type: 'button', onClick, 'aria-pressed': active } : {})}
      className={`@container bg-surface border border-line rounded-xl ${isLarge ? 'p-4 sm:p-5' : 'p-4'} ${interactiveClasses}`}>
      <div className={`text-text-muted ${isLarge ? 'text-sm mb-3' : 'text-xs mb-1'}`}>{label}</div>
      <div className={`font-display font-700 tracking-tight tabular-nums ${isLarge ? 'text-xl @[9rem]:text-2xl @[13rem]:text-3xl' : 'text-2xl'}`}>{value}</div>
      {delta && <Delta {...delta} />}
      {spark && <Sparkline values={spark} className="w-full h-8 mt-3" />}
      {sub && <div className="text-xs text-text-muted mt-1.5">{sub}</div>}
    </Tag>
  );
}
