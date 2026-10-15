import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { productsApi, salesApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import useCartStore from '../hooks/useCartStore';
import useOfflineQueue, { newClientSaleId } from '../hooks/useOfflineQueue';
import useConnectivity from '../hooks/useConnectivity';
import ShiftWidget from '../components/ShiftWidget';
import PrintReceiptButton from '../components/PrintReceipt';

// A failed request is only safe to queue offline if it failed because the
// server never processed it. A 4xx means the server DID process it and
// said no (out of stock, validation) — queueing that would mean retrying
// forever against a rejection that will never change.
function isConnectivityFailure(err) {
  if (err?.response) {
    const s = err.response.status;
    return s === 408 || s === 429 || s >= 500; // timeout, rate-limited, or server-side fault
  }
  return true; // no response at all — network down, DNS failure, connection refused
}

export default function POSTerminal() {
  const [search, setSearch] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [lastReceipt, setLastReceipt] = useState(null);
  const [cartOpen, setCartOpen] = useState(false); // mobile-only: cart as a slide-up sheet
  const barcodeRef = useRef(null);
  const queryClient = useQueryClient();

  const { items, addItem, updateQuantity, removeItem, clear, totals } = useCartStore();
  const { online, reportApiReachable, reportApiUnreachable } = useConnectivity();
  const enqueue = useOfflineQueue((s) => s.enqueue);
  const syncQueue = useOfflineQueue((s) => s.sync);
  const queue = useOfflineQueue((s) => s.queue);
  const syncing = useOfflineQueue((s) => s.syncing);
  const discardQueued = useOfflineQueue((s) => s.discard);

  const pendingCount = queue.filter((e) => !e.failed).length;
  const failedEntries = queue.filter((e) => e.failed);

  const { data, isLoading } = useQuery({
    queryKey: ['products', search],
    queryFn: () => productsApi.list({ q: search, pageSize: 20 }).then((r) => r.data),
    staleTime: 15_000,
    // Offline support: keep serving the last successfully-fetched product
    // list instead of showing an error page, so the register can still
    // ring up items from the catalogue it already has. gcTime keeps that
    // cache around for a full day rather than the default 5 minutes.
    gcTime: 24 * 60 * 60 * 1000,
    retry: (failureCount, err) => isConnectivityFailure(err) && failureCount < 2,
    placeholderData: (prev) => prev,
  });

  // Barcode scanners behave like fast keyboard input ending in Enter.
  async function handleBarcodeSubmit(e) {
    e.preventDefault();
    const code = barcodeRef.current.value.trim();
    if (!code) return;
    try {
      const { data } = await productsApi.getByBarcode(code);
      addItem(data.data);
      barcodeRef.current.value = '';
    } catch (err) {
      // Barcode lookup is the one thing that genuinely can't work offline
      // for a product that isn't already in the on-screen list — it's a
      // per-code server lookup, not something the cached list covers.
      if (isConnectivityFailure(err)) {
        setCheckoutError('Offline — barcode lookup needs a connection. Tap the product from the list instead.');
      } else {
        setCheckoutError(`No product found for barcode ${code}.`);
      }
      setTimeout(() => setCheckoutError(''), 4000);
    }
  }

  const { subtotal, total } = totals();

  async function handleCheckout() {
    if (items.length === 0) return;
    setCheckingOut(true);
    setCheckoutError('');

    // Generated before the first attempt, not after a failure — this is
    // what makes a retry idempotent server-side (see sales.service.js).
    // If the request is sent but the response is lost, the retry carries
    // the SAME id and the backend recognises it rather than charging twice.
    const clientSaleId = newClientSaleId();
    const payload = {
      items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
      payments: [{ method: paymentMethod, amount: total }],
      clientSaleId,
    };

    try {
      const { data } = await salesApi.checkout(payload);
      reportApiReachable();
      setLastReceipt({ ...data.data, queued: false });
      clear();
      setCartOpen(false);
      queryClient.invalidateQueries({ queryKey: ['products'] });
    } catch (err) {
      if (isConnectivityFailure(err)) {
        // The sale is real — the customer is paying right now. Keep it
        // locally and send it when the connection is back, rather than
        // making the cashier either lose it or re-key it later.
        reportApiUnreachable();
        enqueue(payload);
        setLastReceipt({ id: null, total, queued: true, clientSaleId });
        clear();
        setCartOpen(false);
      } else {
        // Server processed it and rejected it (out of stock, etc.) —
        // surface that immediately; the cart stays as-is so the cashier
        // can fix it.
        reportApiReachable();
        setCheckoutError(getErrorMessage(err, 'Checkout failed. Please try again.'));
      }
    } finally {
      setCheckingOut(false);
    }
  }

  // If the cart empties out (checkout, or removing the last item) while the
  // mobile sheet happens to be open, close it rather than showing an empty sheet.
  useEffect(() => {
    if (items.length === 0) setCartOpen(false);
  }, [items.length]);

  // Desktop registers pair with a physical barcode scanner that needs this
  // field focused to capture its keystrokes — worth auto-focusing there.
  // On mobile there's no scanner, and auto-focusing would just pop the
  // on-screen keyboard open over half the screen on every visit.
  useEffect(() => {
    if (window.matchMedia('(min-width: 1280px)').matches) {
      barcodeRef.current?.focus();
    }
  }, []);

  const cartLabel = items.reduce((n, i) => n + i.quantity, 0);

  return (
    <div className="flex flex-col xl:flex-row h-full relative">
      {/* Product browsing */}
      <div className="flex-1 flex flex-col p-4 xl:p-6 overflow-hidden pb-24 xl:pb-6">
        <ShiftWidget />

        {/* Offline / sync status. Deliberately prominent — a cashier needs
            to know they're selling against a stock count that may be stale,
            since nothing can validate availability while the API is
            unreachable. */}
        {!online && (
          <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">
            <strong>Offline.</strong> Sales are being saved on this device and will send
            automatically when the connection returns. Stock counts shown may be out of date,
            and stock can't be checked until then.
          </div>
        )}
        {online && pendingCount > 0 && (
          <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-accent/15 text-sm flex items-center justify-between gap-3">
            <span>
              {syncing ? 'Sending' : 'Waiting to send'} {pendingCount} offline sale{pendingCount === 1 ? '' : 's'}…
            </span>
            {!syncing && (
              <button onClick={() => syncQueue()} className="underline shrink-0">Retry now</button>
            )}
          </div>
        )}
        {failedEntries.length > 0 && (
          <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">
            <strong>{failedEntries.length} offline sale{failedEntries.length === 1 ? '' : 's'} the server rejected.</strong>
            <ul className="mt-1.5 space-y-1">
              {failedEntries.map((e) => (
                <li key={e.clientSaleId} className="flex items-start justify-between gap-3 font-mono text-xs">
                  <span>
                    {new Date(e.ringedUpAt).toLocaleString()} — {(e.payload.payments[0].amount / 100).toFixed(2)}: {e.lastError}
                  </span>
                  <button onClick={() => discardQueued(e.clientSaleId)} className="underline shrink-0">Dismiss</button>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs">
              These were rung up but couldn't be recorded — re-ring them if the goods left the shop,
              then dismiss. Nothing is discarded automatically.
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 mb-5">
          <input
            type="text"
            placeholder="Search by name or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-4 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none"
          />
          <form onSubmit={handleBarcodeSubmit}>
            <input
              ref={barcodeRef}
              type="text"
              placeholder="Scan barcode + Enter"
              className="w-full sm:w-56 px-4 py-2.5 rounded-lg border border-line bg-surface font-mono text-sm focus:border-accent outline-none"
            />
          </form>
        </div>

        {checkoutError && (
          <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">
            {checkoutError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 content-start">
          {isLoading && <div className="text-text-muted text-sm">Loading products…</div>}
          {data?.data.map((p) => (
            <button
              key={p.id}
              onClick={() => addItem(p)}
              disabled={p.total_stock <= 0}
              className="text-left bg-surface border border-line rounded-xl p-4 hover:border-accent hover:shadow-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="text-sm font-medium leading-snug mb-1">{p.name}</div>
              <div className="text-xs text-text-muted font-mono mb-3">{p.sku}</div>
              <div className="flex items-end justify-between">
                <div className="font-display font-700 text-lg">
                  {(p.sell_price / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' })}
                </div>
                <div className={`text-xs font-mono ${p.total_stock <= 5 ? 'text-danger' : 'text-text-muted'}`}>
                  {p.total_stock} left
                </div>
              </div>
            </button>
          ))}
          {data && data.data.length === 0 && (
            <div className="col-span-full text-text-muted text-sm py-12 text-center">
              No products match "{search}".
            </div>
          )}
        </div>
      </div>

      {/* Mobile-only: floating bar that opens the cart as a sheet. Hidden on
          desktop, where the cart panel to the right is always visible instead. */}
      {items.length > 0 && !cartOpen && (
        <button
          onClick={() => setCartOpen(true)}
          className="xl:hidden fixed bottom-4 inset-x-4 z-30 bg-ink text-white rounded-xl py-3.5 px-5 flex items-center justify-between shadow-lg"
        >
          <span className="font-mono text-sm">{cartLabel} item{cartLabel === 1 ? '' : 's'} in cart</span>
          <span className="font-display font-700">{(total / 100).toFixed(2)} · View cart</span>
        </button>
      )}

      {/* Backdrop for the mobile cart sheet */}
      {cartOpen && (
        <button
          aria-label="Close cart"
          onClick={() => setCartOpen(false)}
          className="xl:hidden fixed inset-0 z-40 bg-black/40"
        />
      )}

      {/* Cart — receipt strip signature element. Always-visible sidebar on
          desktop; slide-up sheet toggled by the floating bar on mobile. */}
      <div
        className={`
          fixed inset-x-0 bottom-0 z-50 max-h-[88vh] rounded-t-2xl
          xl:static xl:z-auto xl:max-h-none xl:rounded-none xl:w-96
          w-full shrink-0 bg-ink flex flex-col
          transform transition-transform duration-200 ease-out
          ${cartOpen ? 'translate-y-0' : 'translate-y-full'} xl:translate-y-0
        `}
      >
        <div className="bg-surface receipt-perforation" />
        <div className="flex-1 flex flex-col bg-surface px-5 pb-5 overflow-hidden">
          <div className="font-mono text-xs text-text-muted py-3 border-b border-dashed border-line flex justify-between items-center">
            <span>URBAN TRENDS</span>
            <span>{new Date().toLocaleDateString()}</span>
            <button
              onClick={() => setCartOpen(false)}
              aria-label="Close cart"
              className="xl:hidden -mr-2 p-1 text-text-muted hover:text-text"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-3 space-y-3">
            {items.length === 0 && (
              <div className="text-text-muted text-sm text-center py-16">
                Cart is empty.<br />Tap a product or scan a barcode.
              </div>
            )}
            {items.map((item) => (
              <div key={item.product_id} className="font-mono text-sm">
                <div className="flex justify-between">
                  <span className="truncate pr-2">{item.name}</span>
                  <button
                    onClick={() => removeItem(item.product_id)}
                    className="text-danger text-xs shrink-0"
                    aria-label={`Remove ${item.name}`}
                  >
                    ✕
                  </button>
                </div>
                <div className="flex justify-between items-center text-text-muted">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateQuantity(item.product_id, item.quantity - 1)}
                      className="w-7 h-7 xl:w-5 xl:h-5 rounded bg-paper hover:bg-line flex items-center justify-center"
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-text">{item.quantity}</span>
                    <button
                      onClick={() => updateQuantity(item.product_id, item.quantity + 1)}
                      className="w-7 h-7 xl:w-5 xl:h-5 rounded bg-paper hover:bg-line flex items-center justify-center"
                    >
                      +
                    </button>
                    <span className="text-xs">× {(item.unit_price / 100).toFixed(0)}</span>
                  </div>
                  <span className="text-text">{((item.unit_price * item.quantity) / 100).toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-dashed border-line pt-3 font-mono text-sm space-y-1">
            <div className="flex justify-between text-text-muted">
              <span>Subtotal</span><span>{(subtotal / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-display font-700 text-xl pt-1">
              <span>Total</span><span>{(total / 100).toFixed(2)}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 mt-4">
            {['cash', 'card', 'mobile_money'].map((m) => (
              <button
                key={m}
                onClick={() => setPaymentMethod(m)}
                className={`py-2.5 xl:py-2 rounded-lg text-xs font-medium capitalize border transition-colors ${
                  paymentMethod === m
                    ? 'bg-accent border-accent text-accent-ink'
                    : 'border-line text-text-muted hover:border-text-muted'
                }`}
              >
                {m.replace('_', ' ')}
              </button>
            ))}
          </div>

          {/* The accent action bar: item count + total on the left, the
              charge action on the right. Promoted from mobile-only to the
              signature element on every size — a cashier's eye should land
              on one high-contrast block, not hunt for a button. This is the
              ONE piece of the restyle that touches the terminal; everything
              else here (light surface, big tap targets, product grid) stays
              exactly as it was, deliberately. */}
          <div className="mt-3 rounded-xl bg-accent text-accent-ink px-4 py-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-wider opacity-70 leading-tight">
                {cartLabel} item{cartLabel === 1 ? '' : 's'}
                {subtotal !== total && ` · subtotal ${(subtotal / 100).toFixed(2)}`}
              </div>
              <div className="font-display font-700 text-2xl leading-tight">{(total / 100).toFixed(2)}</div>
            </div>
            <button
              onClick={handleCheckout}
              disabled={items.length === 0 || checkingOut}
              className="shrink-0 px-5 py-3 rounded-lg bg-ink text-white font-display font-600 text-sm hover:bg-ink-soft transition-colors disabled:opacity-40"
            >
              {checkingOut ? 'Processing…' : 'Charge'}
            </button>
          </div>

          {lastReceipt && (
            lastReceipt.queued ? (
              <div className="mt-3 px-3 py-2 rounded-lg bg-accent/15 text-xs font-mono">
                Sale saved offline — {(lastReceipt.total / 100).toFixed(2)} taken.
                It will be recorded automatically once the connection is back.
              </div>
            ) : (
              <div className="mt-3 px-3 py-2 rounded-lg bg-success-soft text-success text-xs font-mono flex items-center justify-between gap-2">
                <span>Sale #{lastReceipt.id} completed — {(lastReceipt.total / 100).toFixed(2)} paid.</span>
                <PrintReceiptButton kind="sale" id={lastReceipt.id} label="Print receipt" className="shrink-0 px-2.5 py-1 rounded-md bg-ink text-white text-[11px] font-medium disabled:opacity-50" />
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
