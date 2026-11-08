import { useQuery } from '@tanstack/react-query';
import { Clock, Store } from 'lucide-react';
import { cashSessionsApi, storesApi } from '../../api/endpoints';
import { useAuth } from '../../context/AuthContext';
import ConnectionDot from '../ConnectionDot';

// Roles that work at a till and so have a shift to report on (the storekeeper does not).
const SHIFT_ROLES = ['admin', 'manager', 'cashier'];

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "Main Branch · Online · Shift open since 08:12": where you are, whether the app can reach the server, and the state of
// your shift, in one quiet line. It is read-only; the shift itself is still opened and closed on the till.
// `inline` drops the outer padding, for when a page's header draws it under the title; otherwise the shell draws it
// above pages that have no header of their own (the till).
// Both lookups are best-effort: if either fails, that part is simply left out, never an error on every page.
// `chips` draws each part as a small pill instead of dotted text (the top bar on large screens).
export default function StatusLine({ inline = false, chips = false }) {
  const { user } = useAuth();

  const { data: stores } = useQuery({
    queryKey: ['stores'],
    queryFn: () => storesApi.list().then((r) => r.data.data),
    staleTime: 60_000,
    retry: false,
  });
  const { data: session, isSuccess: shiftKnown } = useQuery({
    queryKey: ['cash-session-current'],
    queryFn: () => cashSessionsApi.current().then((r) => r.data.data),
    refetchInterval: 30_000,
    enabled: SHIFT_ROLES.includes(user?.role),
    retry: false,
  });

  const branch = Array.isArray(stores) ? stores.find((b) => b.is_current)?.name : null;
  const shift = !shiftKnown ? null : session ? `Shift open since ${clock(session.opened_at)}` : 'No shift open';
  const shiftOpen = Boolean(session);
  const pill = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium';

  if (chips) {
    return (
      <div aria-label="Status" className="flex flex-wrap items-center gap-2 text-text">
        {branch && (
          <span className={`${pill} border-line bg-paper`}>
            <Store size={13} strokeWidth={1.75} className="text-text-muted" aria-hidden="true" />
            {branch}
          </span>
        )}
        <span className={`${pill} border-line bg-paper`}><ConnectionDot withLabel /></span>
        {shift && (
          <span className={`${pill} ${shiftOpen ? 'border-accent/50 bg-accent/10' : 'border-line bg-paper text-text-muted'}`}>
            <Clock size={13} strokeWidth={1.75} className={shiftOpen ? '' : 'text-text-muted'} aria-hidden="true" />
            {shift}
          </span>
        )}
      </div>
    );
  }

  const parts = [
    branch && <span key="branch">{branch}</span>,
    <ConnectionDot key="conn" withLabel />,
    shift && <span key="shift">{shift}</span>,
  ].filter(Boolean);

  return (
    <div
      aria-label="Status"
      className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted ${
        inline ? '' : 'px-4 pb-1 pt-[calc(env(safe-area-inset-top)+0.5rem)] lg:px-6 lg:pt-3'
      }`}
    >
      {parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`dot-${i}`} aria-hidden="true">·</span>, part]))}
    </div>
  );
}
