import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ordersApi, couriersApi } from '../api/endpoints';
import PrintReceiptButton from '../components/PrintReceipt';
import PrintWaybillButton from '../components/PrintWaybill';
import AddItemsSheet from '../components/AddItemsSheet';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../context/UIContext';
import { PageHeader, StatusPill } from '../components/DataUI';
import PullOnlineOrders from '../components/PullOnlineOrders';
import TabBar from '../components/TabBar';
import Pager, { usePager } from '../components/Pager';
import useModules from '../hooks/useModules';

function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
}

const STATUS_LABELS = {
  awaiting_dispatch: 'Awaiting dispatch',
  dispatched_unpaid: 'Dispatched · unpaid',
  dispatched_partial: 'Dispatched · part paid',
  dispatched_paid: 'Dispatched · paid',
  returned_in_transit: 'Returning',
  returned_awaiting_inspection: 'Awaiting inspection',
  returned_resellable: 'Returned · resellable',
  returned_damaged: 'Returned · damaged',
  cancelled: 'Cancelled',
};

const STATUS_TONES = {
  awaiting_dispatch: 'neutral',
  dispatched_unpaid: 'danger',
  dispatched_partial: 'accent',
  dispatched_paid: 'success',
  returned_in_transit: 'accent',
  returned_awaiting_inspection: 'accent',
  returned_resellable: 'success',
  returned_damaged: 'danger',
  cancelled: 'neutral',
};

const RETURN_REASONS = [
  { value: 'rejected', label: 'Customer rejected' },
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'wrong_item', label: 'Wrong item sent' },
];

// Same split as Sales history. The API calls the Local-store channel "manual" (orders created in the
// POS or from leads) and WooCommerce "wordpress".
const CHANNELS = [
  { key: 'all', label: 'All channels' },
  { key: 'local', label: 'Local store' },
  { key: 'shopify', label: 'Shopify' },
  { key: 'woocommerce', label: 'WooCommerce' },
];
const CHANNEL_PARAM = { all: undefined, local: 'manual', shopify: 'shopify', woocommerce: 'wordpress' };
const CHANNEL_BADGE = {
  shopify: { label: 'Shopify', cls: 'bg-success-soft text-success' },
  wordpress: { label: 'WooCommerce', cls: 'bg-accent/20 text-accent-ink' },
};

