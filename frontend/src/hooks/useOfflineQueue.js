import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { salesApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';

// Offline register support. A sale rung up while the API is unreachable is
// kept here (persisted to localStorage, so it survives a browser crash, a
// tab close, or the laptop being shut) and re-sent once the connection is
// back.
//
// localStorage is the right store for THIS, unlike the auth token (which
// was deliberately moved out of it — see api/client.js): a queued sale is
// business data the person already has in front of them on a paper
// receipt, not a credential an XSS could use to impersonate them. The
// tradeoff is inverted — here, surviving a crash matters more than being
// unreadable to other scripts.
//
// Every queued sale carries a clientSaleId generated at ring-up time, and
// the backend treats that as an idempotency key (see sales.service.js), so
// re-sending the same sale — after a timeout, a crash mid-request, or two
// tabs syncing at once — can never create a duplicate or double-deduct stock.

function newClientSaleId() {
  // crypto.randomUUID needs a secure context (https or localhost). A
  // register on a plain-http LAN address wouldn't have it, and silently
  // falling back to something weak would break the idempotency guarantee
  // this whole feature rests on — so fall back to crypto.getRandomValues,
  // which is available in every browser regardless of secure context.
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const useOfflineQueue = create(
  persist(
    (set, get) => ({
      queue: [],      // { clientSaleId, payload, ringedUpAt, attempts, lastError }
      syncing: false,
      lastSyncError: '',

      // Called when a checkout fails for connectivity reasons. Returns the
      // queued entry so the UI can show a provisional receipt.
      enqueue: (payload) => {
        const entry = {
          clientSaleId: payload.clientSaleId || newClientSaleId(),
          payload: { ...payload, clientSaleId: payload.clientSaleId || newClientSaleId() },
          ringedUpAt: new Date().toISOString(),
          attempts: 0,
          lastError: '',
        };
        // Keep the id on the payload and the entry identical — the payload
        // is what actually gets sent, the entry id is just for bookkeeping.
        entry.payload.clientSaleId = entry.clientSaleId;
        set({ queue: [...get().queue, entry] });
        return entry;
      },

      // Attempts to send everything queued, oldest first. Safe to call
      // repeatedly and from multiple triggers (reconnect event, interval,
      // manual button) — the `syncing` guard stops overlapping runs, and
      // the backend's idempotency key makes a double-send harmless anyway.
      sync: async () => {
        if (get().syncing) return;
        if (get().queue.length === 0) return;
        set({ syncing: true, lastSyncError: '' });

        // Sequential, not Promise.all — these are sales against shared
        // stock; sending them one at a time keeps the resulting inventory
        // movements in the same order they were rung up, and means a
        // mid-sync failure leaves a clean "these N went, these didn't"
        // split rather than a scattered partial state.
        for (const entry of [...get().queue]) {
          try {
            await salesApi.checkout(entry.payload);
            // Success (or the backend recognising an already-accepted
            // clientSaleId, which returns 201 with the original sale —
            // either way this entry is done).
            set({ queue: get().queue.filter((e) => e.clientSaleId !== entry.clientSaleId) });
          } catch (err) {
            const status = err?.response?.status;
            if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
              // A 4xx that isn't a timeout/rate-limit means this sale will
              // NEVER succeed as-is — insufficient stock, a product that
              // was deleted, a validation problem. Retrying forever would
              // block the whole queue behind it, so it's marked as failed
              // and left for a human to deal with rather than silently
              // dropped (dropping a real sale someone already took money
              // for would be much worse than showing them an error).
              set({
                queue: get().queue.map((e) =>
                  e.clientSaleId === entry.clientSaleId
                    ? { ...e, failed: true, attempts: e.attempts + 1, lastError: getErrorMessage(err, 'Rejected by server.') }
                    : e
                ),
              });
              continue;
            }
            // Network error or 5xx — still worth retrying later. Stop the
            // whole run here: if the connection is down, the next entries
            // will fail the same way, and hammering them just burns time.
            set({
              syncing: false,
              lastSyncError: getErrorMessage(err, 'Still offline — will retry.'),
              queue: get().queue.map((e) =>
                e.clientSaleId === entry.clientSaleId
                  ? { ...e, attempts: e.attempts + 1, lastError: getErrorMessage(err, 'Network error.') }
                  : e
              ),
            });
            return;
          }
        }
        set({ syncing: false });
      },

      // For a sale the server permanently rejected: the cashier has seen
      // the error and dealt with it (re-rung it, refunded the customer),
      // so it can finally leave the queue. Deliberately manual — nothing
      // discards a real sale automatically.
      discard: (clientSaleId) =>
        set({ queue: get().queue.filter((e) => e.clientSaleId !== clientSaleId) }),

      pendingCount: () => get().queue.filter((e) => !e.failed).length,
      failedCount: () => get().queue.filter((e) => e.failed).length,
    }),
    {
      name: 'ut_offline_sales',
      // `syncing` is per-session state, not something to restore from a
      // previous page load — a tab that was mid-sync when it closed would
      // otherwise come back permanently stuck with syncing: true and
      // refuse to ever sync again.
      partialize: (state) => ({ queue: state.queue }),
    }
  )
);

export { newClientSaleId };
export default useOfflineQueue;
