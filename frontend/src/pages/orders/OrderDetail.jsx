import { ordersApi } from '../../api/endpoints';
import CustomerOrderHistory from '../../components/CustomerOrderHistory';
import { StatusPill } from '../../components/DataUI';
import DeliverySettlementPanel from '../../components/DeliverySettlementPanel';
import InvoiceButton from '../../components/InvoiceButton';
import MergeOrdersNotice from '../../components/MergeOrdersNotice';
import { ShopCashForm } from '../../components/OrderAdminPanels';
import PrintReceiptButton from '../../components/PrintReceipt';
import PrintWaybillButton from '../../components/PrintWaybill';
import { useDialog } from '../../context/UIContext';
import CourierPicker from './CourierPicker';
import { money, STATUS_LABELS, STATUS_TONES } from './helpers';

/** Everything about the selected order: customer, items, totals, the next allowed actions, settlement and history. */
export default function OrderDetail({
  order, outstanding, busy, act, modules, isManager, isAdmin,
  paymentForm, setPaymentForm, handleRecordPayment, handleReturn,
  setEditingItems, setDispatching, setSelectedId,
}) {
  const dialog = useDialog();
  return (
    <>
      <div className="flex items-start justify-between mb-1">
        <h2 className="font-display font-700 text-lg">{order.product_code}</h2>
        <StatusPill tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</StatusPill>
        <PrintReceiptButton kind="order" id={order.id} label="Print" className="ml-auto px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50" />
        <InvoiceButton kind="order" id={order.id} className="ml-2 px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50" />
        <PrintWaybillButton orderId={order.id} status={order.status} className="ml-2 px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50" />
      </div>
      <div className="text-sm mb-1">{order.customer?.name}</div>
      <div className="text-xs text-text-muted font-mono mb-4">
        {order.customer?.phone}{order.customer?.city ? ` · ${order.customer.city}` : ''}
        {order.delivery_zone && ` · ${order.delivery_zone === 'nairobi' ? 'Nairobi (2h)' : 'Outside Nairobi (24–48h)'}`}
      </div>

      <CustomerOrderHistory
        customerId={order.customer?.id} currentOrderId={order.id} onSelectOrder={setSelectedId}
        statusLabels={STATUS_LABELS} statusTones={STATUS_TONES}
      />

      <MergeOrdersNotice order={order} onSelect={setSelectedId} onMerged={setSelectedId} />

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
            <span>Delivery fee, billed separately ({order.courier?.name || order.courier_type || 'courier'})</span><span>{money(order.delivery_fee)}</span>
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
              onClick={() => setEditingItems(true)}
              disabled={busy || (order.channel && order.channel !== 'manual')}
              title={order.channel && order.channel !== 'manual' ? 'Imported from an online store: change the items there.' : undefined}
              className="w-full py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50"
            >
              Change items on this order
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
              onClick={() => setDispatching(true)}
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

        {['dispatched_unpaid', 'dispatched_partial'].includes(order.status) && <ShopCashForm key={order.id} order={order} />}

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

      {(order.status.startsWith('dispatched') || order.status.startsWith('returned')) && (
        <DeliverySettlementPanel key={order.id} order={order} />
      )}

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
  );
}
