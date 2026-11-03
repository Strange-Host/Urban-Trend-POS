import useConnectionStatus from '../hooks/useConnectionStatus';
import useOfflineQueue from '../hooks/useOfflineQueue';

// Small coloured dot for the navigation: green when the API answers, amber while
// sales rung up offline are waiting to be sent, red when the app can't reach the server.
// `withLabel` adds the words next to it (used in the wide sidebar).
export function useConnectionState() {
  const browserOnline = useConnectionStatus((s) => s.browserOnline);
  const apiReachable = useConnectionStatus((s) => s.apiReachable);
  const queued = useOfflineQueue((s) => s.queue.length);
  if (!browserOnline || !apiReachable) {
    return {
      tone: 'bg-danger',
      label: queued > 0 ? `Offline · ${queued} sale${queued === 1 ? '' : 's'} saved on this device` : 'Offline',
      short: 'Offline',
    };
  }
  if (queued > 0) {
    return { tone: 'bg-accent', label: `${queued} sale${queued === 1 ? '' : 's'} waiting to sync`, short: 'Syncing' };
  }
  return { tone: 'bg-success', label: 'Connected', short: 'Online' };
}

export default function ConnectionDot({ withLabel = false, className = '' }) {
  const { tone, label, short } = useConnectionState();
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} role="status" title={label}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${tone}`} aria-hidden="true" />
      {withLabel ? <span>{short}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
