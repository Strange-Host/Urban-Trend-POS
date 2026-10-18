import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi } from '../api/endpoints';
import { useToast } from '../context/UIContext';
import { getErrorMessage } from '../api/client';

// Where clicking a notification should take you. Only places the recipient of
// that kind of notice can actually open (e.g. unmatched payments go to
// admins/managers, who have /reconciliation).
const DESTINATIONS = {
  lead: '/leads',
  order: '/orders',
  sale: '/sales',
  payment_notification: '/reconciliation',
  security_event: '/security',
  product: '/catalog',
  backup: '/settings', // backup and off-site copy failure notices (admins)
};

const SEVERITY_DOT = {
  urgent: 'bg-danger',
  warning: 'bg-accent',
  info: 'bg-text-muted',
};

// "just now", "5 min ago", "3 h ago", "2 d ago". SQLite's datetime('now') is
// UTC with no zone marker, so it is parsed explicitly as UTC.
function timeAgo(sqliteUtc) {
  if (!sqliteUtc) return '';
  const then = new Date(`${sqliteUtc.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(Math.round((Date.now() - then) / 1000), 0);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// Polls a tiny indexed count every 30s (the older system's SSE channel never
// connected, and EventSource can't send an Authorization header anyway). The
// full list is only fetched while the panel is open.
export default function NotificationBell({ className = '' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const panelRef = useRef(null);

  const { data: unread = 0 } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => notificationsApi.unreadCount().then((r) => r.data.data.unreadCount),
    refetchInterval: 15_000,
  });

  const { data: list, isLoading } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list({ limit: 25 }).then((r) => r.data.data),
    enabled: open,
  });

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return undefined;
    // The panel is portalled to <body>, so it is no longer inside rootRef -
    // a press on the panel must count as "inside" or it would close itself.
    const onPointerDown = (e) => {
      const inside = (rootRef.current && rootRef.current.contains(e.target))
        || (panelRef.current && panelRef.current.contains(e.target));
      if (!inside) setOpen(false);
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  async function openNotification(n) {
    try {
      if (!n.read_at) await notificationsApi.markRead(n.id);
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not mark that notification as read.'));
    }
    const dest = DESTINATIONS[n.entity_type];
    if (dest) { setOpen(false); navigate(dest); }
  }

  async function markAllRead() {
    try {
      await notificationsApi.markAllRead();
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not mark notifications as read.'));
    }
  }

  const badge = unread > 99 ? '99+' : String(unread);

  return (
    <div ref={rootRef} className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
          <path d="M10.3 20a2 2 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-accent-ink text-[10px] font-bold leading-[18px] text-center">
            {badge}
          </span>
        )}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="fixed z-[80] top-[calc(3.5rem+env(safe-area-inset-top)+0.5rem)] inset-x-3 lg:inset-x-auto lg:top-4 lg:left-[15.5rem] lg:w-96 max-h-[calc(100dvh-6rem)] flex flex-col bg-surface text-text border border-line rounded-xl shadow-xl"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <div className="font-medium text-sm">Notifications</div>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unread === 0}
              className="text-xs font-medium text-text-muted hover:text-text disabled:opacity-40 disabled:hover:text-text-muted"
            >
              Mark all as read
            </button>
          </div>

          <div className="overflow-y-auto">
            {isLoading && <div className="px-4 py-6 text-sm text-text-muted">Loading…</div>}
            {!isLoading && list?.length === 0 && (
              <div className="px-4 py-8 text-sm text-text-muted text-center">Nothing needs your attention right now.</div>
            )}
            {list?.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => openNotification(n)}
                className={`w-full text-left flex gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-paper transition-colors ${n.read_at ? '' : 'bg-accent/10'}`}
              >
                <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.read_at ? 'bg-line' : SEVERITY_DOT[n.severity] || SEVERITY_DOT.info}`} aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm ${n.read_at ? 'text-text-muted' : 'font-medium'}`}>{n.title}</span>
                  {n.body && <span className="block text-xs text-text-muted mt-0.5 break-words">{n.body}</span>}
                  <span className="block text-[11px] text-text-muted mt-1">{timeAgo(n.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
