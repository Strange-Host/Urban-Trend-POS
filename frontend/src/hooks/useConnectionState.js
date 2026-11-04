import useConnectionStatus from './useConnectionStatus';
import useOfflineQueue from './useOfflineQueue';

// Green when the API answers, amber while sales rung up offline wait to be sent, red when the server can't be reached.
export default function useConnectionState() {
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

