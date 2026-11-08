import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import NotificationBell from '../NotificationBell';
import StatusLine from './StatusLine';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

// The bar across the top of the page area (large screens only; phones keep the bottom bar and its More panel).
// Left: the status line (branch · connection · shift). Right: Search, Alerts and Settings, which used to crowd the
// bottom of the rail. The Search pill opens the same "go to…" palette as Ctrl/Cmd+K.
export default function TopBar({ settings, activeId, onSearch }) {
  const SettingsIcon = settings?.icon;
  const settingsActive = activeId === 'settings';

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface px-6">
      <div className="min-w-0 flex-1 max-h-9 overflow-hidden">
        <StatusLine inline />
      </div>

      <div role="toolbar" aria-label="Quick actions" className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search pages"
          title="Search · Ctrl K"
          className="mr-1 flex h-9 w-56 items-center gap-2 rounded-lg border border-line bg-paper px-3 text-sm text-text-muted transition-colors hover:border-text-muted/50 hover:text-text xl:w-72"
        >
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="flex-1 text-left">Search pages</span>
          <kbd className="rounded border border-line bg-surface px-1.5 py-px font-mono text-[10px] leading-4">{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </button>

        <NotificationBell anchor="topbar" tone="light" />

        {settings && (
          <Link
            to={settings.to}
            aria-label={settings.label}
            title={settings.label}
            aria-current={settingsActive ? 'page' : undefined}
            className={`grid h-9 w-9 place-items-center rounded-lg transition-colors ${
              settingsActive ? 'bg-accent text-accent-ink' : 'text-text-muted hover:bg-paper hover:text-text'
            }`}
          >
            <SettingsIcon size={20} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        )}
      </div>
    </header>
  );
}
