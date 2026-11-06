import { METHODS, buildPayments, restFor } from '../utils/splitPayment';

const kes = (cents) => (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Two looks for the same controls: on the page's light surface, or on the till's dark ticket (`dark`).
const LOOK = {
  light: {
    pick: 'border-line text-text-muted hover:border-text-muted',
    label: '',
    input: 'border-line bg-surface focus:border-accent',
    rest: 'border-line text-text-muted hover:border-text-muted',
    muted: 'text-text-muted',
  },
  dark: {
    pick: 'border-white/20 text-white/80 hover:border-white/50',
    label: 'text-white',
    input: 'border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:border-accent',
    rest: 'border-white/20 text-white/70 hover:border-white/50',
    muted: 'text-white/60',
  },
};

/**
 * How the sale is paid: one method for the whole amount (Cash, M-Pesa or Card), or Split across methods with the amount
 * for each and an optional M-Pesa code / card reference. Controlled: `value` is the state from utils/splitPayment
 * (emptyPayment()), and the parent turns it into the checkout payload with buildPayments().
 */
export default function PaymentPanel({ total, value, onChange, dark = false }) {
  const look = dark ? LOOK.dark : LOOK.light;
  const split = value.mode === 'split';
  const { paid, remaining } = buildPayments(value, total);
  const set = (patch) => onChange({ ...value, ...patch });
  const setAmount = (key, text) => set({ amounts: { ...value.amounts, [key]: text } });
  const setRef = (key, text) => set({ refs: { ...value.refs, [key]: text } });
  const pick = (on) => `min-h-11 rounded-lg border py-2 text-xs font-medium transition-colors ${on ? 'border-accent bg-accent text-accent-ink' : look.pick}`;

  return (
    <div className="mt-4">
      <div className="grid grid-cols-4 gap-2" role="group" aria-label="Payment method">
        {METHODS.map((m) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={!split && value.method === m.key}
            onClick={() => set({ mode: 'single', method: m.key })}
            className={pick(!split && value.method === m.key)}
          >
            {m.label}
          </button>
        ))}
        <button type="button" aria-label="Split payment" aria-pressed={split} onClick={() => set({ mode: 'split' })} className={pick(split)}>
          Split
        </button>
      </div>

      {split && (
        <div className="mt-3 space-y-2">
          {METHODS.map((m) => {
            const typed = value.amounts[m.key];
            return (
              <div key={m.key}>
                <div className="flex items-center gap-2">
                  <label htmlFor={`pay-amount-${m.key}`} className={`w-16 shrink-0 text-xs font-medium ${look.label}`}>{m.label}</label>
                  <input
                    id={`pay-amount-${m.key}`}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={typed}
                    onChange={(e) => setAmount(m.key, e.target.value)}
                    className={`min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-right font-mono text-sm outline-none ${look.input}`}
                  />
                  <button
                    type="button"
                    aria-label={`Put the rest on ${m.label}`}
                    onClick={() => setAmount(m.key, restFor(value, m.key, total))}
                    className={`min-h-11 shrink-0 rounded-lg border px-2 text-[11px] font-medium ${look.rest}`}
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
                    className={`mt-1 ml-[4.5rem] w-[calc(100%-4.5rem)] rounded-lg border px-2.5 py-1.5 font-mono text-xs outline-none ${look.input}`}
                  />
                )}
              </div>
            );
          })}

          {total > 0 && (
            <div className="flex justify-between pt-1 font-mono text-xs" aria-live="polite">
              <span className={look.muted}>Entered {kes(paid)}</span>
              {remaining === 0
                ? <span className="font-medium text-success">Matches the total</span>
                : <span className="font-medium text-danger">{remaining > 0 ? `${kes(remaining)} to go` : `${kes(-remaining)} too much`}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
