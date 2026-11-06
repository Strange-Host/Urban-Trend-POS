import { Link } from 'react-router-dom';
import { ChevronRight, CircleCheck } from 'lucide-react';
import { SkeletonCards } from '../../components/Skeleton';

// How loud a row is: red for things that cost money or stock if left, orange a warning, amber "needs a decision".
const TONE = {
  danger: { border: 'border-danger', count: 'text-danger' },
  warning: { border: 'border-warning', count: 'text-warning' },
  accent: { border: 'border-accent', count: 'text-accent-text' },
};

// Today's Attention tab: one row per kind of thing waiting on a decision, worst first, each linking to the page or tab
// where it gets done. Only checks this person may see are listed; clear ones fold into one quiet line, so a healthy shop
// shows a calm card instead of rows of zeros. `queue` is what useAttentionQueue returns (Dashboard owns the hook so the tab's
// badge and this list can't disagree).
export default function AttentionQueue({ queue }) {
  const { items, quiet, isLoading } = queue;

  if (isLoading) return <SkeletonCards count={3} className="md:grid-cols-3" />;

  if (items.length === 0 && quiet.length === 0) {
    return (
      <div className="bg-surface border border-line rounded-xl p-4 sm:p-5">
        <div className="font-display font-700">Nothing to review</div>
        <p className="text-sm text-text-muted mt-0.5">Nothing is routed to your role for a decision.</p>
      </div>
    );
  }

  return (
    <section aria-label="Waiting on a decision">
      {items.length > 0 ? (
        <>
          <ul className="space-y-3">
            {items.map(({ id, label, count, detail, to, tone }) => {
              const t = TONE[tone] || TONE.accent;
              return (
                <li key={id}>
                  <Link to={to} className={`flex items-center gap-4 rounded-xl border bg-surface px-4 py-4 sm:px-5 transition-colors hover:border-text ${t.border}`}>
                    <span className={`font-display font-700 tracking-tight tabular-nums text-3xl min-w-[2ch] text-right ${t.count}`}>{count}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-display font-600 leading-tight">{label}</span>
                      <span className="block text-xs text-text-muted mt-0.5">{detail}</span>
                    </span>
                    <ChevronRight size={18} className="text-text-muted shrink-0" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {quiet.length > 0 && (
            <p className="flex items-start gap-2 text-xs text-text-muted mt-4">
              <CircleCheck size={14} className="text-success shrink-0 mt-px" aria-hidden="true" />
              <span>All clear: {quiet.join(', ')}.</span>
            </p>
          )}
        </>
      ) : (
        <div className="bg-surface border border-line rounded-xl p-4 sm:p-5 flex items-start gap-3">
          <CircleCheck size={20} className="text-success shrink-0" aria-hidden="true" />
          <div>
            <div className="font-display font-700">All clear</div>
            <p className="text-sm text-text-muted mt-0.5">Nothing is waiting on you right now. Checked: {quiet.join(', ')}.</p>
          </div>
        </div>
      )}
    </section>
  );
}
