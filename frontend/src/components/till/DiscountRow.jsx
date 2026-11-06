import { useEffect, useState } from 'react';
import { toCents, centsToInput } from '../../utils/splitPayment';
import { discountPercentLabel } from '../../utils/discount';

// The ticket's Discount line: the cashier types an amount in shillings and it comes off the subtotal. The cart store keeps
// it whole-cents and never above the subtotal; `exceeded` (worked out by the till from the server's limit for this
// person) turns the line red and says why Charge is blocked. Typing something that is not an amount leaves the last good
// discount in place rather than guessing.
export default function DiscountRow({ subtotal, discount, onChange, maxPercent, exceeded }) {
  const [text, setText] = useState(() => (discount ? centsToInput(discount) : ''));

  // Follow the store when it changes the number itself (cut back to the subtotal, cleared after a sale).
  useEffect(() => {
    if (toCents(text) !== discount) setText(discount ? centsToInput(discount) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the stored value should re-sync the field
  }, [discount]);

  function handle(e) {
    const next = e.target.value;
    setText(next);
    const cents = toCents(next);
    if (cents !== null) onChange(cents);
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="till-discount" className="text-white/70">
          Discount{discount > 0 && <span className="ml-1.5 text-xs text-white/50">{discountPercentLabel(discount, subtotal)}</span>}
        </label>
        <input
          id="till-discount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={text}
          onChange={handle}
          aria-invalid={exceeded || undefined}
          className={`w-28 rounded-md border bg-white/10 px-2 py-1.5 text-right font-mono text-sm text-white outline-none placeholder:text-white/40 focus:border-accent ${
            exceeded ? 'border-danger' : 'border-white/20'
          }`}
        />
      </div>
      {exceeded && (
        <p role="alert" className="mt-1 text-xs text-danger">
          Above your {maxPercent}% limit. Ask a manager to ring this sale.
        </p>
      )}
    </div>
  );
}
