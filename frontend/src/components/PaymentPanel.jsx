import { METHODS, buildPayments, restFor } from '../utils/splitPayment';

const kes = (cents) => (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const seg = (on) => `flex-1 py-1.5 rounded-md text-[11px] font-medium transition-colors ${on ? 'bg-ink text-white' : 'text-text-muted hover:text-text'}`;

/**
 * How the sale is paid: one method for the whole amount, or split across methods (Cash + M-Pesa + Card) with the
 * amount for each and an optional M-Pesa code / card reference. Controlled: `value` is the state from
 * utils/splitPayment (emptyPayment()), and the parent turns it into the checkout payload with buildPayments().
 */
export default function PaymentPanel({ total, value, onChange }) {
  const split = value.mode === 'split';
  const { paid, remaining } = buildPayments(value, total);
  const set = (patch) => onChange({ ...value, ...patch });
  const setAmount = (key, text) => set({ amounts: { ...value.amounts, [key]: text } });
  const setRef = (key, text) => set({ refs: { ...value.refs, [key]: text } });

  return (
    <div className="mt-4">
      <div className="flex gap-1 p-0.5 rounded-lg bg-paper border border-line mb-2" role="group" aria-label="Payment type">
        <button type="button" aria-pressed={!split} onClick={() => set({ mode: 'single' })} className={seg(!split)}>One method</button>
        <button type="button" aria-pressed={split} onClick={() => set({ mode: 'split' })} className={seg(split)}>Split payment</button>
      </div>

      {!split && (
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Payment method">
          {METHODS.map((m) => (
            <button
              key={m.key}
              type="button"
              aria-pressed={value.method === m.key}
              onClick={() => set({ method: m.key })}
              className={`py-2.5 xl:py-2 rounded-lg text-xs font-medium border transition-colors ${
                value.method === m.key ? 'bg-accent border-accent text-accent-ink' : 'border-line text-text-muted hover:border-text-muted'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {split && (
        <div className="space-y-2">
          {METHODS.map((m) => {
            const typed = value.amounts[m.key];
            return (
              <div key={m.key}>
                <div className="flex items-center gap-2">
                  <label htmlFor={`pay-amount-${m.key}`} className="w-16 shrink-0 text-xs font-medium">{m.label}</label>
                  <input
                    id={`pay-amount-${m.key}`}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={typed}
                    onChange={(e) => setAmount(m.key, e.target.value)}
                    className="min-w-0 flex-1 px-2.5 py-2 rounded-lg border border-line bg-surface font-mono text-sm text-right focus:border-accent outline-none"
                  />
                  <button
                    type="button"
                    aria-label={`Put the rest on ${m.label}`}
                    onClick={() => setAmount(m.key, restFor(value, m.key, total))}
                    className="shrink-0 px-2 py-2 rounded-lg border border-line text-[11px] font-medium text-text-muted hover:border-text-muted"
                  >
                    Rest
                  </button>
                </div>
                {m.refLabel && Number(typed) > 0 && (
                  <input
                    type="text"
                    aria-label={m.refLabel}
                    placeholder={`${m.refLabel} (optional)`}
                    maxLength={40}
                    autoComplete="off"
                    value={value.refs[m.key]}
                    onChange={(e) => setRef(m.key, e.target.value)}
                    className="mt-1 ml-[4.5rem] w-[calc(100%-4.5rem)] px-2.5 py-1.5 rounded-lg border border-line bg-surface font-mono text-xs focus:border-accent outline-none"
                  />
                )}
              </div>
            );
          })}

          {total > 0 && (
            <div className="flex justify-between font-mono text-xs pt-1" aria-live="polite">
              <span className="text-text-muted">Entered {kes(paid)}</span>
              {remaining === 0
                ? <span className="text-success font-medium">Matches the total</span>
                : <span className="text-danger font-medium">{remaining > 0 ? `${kes(remaining)} to go` : `${kes(-remaining)} too much`}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
