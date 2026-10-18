import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Sheet from './Sheet';
import { getErrorMessage } from '../api/client';

// A dropdown that looks and behaves like the rest of the POS, in place of the phone's own picker (which is drawn by
// Android/iOS in the phone's own colours and can't be styled). Tapping it opens a bottom sheet with big rows, a search
// box for long lists, a tick on the current choice and, when onCreate is given, a "+ New ..." row so you never have to
// leave the screen to add the thing you were looking for.
//
//   <Picker value={form.category_id} onChange={(v) => setForm({ ...form, category_id: v })}
//           options={categories.map((c) => ({ value: c.id, label: c.name }))}
//           title="Category" allowClear clearLabel="None" onCreate={async (name) => (await createCategory(name)).id} />
//
// options: [{ value, label, hint? }]   onCreate(name) -> the new option's value, or { value, label }

const same = (a, b) => String(a ?? '') === String(b ?? '');

export default function Picker({
  value, onChange, options = [], placeholder = 'Select…', title, searchable, onCreate, createLabel = 'Add new…',
  invalid = false, disabled = false, className = '', id, allowClear = false, clearLabel = 'None', emptyText = 'Nothing to choose from yet.',
  'aria-label': ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const current = options.find((o) => same(o.value, value));
  const showSearch = searchable ?? options.length > 8;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => String(o.label).toLowerCase().includes(q)) : options;
  }, [options, query]);

  function close() { setOpen(false); setQuery(''); setCreating(false); setNewName(''); setError(''); }
  function choose(v) { onChange?.(v); close(); }

  async function submitNew(e) {
    e?.preventDefault?.();
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError('');
    try {
      const made = await onCreate(name);
      choose(made && typeof made === 'object' ? made.value : made);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not add that.'));
    } finally { setBusy(false); }
  }

  const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;

  return (
    <>
      <button
        type="button" id={id} disabled={disabled} onClick={() => setOpen(true)}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        className={`w-full min-h-[44px] px-3 py-2 rounded-lg border bg-surface text-sm text-left flex items-center justify-between gap-2 outline-none focus-visible:border-accent disabled:opacity-50 ${invalid ? 'border-danger' : 'border-line'} ${className}`}
      >
        <span className={current ? 'text-text truncate' : 'text-text-muted truncate'}>{current ? current.label : placeholder}</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" className="shrink-0 text-text-muted"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      {open && createPortal(
        <Sheet onClose={close} size="sm" bare zIndex={80} label={title || ariaLabel || 'Choose'}>
          <div className="px-5 pt-1 pb-2 flex items-center justify-between">
            <h2 className="font-display font-700 text-lg">{title || ariaLabel || 'Choose'}</h2>
            <button type="button" onClick={close} className="min-h-[44px] min-w-[44px] -mr-3 text-text-muted text-xl leading-none" aria-label="Close">×</button>
          </div>

          {showSearch && (
            <div className="px-5 pb-2">
              <input
                type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={finePointer}
                placeholder="Search…" enterKeyHint="search" autoComplete="off"
                className="w-full px-3 py-2.5 rounded-lg border border-line bg-surface text-base outline-none focus:border-accent"
              />
            </div>
          )}

          <ul role="listbox" aria-label={title || ariaLabel} className="pb-2">
            {allowClear && !query && (
              <Row label={clearLabel} selected={!value && value !== 0} muted onPick={() => choose('')} />
            )}
            {visible.map((o) => (
              <Row key={o.value} label={o.label} hint={o.hint} selected={same(o.value, value)} onPick={() => choose(o.value)} />
            ))}
            {visible.length === 0 && <li className="px-5 py-6 text-sm text-text-muted">{query ? 'No matches.' : emptyText}</li>}
          </ul>

          {onCreate && (
            <div className="border-t border-line px-5 py-3">
              {!creating ? (
                <button type="button" onClick={() => setCreating(true)} className="w-full min-h-[48px] text-left text-sm font-medium text-ink">+ {createLabel}</button>
              ) : (
                <div>
                  <div className="flex gap-2">
                    <input
                      value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus placeholder="Name"
                      onKeyDown={(e) => { if (e.key === 'Enter') submitNew(e); }}
                      className="flex-1 min-w-0 px-3 py-2.5 rounded-lg border border-line bg-surface text-base outline-none focus:border-accent"
                    />
                    <button type="button" onClick={submitNew} disabled={busy || !newName.trim()} className="px-4 min-h-[44px] rounded-lg bg-ink text-white text-sm font-medium disabled:opacity-50">
                      {busy ? '…' : 'Add'}
                    </button>
                  </div>
                  {error && <p className="mt-2 text-sm text-danger">{error}</p>}
                </div>
              )}
            </div>
          )}
        </Sheet>,
        document.body
      )}
    </>
  );
}

function Row({ label, hint, selected, muted, onPick }) {
  return (
    <li>
      <button
        type="button" role="option" aria-selected={selected} onClick={onPick}
        className={`w-full min-h-[52px] px-5 py-2 flex items-center justify-between gap-3 text-left text-base hover:bg-paper active:bg-paper ${selected ? 'font-medium' : ''} ${muted ? 'text-text-muted' : ''}`}
      >
        <span className="min-w-0">
          <span className="block truncate">{label}</span>
          {hint && <span className="block text-xs text-text-muted truncate">{hint}</span>}
        </span>
        {selected && <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" className="shrink-0 text-success"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>
    </li>
  );
}

/** A row of big buttons for choosing one of a few options (2-4): quicker than any dropdown on a phone. */
export function Segmented({ value, onChange, options, className = '', 'aria-label': ariaLabel }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`flex gap-1 p-1 rounded-xl bg-paper border border-line ${className}`}>
      {options.map((o) => {
        const on = same(o.value, value);
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={`flex-1 min-h-[44px] px-2 rounded-lg text-sm font-medium transition-colors ${on ? 'bg-ink text-white shadow-sm' : 'text-text-muted hover:text-text'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
