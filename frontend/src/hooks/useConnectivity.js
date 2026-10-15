import { useState, useEffect } from 'react';
import useOfflineQueue from './useOfflineQueue';

// navigator.onLine is necessary but NOT sufficient: it only reports
// whether the device has *a* network connection, not whether this app's
// API is actually reachable. A register connected to shop wifi whose
// router has lost its upstream link, or one where the backend process is
// down, reports onLine === true while every request fails. So this tracks
// both: the browser's own signal, and whether our own requests are
// actually succeeding (reported by the POS terminal via
// reportApiReachable/reportApiUnreachable).
export default function useConnectivity() {
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [apiReachable, setApiReachable] = useState(true);
  const sync = useOfflineQueue((s) => s.sync);
  const queueLength = useOfflineQueue((s) => s.queue.length);

  useEffect(() => {
    function handleOnline() {
      setBrowserOnline(true);
      setApiReachable(true); // optimistic — the next real request confirms or corrects this
      sync();
    }
    function handleOffline() {
      setBrowserOnline(false);
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [sync]);

  // The 'online' event alone isn't enough to rely on: it doesn't fire when
  // the API comes back but the device's network never technically dropped
  // (backend restart, router upstream restored). A slow poll while
  // anything is queued covers that case without being chatty — it only
  // runs when there's actually something waiting to send.
  useEffect(() => {
    if (queueLength === 0) return;
    const id = setInterval(() => { sync(); }, 30_000);
    return () => clearInterval(id);
  }, [queueLength, sync]);

  return {
    online: browserOnline && apiReachable,
    browserOnline,
    reportApiReachable: () => setApiReachable(true),
    reportApiUnreachable: () => setApiReachable(false),
  };
}
