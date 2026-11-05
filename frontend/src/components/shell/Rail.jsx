import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import NotificationBell from '../NotificationBell';
import ConnectionDot from '../ConnectionDot';
import UserMenu from '../UserMenu';
import RailItem from './RailItem';

// The 76px ink rail on the left (large screens; phones get BottomBar instead). Top to bottom: the UT mark (home),
// the workspace items, then the bottom stack: Search, Alerts, Settings, the online indicator and the account menu.
// The middle list scrolls if a short screen cannot fit it; the bottom stack never does, so the account menu can open
// beside it without being clipped.
export default function Rail({ entries, settings, activeId, homeRoute, onSearch }) {
  return (
    <aside className="hidden lg:flex w-[76px] shrink-0 flex-col bg-ink text-white" aria-label="Main navigation">
      <Link
        to={homeRoute}
        aria-label="Urban Trends, home"
        className="mx-auto mt-4 mb-3 grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent font-display text-sm font-bold text-accent-ink"
      >
        UT
      </Link>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1" aria-label="Workspaces">
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id}>
              <RailItem to={e.to} label={e.label} icon={e.icon} active={activeId === e.id} />
            </li>
          ))}
        </ul>
      </nav>

      <div className="shrink-0 space-y-1 border-t border-white/10 px-1.5 pb-3 pt-2">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search pages"
          title="Search · Ctrl K"
          className="flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Search size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="text-[11px] font-medium leading-tight">Search</span>
        </button>
        <div className="flex justify-center"><NotificationBell anchor="shell" /></div>
        {settings && <RailItem to={settings.to} label={settings.label} icon={settings.icon} active={activeId === 'settings'} />}
        <div className="flex justify-center pt-1 text-[10px] text-white/60"><ConnectionDot withLabel /></div>
        <UserMenu rail />
      </div>
    </aside>
  );
}