function ChannelBadge({ order }) {
  const b = CHANNEL_BADGE[order.channel];
  if (!b) return null;
  return <span title={order.income_source_name || b.label} className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${b.cls}`}>{b.label}</span>;
}

export default function Orders() {
  const { hasRole } = useAuth();
  const dialog = useDialog();
  const modules = useModules();
  const isManager = hasRole('admin', 'manager');
  const isAdmin = hasRole('admin');
  const queryClient = useQueryClient();

  const pager = usePager(25);
  const [channel, setChannel] = useState('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [addingItems, setAddingItems] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ method: 'mobile_money', amount: '', reference: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['orders', { channel, statusFilter, search, page: pager.page, size: pager.pageSize }],
    queryFn: () => ordersApi.list({ ...pager.params, channel: CHANNEL_PARAM[channel], status: statusFilter || undefined, search: search || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,            // new online orders appear without a reload
  });
  const orders = data?.data || [];

  const { data: order } = useQuery({
    queryKey: ['orders', selectedId],
    queryFn: () => ordersApi.get(selectedId).then((r) => r.data.data),
    enabled: !!selectedId,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    queryClient.invalidateQueries({ queryKey: ['products'] }); // dispatch/return move stock
  }

  // Every action goes through this so the busy/error handling is identical
  // across all of them — these are all "one call, then refresh" operations.
  // confirmOpts can be a plain string (default button styling) or
  // { message, danger } when the action being confirmed is destructive.
  async function act(fn, confirmOpts) {
    if (confirmOpts) {
      const opts = typeof confirmOpts === 'string' ? { message: confirmOpts } : confirmOpts;
      if (!(await dialog.confirm(opts))) return;
    }
    setBusy(true);
    setError('');
    try {
      await fn();
      invalidate();
    } catch (err) {
      setError(getErrorMessage(err, 'That action failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordPayment() {
    const amount = Math.round(parseFloat(paymentForm.amount) * 100);
    if (!amount || amount <= 0) { setError('Enter a payment amount.'); return; }
    await act(async () => {
      await ordersApi.recordPayment(order.id, {
        method: paymentForm.method,
        amount,
        reference: paymentForm.reference || undefined,
      });
      setPaymentForm({ method: 'mobile_money', amount: '', reference: '' });
    });
  }

  async function handleReturn() {
    const picked = await dialog.prompt({
      title: 'Why is this parcel coming back?',
      options: RETURN_REASONS,
    });
    if (picked === null) return;
    const reason = RETURN_REASONS.find((r) => r.value === picked);
    await act(() => ordersApi.returnedInTransit(order.id, reason ? { reason_code: reason.value } : {}));
  }

  const outstanding = order ? order.total - order.amount_paid : 0;

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow={`${CHANNELS.find((c) => c.key === channel).label}${statusFilter ? ` · ${STATUS_LABELS[statusFilter]}` : ''}`}
        title="Orders"
        description="Online and COD orders — confirmation, courier dispatch, payment, and returns."
        meta={data?.total > 0 ? `${data.total} order${data.total === 1 ? '' : 's'}\n${money(data.summary?.outstanding || 0)} outstanding` : null}
        actions={<PullOnlineOrders onPulled={invalidate} />}
      />

      <TabBar tabs={CHANNELS} active={channel} onChange={(k) => { setChannel(k); pager.reset(); setSelectedId(null); }} variant="filter" className="mb-4" />

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); pager.reset(); }}
          placeholder="Search customer name or phone…"
          className="flex-1 px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); pager.reset(); }}
          className="px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      <div className="grid xl:grid-cols-[1fr_400px] gap-5 items-start">
        {/* Order list + pager (one grid cell, so the pager never becomes a column of its own) */}
        <div className="min-w-0">
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          {isLoading && <div className="p-6 text-text-muted text-sm">Loading…</div>}
          {!isLoading && orders.length === 0 && (
            <div className="p-10 text-center text-text-muted text-sm">
              {statusFilter || search || channel !== 'all'
                ? `No ${channel === 'all' ? '' : `${CHANNELS.find((c) => c.key === channel).label} `}orders match these filters.${channel === 'shopify' || channel === 'woocommerce' ? ' Use “Pull online orders” to bring in orders that still need shipping.' : ''}`
                : 'No orders yet. Orders from your Shopify / WooCommerce store do not arrive by themselves - use “Pull online orders” above (they also show under Sales history once synced).'}
            </div>
          )}
          {orders.length > 0 && (
            <table className="stack-sm w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  {['Code', 'Customer', 'Status', 'Total', 'Due'].map((h, i) => (
                    <th key={h} className={`font-mono text-[11px] uppercase tracking-wider text-text-muted font-500 px-4 py-2.5 ${i >= 3 ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orders.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => { setSelectedId(o.id); setError(''); }}
                    className={`cursor-pointer hover:bg-paper ${selectedId === o.id ? 'bg-accent/10' : ''}`}
                  >
                    <td className="px-4 py-2.5 font-mono text-xs">{o.product_code}<ChannelBadge order={o} /></td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{o.customer_name}</div>
                      <div className="text-xs text-text-muted font-mono">
                        {o.customer_phone}
                        {modules.control && o.customer_risk_flag === 'high' && <span className="text-danger"> · prepay only</span>}
                        {modules.control && o.customer_risk_flag === 'watch' && <span className="text-danger"> · watch</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill tone={STATUS_TONES[o.status]}>{STATUS_LABELS[o.status]}</StatusPill>
                      {modules.control && o.dispute_status === 'open' && (
                        <span className="ml-1"><StatusPill tone="danger">dispute</StatusPill></span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{money(o.total)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {o.total - o.amount_paid > 0
                        ? <span className="text-danger">{money(o.total - o.amount_paid)}</span>
                        : <span className="text-text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <Pager pager={pager} data={data} noun="orders" />
        </div>

        {/* Detail / action panel. Below xl it is a slide-up sheet (opens when an order is picked);
            from xl up it is the sticky side panel. */}
        {selectedId && (
          <button
            type="button"
            aria-label="Close order details"
            onClick={() => setSelectedId(null)}
            className="xl:hidden fixed inset-0 z-40 bg-black/40"
          />
        )}
        <div
          className={`bg-surface border border-line p-5 xl:sticky xl:top-6 xl:inset-x-auto xl:bottom-auto xl:max-h-none xl:overflow-visible xl:rounded-xl xl:shadow-none xl:block ${
            selectedId
              ? 'fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-2xl shadow-2xl pb-[calc(1.25rem+env(safe-area-inset-bottom))]'
              : 'hidden rounded-xl'
          }`}
        >
          {selectedId && (
            <div className="xl:hidden flex justify-end -mt-2 -mr-2 mb-1">
              <button type="button" onClick={() => setSelectedId(null)} className="px-3 py-2 text-sm text-text-muted hover:text-text">Close ✕</button>
            </div>
          )}
          {!order && (
            <div className="text-text-muted text-sm text-center py-12">
              Select an order to see its details and available actions.
            </div>
          )}

          {order && (
            <>
              <div className="flex items-start justify-between mb-1">
                <h2 className="font-display font-700 text-lg">{order.product_code}</h2>
                <StatusPill tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</StatusPill>
                <PrintReceiptButton kind="order" id={order.id} label="Print" className="ml-auto px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50" />
                <PrintWaybillButton orderId={order.id} status={order.status} className="ml-2 px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50" />
              </div>
              <div className="text-sm mb-1">{order.customer?.name}</div>
              <div className="text-xs text-text-muted font-mono mb-4">
                {order.customer?.phone}{order.customer?.city ? ` · ${order.customer.city}` : ''}
                {order.delivery_zone && ` · ${order.delivery_zone === 'nairobi' ? 'Nairobi (2h)' : 'Outside Nairobi (24–48h)'}`}
              </div>

              {modules.control && order.customer?.prepay_required === 1 && (
                <div className="mb-4 px-3 py-2 rounded-lg bg-danger-soft text-danger text-xs">
                  This customer has repeatedly failed to collect COD parcels — they should prepay.
                </div>
              )}

              <div className="font-mono text-sm space-y-1 border-t border-dashed border-line pt-3 mb-3">
                {order.items?.map((it) => (
                  <div key={it.id} className="flex justify-between">
                    <span className="truncate pr-2">{it.quantity} × {it.product_name}</span>
                    <span>{money(it.line_total)}</span>
                  </div>
                ))}
                {order.delivery_fee > 0 && (
                  <div className="flex justify-between text-text-muted">
                    <span>Delivery ({order.courier?.name || order.courier_type || 'courier'})</span><span>{money(order.delivery_fee)}</span>
                  </div>
                )}
                <div className="flex justify-between font-600 pt-1 border-t border-dashed border-line">
                  <span>Total</span><span>{money(order.total)}</span>
                </div>
                <div className="flex justify-between text-text-muted">
                  <span>Paid</span><span>{money(order.amount_paid)}</span>
                </div>
                {outstanding > 0 && (
                  <div className="flex justify-between text-danger font-600">
                    <span>Outstanding</span><span>{money(outstanding)}</span>
                  </div>
                )}
              </div>

              {/* Actions, gated to exactly what the backend state machine allows next */}
              <div className="space-y-2">
                {order.status === 'awaiting_dispatch' && order.payment_type === 'cod' && !order.cod_confirmed_at && (
                  <button
                    onClick={() => act(() => ordersApi.confirmCod(order.id))}
                    disabled={busy}
                    className="w-full py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
                  >
                    Confirm with customer (required before dispatch)
                  </button>
                )}

                {order.status === 'awaiting_dispatch' && (
                  <>
                    <button
                      onClick={() => setAddingItems(true)}
                      disabled={busy}
                      className="w-full py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50"
                    >
                      Add items to this order
                    </button>
                    <div className="flex gap-2">
                      {['boda', 'g4s'].map((c) => (
                        <button
                          key={c}
                          onClick={() => act(() => ordersApi.setCourier(order.id, c))}
                          disabled={busy}
                          className={`flex-1 py-2 rounded-lg text-xs font-medium border capitalize ${
                            order.courier_type === c ? 'bg-accent border-accent text-accent-ink' : 'border-line text-text-muted hover:border-text-muted'
                          }`}
                        >
                          {c === 'g4s' ? 'G4S' : 'Boda'}
                        </button>
                      ))}
                    </div>
                    <CourierPicker order={order} disabled={busy} onPick={(id) => act(() => ordersApi.assignCourier(order.id, id))} />
                    <button
                      onClick={() => act(
                        () => ordersApi.dispatch(order.id),
                        'Dispatch this order? Stock will be deducted now.'
                      )}
                      disabled={busy || (order.payment_type === 'cod' && !order.cod_confirmed_at)}
                      className="w-full py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-40"
                    >
                      Dispatch — deducts stock
                    </button>
                    <button
                      onClick={() => act(() => ordersApi.cancel(order.id), { message: 'Cancel this order?', danger: true })}
                      disabled={busy}
                      className="w-full py-2 rounded-lg border border-line text-sm hover:border-text-muted disabled:opacity-50"
                    >
                      Cancel order
                    </button>
                  </>
                )}

                {['dispatched_unpaid', 'dispatched_partial'].includes(order.status) && (
                  <div className="border border-line rounded-lg p-3">
                    <div className="text-xs font-medium mb-2">Record a payment</div>
                    <div className="flex gap-2 mb-2">
                      <select
                        value={paymentForm.method}
                        onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}
                        className="px-2 py-1.5 rounded-lg border border-line bg-surface text-xs outline-none"
                      >
                        <option value="mobile_money">M-Pesa</option>
                        <option value="bank_transfer">Bank</option>
                        <option value="cash">Cash</option>
                        <option value="card">Card</option>
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        placeholder={(outstanding / 100).toFixed(2)}
                        value={paymentForm.amount}
                        onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                        className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-line bg-surface text-xs font-mono outline-none"
                      />
                    </div>
                    <input
                      placeholder="Reference (optional)"
                      value={paymentForm.reference}
                      onChange={(e) => setPaymentForm({ ...paymentForm, reference: e.target.value })}
                      className="w-full px-2 py-1.5 rounded-lg border border-line bg-surface text-xs font-mono outline-none mb-2"
                    />
                    <button
                      onClick={handleRecordPayment}
                      disabled={busy}
                      className="w-full py-2 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft disabled:opacity-50"
                    >
                      Record payment
                    </button>
                  </div>
                )}

                {order.status.startsWith('dispatched') && (
                  <button
                    onClick={handleReturn}
                    disabled={busy}
                    className="w-full py-2 rounded-lg border border-line text-sm hover:border-text-muted disabled:opacity-50"
                  >
                    Parcel is coming back
                  </button>
                )}

                {order.status === 'returned_in_transit' && (
                  <button
                    onClick={() => act(() => ordersApi.returnedAwaitingInspection(order.id))}
                    disabled={busy}
                    className="w-full py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
                  >
                    Parcel arrived at shop
                  </button>
                )}

                {order.status === 'returned_awaiting_inspection' && isManager && (
                  <div className="border border-line rounded-lg p-3">
                    <div className="text-xs font-medium mb-2">Inspection — decides whether stock returns</div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => act(() => ordersApi.inspect(order.id, { result: 'good' }), 'Mark good and return these items to sellable stock?')}
                        disabled={busy}
                        className="flex-1 py-2 rounded-lg bg-success-soft text-success text-xs font-medium disabled:opacity-50"
                      >
                        Good — restock
                      </button>
                      <button
                        onClick={() => act(() => ordersApi.inspect(order.id, { result: 'damaged' }), { message: 'Mark damaged? Stock will NOT be returned and the owner must decide what happens to it.', danger: true })}
                        disabled={busy}
                        className="flex-1 py-2 rounded-lg bg-danger-soft text-danger text-xs font-medium disabled:opacity-50"
                      >
                        Damaged
                      </button>
                    </div>
                  </div>
                )}

                {order.status === 'returned_damaged' && !order.owner_decision && isAdmin && (
                  <div className="border border-line rounded-lg p-3">
                    <div className="text-xs font-medium mb-2">Owner decision needed</div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => act(() => ordersApi.ownerDecision(order.id, { decision: 'write_off' }))}
                        disabled={busy}
                        className="flex-1 py-2 rounded-lg border border-line text-xs hover:border-text-muted disabled:opacity-50"
                      >
                        Write off
                      </button>
                      <button
                        onClick={() => act(() => ordersApi.ownerDecision(order.id, { decision: 'dispose' }))}
                        disabled={busy}
                        className="flex-1 py-2 rounded-lg border border-line text-xs hover:border-text-muted disabled:opacity-50"
                      >
                        Dispose
                      </button>
                    </div>
                  </div>
                )}

                {modules.control && (order.dispute_status !== 'open' ? (
                  <button
                    onClick={async () => {
                      const reason = await dialog.prompt({ message: 'What is the customer disputing?', required: true });
                      if (!reason) return;
                      await act(() => ordersApi.openDispute(order.id, reason));
                    }}
                    disabled={busy}
                    className="w-full py-2 rounded-lg border border-line text-sm hover:border-text-muted disabled:opacity-50"
                  >
                    Raise a dispute
                  </button>
                ) : isManager && (
                  <div className="border border-danger/30 bg-danger-soft rounded-lg p-3">
                    <div className="text-xs font-medium text-danger mb-1">Open dispute</div>
                    <div className="text-xs text-danger mb-2">{order.dispute_reason}</div>
                    <div className="flex gap-1.5">
                      {[['refund', 'Refund'], ['redelivered', 'Redeliver'], ['closed', 'Close']].map(([v, l]) => (
                        <button
                          key={v}
                          onClick={() => act(() => ordersApi.resolveDispute(order.id, { outcome: v }))}
                          disabled={busy}
                          className="flex-1 py-1.5 rounded-lg bg-surface text-xs font-medium disabled:opacity-50"
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {order.status_history?.length > 0 && (
                <div className="mt-5 pt-4 border-t border-dashed border-line">
                  <div className="text-xs font-medium mb-2">History</div>
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {order.status_history.map((h) => (
                      <div key={h.id} className="text-xs font-mono text-text-muted">
                        <div>{new Date(h.changed_at).toLocaleString()} · {h.changed_by_name || 'system'}</div>
                        <div className="text-text">
                          {h.from_status === h.to_status
                            ? h.notes
                            : `${STATUS_LABELS[h.from_status] || h.from_status || 'created'} → ${STATUS_LABELS[h.to_status] || h.to_status}`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {addingItems && order && order.status === 'awaiting_dispatch' && (
        <AddItemsSheet order={order} onClose={() => setAddingItems(false)} onAdded={invalidate} />
      )}
    </div>
  );
}


// Optional: pick a NAMED courier (their type is applied automatically). The
// Boda / G4S buttons above still work on their own for when you don't care who.
function CourierPicker({ order, disabled, onPick }) {
  const { data: couriers = [] } = useQuery({
    queryKey: ['couriers'],
    queryFn: () => couriersApi.list().then((r) => r.data.data),
    staleTime: 60_000,
  });
  if (couriers.length === 0) return null;
  return (
    <select
      value={order.courier_id || ''}
      disabled={disabled}
      onChange={(e) => e.target.value && onPick(Number(e.target.value))}
      aria-label="Assign a named courier"
      className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-xs outline-none focus:border-accent"
    >
      <option value="">Assign a named courier (optional)…</option>
      {couriers.map((c) => (
        <option key={c.id} value={c.id}>{c.name} — {c.courier_type === 'g4s' ? 'G4S' : 'Boda'}{c.vehicle ? ` · ${c.vehicle}` : ''}</option>
      ))}
    </select>
  );
}
