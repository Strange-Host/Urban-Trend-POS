import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ellipsis, Search } from 'lucide-react';
import NotificationBell from '../NotificationBell';
import ConnectionDot from '../ConnectionDot';
import UserMenu from '../UserMenu';

const SLOTS = 4; // destinations on the bar itself; everything else goes behind "More"

const tabClass = (active) =>
  `flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 text-center transition-colors ${
    active ? 'text-accent' : 'text-white/70 hover:text-white'
  }`;

// The phone form of the rail (below lg): four destinations and a More button. More opens a panel with the rest of the
// destinations, Settings, Search, Alerts, the connection state and the account menu: everything the rail's bottom stack
// carries on a large screen.
export default function BottomBar({ entries, settings, activeId, onSearch }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const bar = entries.slice(0, SLOTS);
  const overflow = entries.slice(SLOTS);
  const moreActive = [...overflow.map((e) => e.id), ...(settings ? ['settings'] : [])].includes(activeId);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMoreOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const close = () => setMoreOpen(false);
  const rowClass = (active) =>
    `flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm ${active ? 'bg-accent text-accent-ink' : 'text-white/80 hover:bg-white/10'}`;

  return (
    <div className="lg:hidden">
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-30 flex bg-ink pb-[env(safe-area-inset-bottom)] text-white"
      >
        {bar.map((e) => (
          <Link key={e.id} to={e.to} aria-current={activeId === e.id ? 'page' : undefined} className={tabClass(activeId === e.id)}>
            <e.icon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-[11px] font-medium leading-tight">{e.label}</span>
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={tabClass(moreActive)}
        >
          <Ellipsis size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="text-[11px] font-medium leading-tight">More</span>
        </button>
      </nav>

      {moreOpen && (
        <>
          <button type="button" aria-label="Close menu" onClick={close} className="fixed inset-0 z-40 bg-black/40" />
          <div
            role="dialog"
            aria-label="More"
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl bg-ink text-white shadow-2xl"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-3">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { close(); onSearch(); }}
                  aria-label="Search pages"
                  className="grid h-11 w-11 place-items-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
                >
                  <Search size={20} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <NotificationBell anchor="shell" />
              </div>
              <ConnectionDot withLabel className="text-xs text-white/60" />
            </div>

            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-1">
              {overflow.map((e) => (
                <li key={e.id}>
                  <Link to={e.to} onClick={close} aria-current={activeId === e.id ? 'page' : undefined} className={rowClass(activeId === e.id)}>
                    <e.icon size={18} strokeWidth={1.75} aria-hidden="true" /> {e.label}
                  </Link>
                </li>
              ))}
              {settings && (
                <li>
                  <Link to={settings.to} onClick={close} aria-current={activeId === 'settings' ? 'page' : undefined} className={rowClass(activeId === 'settings')}>
                    <settings.icon size={18} strokeWidth={1.75} aria-hidden="true" /> {settings.label}
                  </Link>
                </li>
              )}
            </ul>

            {/* No overflow clipping here: the account menu opens upwards from this row. */}
            <div className="shrink-0 border-t border-white/10 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2">
              <UserMenu onNavigate={close} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
