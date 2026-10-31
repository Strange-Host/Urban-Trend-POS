import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveryAreasApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';
import { useAuth } from '../context/AuthContext';
import { inputCls } from '../components/SettingsUI';
import { parseRates } from '../utils/parseRates';

// The delivery-area rate card (Joyfull Cargo). When an order's town matches a row, that fee is used
// instead of the flat/percent rule. Fees are entered in KES and stored as cents.

const kes = (cents) => (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (v) => Math.round(parseFloat(String(v).replace(/[, ]/g, '')) * 100);

export default function DeliveryAreas() {
  const toast = useToast();
  const dialog = useDialog();
  const { can } = useAuth();
  const canManage = can('couriers.manage');
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ area_name: '', fee: '', courier_type: '' });
  const [editing, setEditing] = useState(null); // { id, fee }
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: areas = [], isLoading } = useQuery({
    queryKey: ['delivery-areas', { search }],
    queryFn: () => deliveryAreasApi.list({ all: 1, search: search || undefined }).then((r) => r.data.data),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['delivery-areas'] });

  async function run(fn, success) {
    setBusy(true);
    try { await fn(); if (success) toast.success(success); refresh(); return true; }
    catch (err) { toast.error(getErrorMessage(err)); return false; }
    finally { setBusy(false); }
  }

  async function add(e) {
    e.preventDefault();
    const fee = toCents(form.fee);
    if (!form.area_name.trim() || !Number.isFinite(fee) || fee < 0) { toast.error('Enter an area name and a fee in KES.'); return; }
    const ok = await run(() => deliveryAreasApi.create({ area_name: form.area_name.trim(), fee, courier_type: form.courier_type || null }), 'Area added.');
    if (ok) setForm({ area_name: '', fee: '', courier_type: '' });
  }

  async function saveFee(area) {
    const fee = toCents(editing.fee);
    if (!Number.isFinite(fee) || fee < 0) { toast.error('Enter the fee in KES.'); return; }
    if (await run(() => deliveryAreasApi.update(area.id, { fee }), 'Fee updated.')) setEditing(null);
  }

  async function remove(area) {
    if (!(await dialog.confirm({ message: `Remove ${area.area_name}? Orders to this town will go back to the flat/percent delivery fee.`, danger: true }))) return;
    await run(() => deliveryAreasApi.remove(area.id), 'Area removed.');
  }

  async function doImport() {
    const rows = parseRates(importText);
    if (!rows.length) { toast.error('Paste at least one line: area, fee.'); return; }
    await run(async () => {
      const res = await deliveryAreasApi.importRows(rows);
      const { created, updated } = res.data.data;
      toast.success(`Imported: ${created} added, ${updated} updated.`);
      setImportText('');
    });
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (file) setImportText(await file.text());
    e.target.value = '';
  }

  return (
    <div className="p-4 md:p-8">
      <h2 className="font-display font-700 text-xl tracking-tight mb-1">Delivery rates</h2>
      <p className="text-sm text-text-muted mb-4">The fee for each delivery area. A matching town sets the order's delivery fee; any other town uses the flat/percent rule.</p>

      {canManage && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <form onSubmit={add} className="bg-surface border border-line rounded-xl p-4">
            <div className="font-medium text-sm mb-3">Add an area</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input className={inputCls} placeholder="Area (e.g. Ruiru)" value={form.area_name} onChange={(e) => setForm({ ...form, area_name: e.target.value })} />
              <input className={inputCls} inputMode="decimal" placeholder="Fee (KES)" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} />
              <select className={inputCls} value={form.courier_type} onChange={(e) => setForm({ ...form, courier_type: e.target.value })}>
                <option value="">Courier: auto</option><option value="boda">Boda</option><option value="g4s">G4S</option>
              </select>
            </div>
            <button disabled={busy} className="mt-3 px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Add area</button>
          </form>

          <div className="bg-surface border border-line rounded-xl p-4">
            <div className="font-medium text-sm mb-1">Import the rate card</div>
            <p className="text-xs text-text-muted mb-2">One area per line: <code>area, fee in KES, courier (optional), notes (optional)</code>. Existing areas are updated, not duplicated. Nothing is saved if any line is invalid.</p>
            <textarea rows={4} className={inputCls} placeholder={'Ruiru, 350\nThika, 450, g4s'} value={importText} onChange={(e) => setImportText(e.target.value)} />
            <div className="flex items-center gap-3 mt-2">
              <button onClick={doImport} disabled={busy || !importText.trim()} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">Import</button>
              <label className="text-sm text-text-muted cursor-pointer underline">Load a .csv file<input type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={onFile} /></label>
            </div>
          </div>
        </div>
      )}

      <input className={`${inputCls} max-w-xs mb-3`} placeholder="Search areas…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="scroll-x">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line">
              {['Area', 'Fee (KES)', 'Courier', ''].map((h, i) => <th key={i} className={`font-mono text-[11px] uppercase tracking-wider text-text-muted px-4 py-2.5 ${i === 1 ? 'text-right' : 'text-left'}`}>{h}</th>)}
            </tr></thead>
            <tbody>
              {isLoading && <tr><td className="px-4 py-6 text-text-muted" colSpan={4}>Loading…</td></tr>}
              {!isLoading && areas.length === 0 && <tr><td className="px-4 py-8 text-center text-text-muted" colSpan={4}>{search ? 'No area matches.' : 'No delivery areas yet. Import the rate card above.'}</td></tr>}
              {areas.map((a) => (
                <tr key={a.id} className={`border-b border-line last:border-0 ${a.is_active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2.5">{a.area_name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {editing?.id === a.id
                      ? <input autoFocus className={`${inputCls} w-28 text-right`} inputMode="decimal" value={editing.fee} onChange={(e) => setEditing({ id: a.id, fee: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') saveFee(a); if (e.key === 'Escape') setEditing(null); }} />
                      : kes(a.fee)}
                  </td>
                  <td className="px-4 py-2.5">{a.courier_type ? (a.courier_type === 'g4s' ? 'G4S' : 'Boda') : 'Auto'}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {canManage && (editing?.id === a.id ? (
                      <>
                        <button onClick={() => saveFee(a)} disabled={busy} className="text-xs font-medium mr-3">Save</button>
                        <button onClick={() => setEditing(null)} className="text-xs text-text-muted">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setEditing({ id: a.id, fee: String(a.fee / 100) })} className="text-xs text-text-muted hover:text-text mr-3">Edit fee</button>
                        <button onClick={() => run(() => deliveryAreasApi.update(a.id, { is_active: !a.is_active }))} className="text-xs text-text-muted hover:text-text mr-3">{a.is_active ? 'Switch off' : 'Switch on'}</button>
                        <button onClick={() => remove(a)} className="text-xs text-danger">Remove</button>
                      </>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
