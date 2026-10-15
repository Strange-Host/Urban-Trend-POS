import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cashSessionsApi, shiftApi } from '../api/endpoints';
import HandoverModal from './HandoverModal';
import { getErrorMessage } from '../api/client';

// Optional, not gating — checkout works with or without an open shift (a
// sale just isn't attributed to one if there isn't). This only exists so
// cash reconciliation (float in, cash sales, count at close) is possible
// for whoever wants to use it; nobody's forced into it.
export default function ShiftWidget() {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState(null); // null | 'opening' | 'closing'
  const [error, setError] = useState('');
  const [handover, setHandover] = useState(null); // open-items summary awaiting the person's decision
  const [closing, setClosing] = useState(false);
  const queryClient = useQueryClient();

  const { data: session } = useQuery({
    queryKey: ['cash-session-current'],
    queryFn: () => cashSessionsApi.current().then((r) => r.data.data),
    refetchInterval: 30_000,
  });

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
    // Look at what they're leaving open first. If that lookup fails, never block
    // closing the till over it — just carry on without the prompt.
    try {
      const { data } = await shiftApi.handover();
      if (data.data.has_open_items) {
        setHandover(data.data);
        return;
      }
    } catch { /* proceed without the prompt */ }
    await finishClose();
  }

  const handoverModal = handover && (
    <HandoverModal summary={handover} actionLabel="Close shift anyway" busy={closing} onCancel={() => setHandover(null)} onConfirm={finishClose} />
  );

  if (mode === 'opening') {
    return (
      <form onSubmit={handleOpen} className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-line bg-surface text-sm">
        <span className="text-text-muted">Opening float</span>
        <input
          autoFocus type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)}
          className="w-24 px-2 py-1 rounded-md border border-line outline-none focus:border-accent"
        />
        <button type="submit" className="px-3 py-1 rounded-md bg-ink text-white text-xs font-medium">Open shift</button>
        <button type="button" onClick={() => setMode(null)} className="text-xs text-text-muted">Cancel</button>
        {error && <span className="text-danger text-xs">{error}</span>}
      </form>
    );
  }

  if (mode === 'closing') {
    return (
      <form onSubmit={handleClose} className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-line bg-surface text-sm">
        <span className="text-text-muted">Cash counted in drawer</span>
        <input
          autoFocus type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)}
          className="w-24 px-2 py-1 rounded-md border border-line outline-none focus:border-accent"
        />
        <button type="submit" className="px-3 py-1 rounded-md bg-ink text-white text-xs font-medium">Close shift</button>
        <button type="button" onClick={() => setMode(null)} className="text-xs text-text-muted">Cancel</button>
        {error && <span className="text-danger text-xs">{error}</span>}
        {handoverModal}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-line bg-surface text-sm">
      {session ? (
        <>
          <span className="w-2 h-2 rounded-full bg-success" />
          <span className="text-text-muted">Shift open since {new Date(session.opened_at).toLocaleTimeString()} — float {(session.opening_amount / 100).toFixed(2)}</span>
          <button onClick={() => setMode('closing')} className="ml-auto text-xs text-danger hover:opacity-70">Close shift</button>
        </>
      ) : (
        <>
          <span className="w-2 h-2 rounded-full bg-line" />
          <span className="text-text-muted">No shift open</span>
          <button onClick={() => setMode('opening')} className="ml-auto text-xs text-accent-ink hover:opacity-70">Open shift</button>
        </>
      )}
    </div>
  );
}
