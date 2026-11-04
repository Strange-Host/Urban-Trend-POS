import { useQuery } from '@tanstack/react-query';
import { staffApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Sheet from './Sheet';
import { LoadingBlock } from './Skeleton';

const when = (ts) => (ts ? new Date(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z')).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// One staff member's record plus, for admins, where they are signed in right now. The session list is admin-only on
// the server, so it is not requested (or shown) for anyone else.
export default function StaffDetailSheet({ staff, onClose }) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');

  const person = useQuery({
    queryKey: ['staff', 'detail', staff.id],
    queryFn: () => staffApi.getById(staff.id).then((r) => r.data.data),
  });
  const sessions = useQuery({
    queryKey: ['staff', 'sessions', staff.id],
    queryFn: () => staffApi.sessions(staff.id).then((r) => r.data.data),
    enabled: isAdmin,
  });
  const p = person.data || staff;

  return (
    <Sheet onClose={onClose} size="md" label={`Details for ${staff.name}`}>
      <h2 className="font-display font-700 text-lg">{p.name}</h2>
      <p className="text-sm text-text-muted mb-4 capitalize">{p.role} · {p.erased ? 'erased' : p.status}</p>

      {person.isError && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(person.error, 'Could not load this staff member.')}</div>}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-5">
        <dt className="text-text-muted">Email</dt><dd className="break-all">{p.email || '—'}</dd>
        <dt className="text-text-muted">Phone</dt><dd>{p.phone || '—'}</dd>
        <dt className="text-text-muted">Added</dt><dd>{p.created_at ? when(p.created_at) : '—'}</dd>
      </dl>

      {isAdmin && (
        <section>
          <h3 className="text-xs font-medium text-text-muted mb-2">Signed-in devices</h3>
          {sessions.isLoading && <LoadingBlock />}
          {sessions.isError && <p className="text-sm text-danger">{getErrorMessage(sessions.error, 'Could not load sessions.')}</p>}
          {sessions.data?.length === 0 && <p className="text-sm text-text-muted">Not signed in anywhere.</p>}
          <ul className="space-y-2">
            {sessions.data?.map((s) => (
              <li key={s.id} className="rounded-lg border border-line px-3 py-2 text-sm">
                <div className="font-medium">{s.device || 'Unknown device'}{s.state === 'locked' && <span className="ml-2 text-xs text-text-muted">locked</span>}</div>
                <div className="text-xs text-text-muted">
                  {s.ip ? `${s.ip} · ` : ''}signed in {when(s.signedInAt)} · last active {when(s.lastActiveAt)}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button type="button" onClick={onClose} className="w-full mt-5 py-2.5 rounded-lg border border-line text-sm font-medium">Close</button>
    </Sheet>
  );
}
