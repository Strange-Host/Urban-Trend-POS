import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { categoriesApi, productsApi, salesApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import useCartStore from '../hooks/useCartStore';
import useOfflineQueue, { newClientSaleId } from '../hooks/useOfflineQueue';
import useConnectivity from '../hooks/useConnectivity';
import ShiftWidget from '../components/ShiftWidget';
import TillBanners from '../components/till/TillBanners';
import Ticket from '../components/till/Ticket';
import CategoryColumn from '../components/till/CategoryColumn';
import { discountExceedsLimit } from '../utils/discount';
import { loadPrinter, printReceiptDirectIfEnabled } from '../utils/printer';
import { useToast } from '../context/UIContext';
import { emptyPayment, clearedPayment, buildPayments } from '../utils/splitPayment';

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
  // One method for the whole sale, or a split (e.g. Cash + M-Pesa): see utils/splitPayment.js.
  const [payment, setPayment] = useState(() => emptyPayment());
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [lastReceipt, setLastReceipt] = useState(null);
  const toast = useToast();
  const [cartOpen, setCartOpen] = useState(false); // mobile-only: cart as a slide-up sheet
  const barcodeRef = useRef(null);
  const queryClient = useQueryClient();

  const { items, addItem, updateQuantity, removeItem, clear, totals, setDiscount } = useCartStore();
  const [categoryId, setCategoryId] = useState(null);

  // The Start screen's End shift tile and the rail's Shift item arrive here as ?shift=close. Each arrival bumps a counter the
  // shift widget watches (it opens its close form once the open shift is known), and the request is dropped from the address
  // so a refresh does not reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  const wantsClose = searchParams.get('shift') === 'close';
  const [closeRequest, setCloseRequest] = useState(0);
  useEffect(() => {
    if (!wantsClose) return;
    setCloseRequest((n) => n + 1);
    setSearchParams((p) => { p.delete('shift'); return p; }, { replace: true });
  }, [wantsClose, setSearchParams]);
  const { online, reportApiReachable, reportApiUnreachable } = useConnectivity();
  const enqueue = useOfflineQueue((s) => s.enqueue);
  const syncQueue = useOfflineQueue((s) => s.sync);
  const queue = useOfflineQueue((s) => s.queue);
  const syncing = useOfflineQueue((s) => s.syncing);
  const discardQueued = useOfflineQueue((s) => s.discard);

  const pendingCount = queue.filter((e) => !e.failed).length;
  const failedEntries = queue.filter((e) => e.failed);

  // Same offline treatment as the product list: keep the last answer for a day, retry only real connection failures.
  const keepForOffline = {
    staleTime: 5 * 60_000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: (failureCount, err) => isConnectivityFailure(err) && failureCount < 2,
  };
  const { data: categoryData } = useQuery({
    queryKey: ['till-categories'],
    queryFn: () => categoriesApi.list().then((r) => r.data.data),
    ...keepForOffline,
  });
  const categories = categoryData || [];
  // This person's own cap on discounts (percent, 0 = none). Only used to warn before charging; the server enforces it.
  const { data: maxPercent = 0 } = useQuery({
    queryKey: ['discount-limit'],
    queryFn: () => salesApi.discountLimit().then((r) => r.data.data.maxPercent),
    ...keepForOffline,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['products', search, categoryId],
    queryFn: () => productsApi.list({ q: search, category_id: categoryId || undefined, pageSize: 60 }).then((r) => r.data),
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

  const { subtotal, discount, total } = totals();
  const built = buildPayments(payment, total);
  const discountTooBig = discountExceedsLimit({ discount, subtotal, maxPercent });

  async function handleCheckout() {
    if (items.length === 0 || discountTooBig) return;
    if (built.error) { setCheckoutError(built.error); return; }
    setCheckingOut(true);
    setCheckoutError('');

    // Generated before the first attempt, not after a failure — this is
    // what makes a retry idempotent server-side (see sales.service.js).
    // If the request is sent but the response is lost, the retry carries
    // the SAME id and the backend recognises it rather than charging twice.
    const clientSaleId = newClientSaleId();
    const payload = {
      items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
      ...(discount > 0 ? { discountTotal: discount } : {}),
      payments: built.payments,
      clientSaleId,
    };

    try {
      const { data } = await salesApi.checkout(payload);
      reportApiReachable();
      setLastReceipt({ ...data.data, queued: false });
      // A till set up for direct printing prints (and opens the drawer) the moment the sale is charged.
      if (loadPrinter().autoPrint) printReceiptDirectIfEnabled('sale', data.data.id, toast);
      clear();
      setPayment(clearedPayment);
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
        setPayment(clearedPayment);
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
    <div className="relative flex h-full flex-col">
      <TillBanners
        online={online}
        pendingCount={pendingCount}
        syncing={syncing}
        onRetry={() => syncQueue()}
        failedEntries={failedEntries}
        onDiscard={discardQueued}
      />

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <CategoryColumn
          categories={categories}
          activeId={categoryId}
          onSelect={setCategoryId}
          top={<ShiftWidget closeRequest={closeRequest} />}
        />

        {/* Product browsing */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-4 pb-24 xl:p-6 xl:pb-6">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              placeholder="Search by name or SKU…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 rounded-lg border border-line bg-surface px-4 py-2.5 outline-none focus:border-accent"
            />
            <form onSubmit={handleBarcodeSubmit}>
              <input
                ref={barcodeRef}
                type="text"
                placeholder="Scan barcode + Enter"
                className="w-full rounded-lg border border-line bg-surface px-4 py-2.5 font-mono text-sm outline-none focus:border-accent sm:w-56"
              />
            </form>
          </div>

          {checkoutError && (
            <div className="mb-4 rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
              {checkoutError}
            </div>
          )}

          <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto sm:grid-cols-3">
            {isLoading && <div className="text-sm text-text-muted">Loading products…</div>}
            {data?.data.map((p) => (
              <button
                key={p.id}
                onClick={() => addItem(p)}
                disabled={p.total_stock <= 0}
                className="rounded-xl border border-line bg-surface p-4 text-left transition-all hover:border-accent hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
              >
                <div className="mb-1 text-sm font-medium leading-snug">{p.name}</div>
                <div className="mb-3 font-mono text-xs text-text-muted">{p.sku}</div>
                <div className="flex items-end justify-between">
                  <div className="font-display font-700 text-lg">
                    {(p.sell_price / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' })}
                  </div>
                  <div className={`font-mono text-xs ${p.total_stock <= 5 ? 'text-danger' : 'text-text-muted'}`}>
                    {p.total_stock} left
                  </div>
                </div>
              </button>
            ))}
            {data && data.data.length === 0 && (
              <div className="col-span-full py-12 text-center text-sm text-text-muted">
                No products match{search ? ` "${search}"` : ' this category'}.
              </div>
            )}
          </div>
        </div>

        {/* Mobile-only: floating bar that opens the cart as a sheet. Hidden on
            desktop, where the ticket to the right is always visible instead. */}
        {items.length > 0 && !cartOpen && (
          <button
            onClick={() => setCartOpen(true)}
            className="fixed inset-x-4 bottom-4 z-30 flex items-center justify-between rounded-xl bg-ink px-5 py-3.5 text-white shadow-lg xl:hidden"
          >
            <span className="font-mono text-sm">{cartLabel} item{cartLabel === 1 ? '' : 's'} in cart</span>
            <span className="font-display font-700">{(total / 100).toFixed(2)} · View cart</span>
          </button>
        )}

        {/* Backdrop for the mobile cart sheet */}
        {cartOpen && (
          <button aria-label="Close cart" onClick={() => setCartOpen(false)} className="fixed inset-0 z-40 bg-black/40 xl:hidden" />
        )}

        <Ticket
          open={cartOpen}
          onClose={() => setCartOpen(false)}
          items={items}
          itemCount={cartLabel}
          subtotal={subtotal}
          discount={discount}
          total={total}
          maxPercent={maxPercent}
          discountTooBig={discountTooBig}
          payment={payment}
          paymentError={built.error}
          checkingOut={checkingOut}
          lastReceipt={lastReceipt}
          onQuantity={updateQuantity}
          onRemove={removeItem}
          onDiscount={(cents) => { setDiscount(cents); setCheckoutError(''); }}
          onPayment={(next) => { setPayment(next); setCheckoutError(''); }}
          onCharge={handleCheckout}
        />
      </div>
    </div>
  );
}
