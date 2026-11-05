import { create } from 'zustand';

// App-wide connection state for the little status dot in the navigation.
//
// Two separate signals, because either one alone lies (see useConnectivity.js):
//   - browserOnline: the browser's own online/offline events
//   - apiReachable:  whether our own API calls are actually getting answers.
//                    Updated by the axios interceptor in api/client.js: any HTTP
//                    reply (even a 4xx) proves the server is there; a request
//                    that fails with no reply at all means it is not.
//
// This is display-only. The till keeps its own state in useConnectivity for
// deciding whether to queue a sale.
/**
 * @typedef {object} ConnectionState
 * @property {boolean} browserOnline
 * @property {boolean} apiReachable
 * @property {(browserOnline: boolean) => void} setBrowserOnline
 * @property {(apiReachable: boolean) => void} setApiReachable
 */

const useConnectionStatus = /** @type {import('zustand').UseBoundStore<import('zustand').StoreApi<ConnectionState>>} */ (create((set) => ({
  browserOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  apiReachable: true,
  setBrowserOnline: (browserOnline) => set(browserOnline ? { browserOnline, apiReachable: true } : { browserOnline }),
  setApiReachable: (apiReachable) => set((s) => (s.apiReachable === apiReachable ? s : { apiReachable })),
})));

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => useConnectionStatus.getState().setBrowserOnline(true));
  window.addEventListener('offline', () => useConnectionStatus.getState().setBrowserOnline(false));
}

export default useConnectionStatus;
