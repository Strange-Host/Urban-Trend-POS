import { useState } from 'react';
import Sheet from './Sheet';
import { useToast } from '../context/UIContext';
import { loadPrinter, savePrinter, printTest, openDrawer, bridgeStatus, bridgeMessage } from '../utils/printer';

const inputCls = 'w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm focus:border-accent outline-none';

function Check({ id, checked, onChange, label, hint }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2.5 text-sm cursor-pointer">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-ink" />
      <span>{label}{hint && <span className="block text-xs text-text-muted">{hint}</span>}</span>
    </label>
  );
}

/** Per-till thermal printer settings (see print-bridge/README.md). Stored in this browser only. */
export default function PrinterSettings({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(loadPrinter);
  const [busy, setBusy] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function run(name, fn, ok) {
    setBusy(name);
    try { const r = await fn(); toast.success(typeof ok === 'function' ? ok(r) : ok); } catch (err) { toast.error(bridgeMessage(err)); } finally { setBusy(''); }
  }

  function save(e) {
    e.preventDefault();
    onSaved?.(savePrinter(form));
    toast.success('Printer settings saved on this till.');
    onClose();
  }

  const current = () => savePrinter(form); // test with what is on screen, and keep it

  return (
    <Sheet onClose={onClose} size="md" as="form" onSubmit={save} label="Printer settings">
      <h2 className="font-display font-700 text-lg mb-1">Printer</h2>
      <p className="text-sm text-text-muted mb-4">
        Off, the receipt opens the normal print dialog. On, it goes straight to the thermal printer, cuts the paper and can
        open the cash drawer. This needs the small print bridge running on this computer (see <code>print-bridge/README.md</code>).
        If the bridge can't be reached, the print dialog opens instead.
      </p>

      <div className="space-y-3">
        <Check id="pr-enabled" checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Print directly to the thermal printer" />
        <fieldset disabled={!form.enabled} className="space-y-3 disabled:opacity-50">
          <div>
            <label htmlFor="pr-url" className="block text-xs font-medium text-text-muted mb-1">Bridge address</label>
            <input id="pr-url" className={inputCls} value={form.bridgeUrl} onChange={(e) => set({ bridgeUrl: e.target.value })} placeholder="http://127.0.0.1:9101" />
          </div>
          <div>
            <label htmlFor="pr-cols" className="block text-xs font-medium text-text-muted mb-1">Paper width</label>
            <select id="pr-cols" className={inputCls} value={form.cols} onChange={(e) => set({ cols: Number(e.target.value) })}>
              <option value={48}>80 mm roll</option>
              <option value={32}>58 mm roll</option>
            </select>
          </div>
          <Check id="pr-cut" checked={form.cut} onChange={(v) => set({ cut: v })} label="Cut the paper after each receipt" />
          <Check id="pr-drawer" checked={form.drawerOnCash} onChange={(v) => set({ drawerOnCash: v })} label="Open the cash drawer when a sale includes cash" hint="Needs the drawer plugged into the printer." />
          <Check id="pr-auto" checked={form.autoPrint} onChange={(v) => set({ autoPrint: v })} label="Print as soon as a sale is charged" />
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" disabled={busy !== ''} onClick={() => run('status', () => bridgeStatus(current()), (p) => `Bridge is running (printer: ${p}).`)} className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50">{busy === 'status' ? 'Checking…' : 'Check bridge'}</button>
            <button type="button" disabled={busy !== ''} onClick={() => run('test', () => printTest(current()), 'Test sent. Check the printer.')} className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50">{busy === 'test' ? 'Sending…' : 'Print test'}</button>
            <button type="button" disabled={busy !== ''} onClick={() => run('drawer', () => openDrawer(current()), 'Drawer pulse sent.')} className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50">{busy === 'drawer' ? 'Sending…' : 'Open drawer'}</button>
          </div>
        </fieldset>
      </div>

      <div className="flex justify-end gap-2 mt-5">
        <button type="button" onClick={onClose} className="px-3.5 py-1.5 rounded-lg border border-line text-sm">Cancel</button>
        <button type="submit" className="px-3.5 py-1.5 rounded-lg bg-ink text-white text-sm font-medium">Save</button>
      </div>
    </Sheet>
  );
}
