import { Link } from 'react-router-dom';
import UserMenu from '../UserMenu';
import RailItem from './RailItem';

// The 64px ink rail on the left (large screens; phones get BottomBar instead). Top to bottom: the UT mark (home),
// the workspace items, then the account menu. Search, Alerts, Settings and the connection state live in the TopBar.
// The middle list scrolls if a short screen cannot fit it; the account menu never does, so it can open
// beside the rail without being clipped.
export default function Rail({ entries, activeId, homeRoute }) {
  return (
    <aside className="hidden lg:flex w-16 shrink-0 flex-col bg-ink text-white" aria-label="Main navigation">
      <Link
        to={homeRoute}
        aria-label="Urban Trends, home"
        className="mx-auto mt-3 mb-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent font-display text-xs font-bold text-accent-ink"
      >
        UT
      </Link>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1 py-1" aria-label="Workspaces">
        <ul className="space-y-0.5">
          {entries.map((e) => (
            <li key={e.id}>
              <RailItem to={e.to} label={e.label} icon={e.icon} active={activeId === e.id} />
            </li>
          ))}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-white/10 px-1 pb-2 pt-1.5">
        <UserMenu rail />
      </div>
    </aside>
  );
}
