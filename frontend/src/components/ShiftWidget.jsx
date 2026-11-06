import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cashSessionsApi, shiftApi } from '../api/endpoints';
import HandoverModal from './HandoverModal';
import { getErrorMessage } from '../api/client';

// Optional, not gating — checkout works with or without an open shift (a
// sale just isn't attributed to one if there isn't). This only exists so
// cash reconciliation (float in, cash sales, count at close) is possible
// for whoever wants to use it; nobody's forced into it.
// closeRequest: bump the number to open the close-shift form from outside (the till does this when it is opened with
// ?shift=close, from the Start screen's End shift tile or the rail's Shift item). 0 does nothing. Each new number is taken
// once, and only after the open shift is known: with no shift open there is nothing to close, so the request is dropped.
// Laid out as a narrow stack so it fits the till's category column as well as a phone.
export default function ShiftWidget({ closeRequest = 0 }) {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState(null); // null | 'opening' | 'closing'
  const [error, setError] = useState('');
  const [handover, setHandover] = useState(null); // open-items summary awaiting the person's decision
  const [closing, setClosing] = useState(false);
  const queryClient = useQueryClient();

  const { data: session, isSuccess: shiftKnown } = useQuery({
    queryKey: ['cash-session-current'],
    queryFn: () => cashSessionsApi.current().then((r) => r.data.data),
    refetchInterval: 30_000,
  });

  const handledRequest = useRef(0);
  useEffect(() => {
    if (closeRequest <= handledRequest.current || !shiftKnown) return;
    handledRequest.current = closeRequest;
    if (session) setMode('closing');
  }, [closeRequest, shiftKnown, session]);

  async function handleOpen(e) {
    e.preventDefault();
    setError('');
    try {
      await cashSessionsApi.open(Math.round(parseFloat(amount) * 100));
      queryClient.invalidateQueries({ queryKey: ['cash-session-current'] });
      setMode(null);
      setAmount('');
    } catch (err) {
      setError(getErrorMessage(err, 'Could not open shift.'));
    }
  }

  async function finishClose(notes) {
    setClosing(true);
    setError('');
    try {
      await cashSessionsApi.close(session.id, Math.round(parseFloat(amount) * 100), notes);
      queryClient.invalidateQueries({ queryKey: ['cash-session-current'] });
      setHandover(null);
      setMode(null);
      setAmount('');
    } catch (err) {
      setHandover(null);
      setError(getErrorMessage(err, 'Could not close shift.'));
    } finally {
      setClosing(false);
    }
  }

  async function handleClose(e) {
    e.preventDefault();
    setError('');
    // Show what they're leaving open, with a note box for their manager, every time. If that lookup fails, never
    // block closing the till over it — just carry on without the prompt.
    try {
      const { data } = await shiftApi.handover();
      setHandover(data.data);
      return;
    } catch { /* proceed without the prompt */ }
    await finishClose();
  }

  const handoverModal = handover && (
    <HandoverModal summary={handover} actionLabel={handover.has_open_items ? 'Close shift anyway' : 'Close shift'} busy={closing} onCancel={() => setHandover(null)} onConfirm={finishClose} />
  );

  const shell = 'rounded-lg border border-line bg-surface p-3 text-sm';
  const field = 'mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-2 outline-none focus:border-accent';
  const primary = 'min-h-11 flex-1 rounded-md bg-ink px-3 text-xs font-medium text-white';

  if (mode === 'opening') {
    return (
      <form onSubmit={handleOpen} className={shell}>
        <label className="block text-text-muted" htmlFor="shift-float">Opening float</label>
        <input id="shift-float" autoFocus type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
        <div className="mt-2 flex items-center gap-2">
          <button type="submit" className={primary}>Open shift</button>
          <button type="button" onClick={() => setMode(null)} className="min-h-11 px-2 text-xs text-text-muted">Cancel</button>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </form>
    );
  }

  if (mode === 'closing') {
    return (
      <form onSubmit={handleClose} className={shell}>
        <label className="block text-text-muted" htmlFor="shift-count">Cash counted in drawer</label>
        <input id="shift-count" autoFocus type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
        <div className="mt-2 flex items-center gap-2">
          <button type="submit" className={primary}>Close shift</button>
          <button type="button" onClick={() => setMode(null)} className="min-h-11 px-2 text-xs text-text-muted">Cancel</button>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        {handoverModal}
      </form>
    );
  }

  return (
    <div className={shell}>
      {session ? (
        <>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
            <span className="font-medium">Shift since {new Date(session.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div className="mt-0.5 text-xs text-text-muted">Float {(session.opening_amount / 100).toFixed(2)}</div>
          <button onClick={() => setMode('closing')} className="mt-2 min-h-11 w-full rounded-md border border-line text-xs font-medium text-danger hover:border-danger">Close shift</button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-line" />
            <span className="text-text-muted">No shift open</span>
          </div>
          <button onClick={() => setMode('opening')} className="mt-2 min-h-11 w-full rounded-md border border-line text-xs font-medium text-accent-text hover:border-accent">Open shift</button>
        </>
      )}
    </div>
  );
}
