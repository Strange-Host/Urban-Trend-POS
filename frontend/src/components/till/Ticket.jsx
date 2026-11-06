import { useState } from 'react';
import PrintReceiptButton from '../PrintReceipt';
import PaymentPanel from '../PaymentPanel';
import PrinterSettings from '../PrinterSettings';
import DiscountRow from './DiscountRow';
import { describePayments } from '../../utils/splitPayment';

/**
 * The till's ticket: a dark panel, always visible beside the product grid on large screens and a slide-up sheet on small
 * ones (`open` / `onClose` only matter there). It shows the lines, subtotal, discount, total and payment method, the Charge
 * button, printer settings and the last sale's receipt. It holds no sale logic: the till passes the numbers and the handlers.
 */
export default function Ticket({
  open, onClose, items, itemCount, subtotal, discount, total, maxPercent, discountTooBig,
  payment, paymentError, checkingOut, lastReceipt, onQuantity, onRemove, onDiscount, onPayment, onCharge,
}) {
  const [printerOpen, setPrinterOpen] = useState(false);
  return (
  <div
    className={`
      fixed inset-x-0 bottom-0 z-50 max-h-[88vh] rounded-t-2xl
      xl:static xl:z-auto xl:max-h-none xl:w-[400px] xl:rounded-none
      flex w-full shrink-0 flex-col bg-ink text-white
      transform transition-transform duration-200 ease-out
      ${open ? 'translate-y-0' : 'translate-y-full'} xl:translate-y-0
    `}
  >
    <div className="flex flex-1 flex-col overflow-hidden px-5 pb-5">
      <div className="flex items-center justify-between border-b border-white/15 py-4 text-xs text-white/60">
        <span className="font-medium uppercase tracking-wider">Ticket</span>
        <span>{new Date().toLocaleDateString()}</span>
        <button
          onClick={() => onClose()}
          aria-label="Close cart"
          className="-mr-2 min-h-11 min-w-11 text-white/60 hover:text-white xl:hidden"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto py-4">
        {items.length === 0 && (
          <div className="py-16 text-center text-sm text-white/60">
            Cart is empty.<br />Tap a product or scan a barcode.
          </div>
        )}
        {items.map((item) => (
          <div key={item.product_id} className="text-sm">
            <div className="flex justify-between">
              <span className="truncate pr-2">{item.name}</span>
              <button
                onClick={() => onRemove(item.product_id)}
                className="shrink-0 text-xs text-danger"
                aria-label={`Remove ${item.name}`}
              >
                ✕
              </button>
            </div>
            <div className="mt-1 flex items-center justify-between text-white/60">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onQuantity(item.product_id, item.quantity - 1)}
                  aria-label={`Fewer ${item.name}`}
                  className="flex h-8 w-8 items-center justify-center rounded bg-white/10 hover:bg-white/20"
                >
                  −
                </button>
                <span className="w-5 text-center text-white">{item.quantity}</span>
                <button
                  onClick={() => onQuantity(item.product_id, item.quantity + 1)}
                  aria-label={`More ${item.name}`}
                  className="flex h-8 w-8 items-center justify-center rounded bg-white/10 hover:bg-white/20"
                >
                  +
                </button>
                <span className="text-xs">× {(item.unit_price / 100).toFixed(0)}</span>
              </div>
              <span className="text-white">{((item.unit_price * item.quantity) / 100).toFixed(0)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2 border-t border-white/15 pt-4 text-sm">
        <div className="flex justify-between text-white/70">
          <span>Subtotal · {itemCount} item{itemCount === 1 ? '' : 's'}</span><span>{(subtotal / 100).toFixed(2)}</span>
        </div>
        {items.length > 0 && (
          <DiscountRow
            subtotal={subtotal}
            discount={discount}
            onChange={onDiscount}
            maxPercent={maxPercent}
            exceeded={discountTooBig}
          />
        )}
        <div className="flex items-baseline justify-between pt-1">
          <span className="text-white/70">Total</span>
          <span className="font-display font-700 text-4xl text-accent">{(total / 100).toFixed(2)}</span>
        </div>
      </div>

      <PaymentPanel dark total={total} value={payment} onChange={onPayment} />

      <button
        onClick={onCharge}
        disabled={items.length === 0 || checkingOut || Boolean(paymentError) || discountTooBig}
        className="mt-4 min-h-12 w-full rounded-xl bg-accent px-5 py-3 font-display font-700 text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {checkingOut ? 'Processing…' : 'Charge'}
      </button>

      <button type="button" onClick={() => setPrinterOpen(true)} className="mt-2 min-h-11 self-start text-[11px] text-white/60 underline decoration-dotted hover:text-white">Printer settings</button>
      {printerOpen && <PrinterSettings onClose={() => setPrinterOpen(false)} />}

      {lastReceipt && (
        lastReceipt.queued ? (
          <div className="mt-1 rounded-lg bg-accent/15 px-3 py-2 font-mono text-xs">
            Sale saved offline — {(lastReceipt.total / 100).toFixed(2)} taken.
            It will be recorded automatically once the connection is back.
          </div>
        ) : (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-lg bg-success-soft px-3 py-2 font-mono text-xs text-success">
            <span>
              Sale #{lastReceipt.id} completed — {(lastReceipt.total / 100).toFixed(2)} paid.
              {lastReceipt.payments?.length > 1 && <span className="block opacity-80">{describePayments(lastReceipt.payments)}</span>}
            </span>
            <PrintReceiptButton kind="sale" id={lastReceipt.id} label="Print receipt" className="min-h-11 shrink-0 rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50" />
          </div>
        )
      )}
    </div>
  </div>
  );
}
