import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import Sheet from '../components/Sheet';
/* =============================== Toasts =============================== */
// Replaces alert() for one-off notifications (errors, success confirmations).
// Non-blocking, auto-dismissing, stacked bottom-right — unlike alert(),
// doesn't freeze the tab or need a click to continue.

const ToastContext = createContext(null);
let toastIdCounter = 0;

const TOAST_STYLES = {
  success: 'bg-success text-white',
  error: 'bg-danger text-white',
  info: 'bg-ink text-white',
};
const TOAST_ICONS = { success: CircleCheck, error: CircleAlert, info: Info };
const HOVER_GRACE_MS = 2000; // after the pointer leaves a toast it stays this long, then goes

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback((id, ms) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => dismiss(id), ms));
  }, [dismiss]);

  const push = useCallback((variant, message, { duration } = {}) => {
    const id = ++toastIdCounter;
    // Keep the newest five: a burst of errors must not push the whole page's worth of boxes onto the screen.
    setToasts((prev) => [...prev, { id, variant, message }].slice(-5));
    // Errors stay up a little longer — there's usually more to read.
    schedule(id, duration ?? (variant === 'error' ? 6000 : 4000));
    return id;
  }, [schedule]);

  useEffect(() => {
    const live = timers.current;
    return () => live.forEach((t) => clearTimeout(t));
  }, []);

  const api = useRef({
    success: (msg, opts) => push('success', msg, opts),
    error: (msg, opts) => push('error', msg, opts),
    info: (msg, opts) => push('info', msg, opts),
  }).current;

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full px-4 sm:px-0">
        {toasts.map((t) => {
          const Icon = TOAST_ICONS[t.variant];
          return (
            <div
              key={t.id}
              // Errors interrupt a screen reader; everything else waits for a pause.
              role={t.variant === 'error' ? 'alert' : 'status'}
              // Reading takes time: hovering (or tabbing into) a toast keeps it up.
              onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
              onMouseLeave={() => schedule(t.id, HOVER_GRACE_MS)}
              onFocus={() => clearTimeout(timers.current.get(t.id))}
              onBlur={() => schedule(t.id, HOVER_GRACE_MS)}
              className={`${TOAST_STYLES[t.variant]} toast-in rounded-lg shadow-lg px-4 py-3 text-sm flex items-start gap-3`}
            >
              <Icon size={18} strokeWidth={1.75} className="shrink-0 mt-px" aria-hidden="true" />
              <span className="flex-1">{t.message}</span>
              <button onClick={() => dismiss(t.id)} className="opacity-70 hover:opacity-100 leading-none -mr-1 p-0.5" aria-label="Dismiss">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** toast.success(msg) / toast.error(msg) / toast.info(msg) — fire and forget, same as alert() was. */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

/* =============================== Dialogs =============================== */
// Replaces confirm()/prompt(). Promise-based so call sites read almost
// exactly like the native versions did (`if (!(await dialog.confirm(...)))
// return;`) without freezing the tab or blocking the JS event loop the way
// the native versions do.

const DialogContext = createContext(null);

function DialogModal({ state, onCancel, onSubmit }) {
  const [value, setValue] = useState(state.type === 'prompt' ? state.defaultValue || '' : '');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select?.();
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit(state.type === 'confirm' ? true : value);
  }

  return (
    <Sheet onClose={onCancel} size="sm" zIndex={100} as="form" onSubmit={handleSubmit}>
        {state.title && <h2 className="font-display font-700 text-lg mb-1">{state.title}</h2>}
        {state.message && <p className="text-sm text-text-muted whitespace-pre-line mb-4">{state.message}</p>}

        {state.type === 'prompt' && !state.options && (
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={state.placeholder}
            className="w-full px-3 py-2 rounded-lg border border-line bg-bg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        )}

        {state.type === 'prompt' && state.options && (
          <div className="flex flex-col gap-1.5 mb-4" role="radiogroup">
            {state.options.map((opt, i) => (
              <label
                key={opt.value}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
                  value === opt.value ? 'border-ink bg-line/40' : 'border-line hover:border-text-muted'
                }`}
              >
                <input
                  ref={i === 0 ? inputRef : undefined}
                  type="radio"
                  name="dialog-option"
                  className="accent-ink"
                  checked={value === opt.value}
                  onChange={() => setValue(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3.5 py-1.5 rounded-lg border border-line text-sm">
            {state.cancelLabel || 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={state.type === 'prompt' && state.required && !value}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 ${state.danger ? 'bg-danger' : 'bg-ink'}`}
          >
            {state.confirmLabel || (state.type === 'confirm' ? 'Confirm' : 'OK')}
          </button>
        </div>
    </Sheet>
  );
}

export function DialogProvider({ children }) {
  const [state, setState] = useState(null); // { type, resolve, ...opts } | null

  const confirmDialog = useCallback((opts) => {
    if (typeof opts === 'string') opts = { message: opts };
    return new Promise((resolve) => setState({ type: 'confirm', resolve, ...opts }));
  }, []);

  const promptDialog = useCallback((opts) => {
    if (typeof opts === 'string') opts = { message: opts };
    return new Promise((resolve) => setState({ type: 'prompt', resolve, ...opts }));
  }, []);

  const api = useRef({ confirm: confirmDialog, prompt: promptDialog }).current;

  function handleCancel() {
    state?.resolve(state.type === 'confirm' ? false : null);
    setState(null);
  }
  function handleSubmit(result) {
    state?.resolve(result);
    setState(null);
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {state && <DialogModal state={state} onCancel={handleCancel} onSubmit={handleSubmit} />}
    </DialogContext.Provider>
  );
}

/**
 * dialog.confirm({ title, message, danger, confirmLabel }) => Promise<boolean>
 * dialog.prompt({ title, message, placeholder, defaultValue, required }) => Promise<string|null>
 * dialog.prompt({ title, message, options: [{value,label}], required }) => Promise<string|null>  — radio choice instead of free text
 * Both also accept a plain string as shorthand for { message: '...' }.
 */
export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within a DialogProvider');
  return ctx;
}
