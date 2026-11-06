import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { leadRoutesApi, productsApi, staffApi } from '../../api/endpoints';
import { getErrorMessage, API_BASE_URL } from '../../api/client';
import { fetchAll } from '../../api/fetchAll';
import { SectionCard, Field, inputCls } from '../../components/SettingsUI';
import { useDialog, useToast } from '../../context/UIContext';
import { btnPrimary } from './buttons';

/* ------------------------- Web-form lead routing ------------------------- */

export function WebFormLeadsSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();
  const [form, setForm] = useState({ form_name: '', product_id: '', assigned_staff_id: '' });
  const [adding, setAdding] = useState(false);

  const { data: routes = [] } = useQuery({ queryKey: ['lead-routes'], queryFn: () => leadRoutesApi.list().then((r) => r.data.data) });
  const { data: products = [] } = useQuery({ queryKey: ['products', 'route-picker'], queryFn: () => fetchAll(productsApi.list) });
  const { data: staff = [] } = useQuery({ queryKey: ['staff', 'route-picker'], queryFn: () => fetchAll(staffApi.list) });
  const activeStaff = staff.filter((s) => s.status === 'active');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['lead-routes'] });
  const endpoint = `${API_BASE_URL}/integrations/leads/intake`;
  const [secret, setSecret] = useState(null);
  const [secretBusy, setSecretBusy] = useState(false);

  async function revealSecret() {
    setSecretBusy(true);
    try {
      const res = await leadRoutesApi.secret();
      setSecret(res.data.data.secret || '');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not load the secret.'));
    } finally {
      setSecretBusy(false);
    }
  }

  async function copySecret() {
    try { await navigator.clipboard.writeText(secret); toast.success('Copied.'); }
    catch { toast.error('Could not copy - select the text and copy it by hand.'); }
  }

  async function add() {
    setAdding(true);
    try {
      await leadRoutesApi.create({
        form_name: form.form_name.trim(),
        product_id: form.product_id ? Number(form.product_id) : null,
        assigned_staff_id: form.assigned_staff_id ? Number(form.assigned_staff_id) : null,
      });
      setForm({ form_name: '', product_id: '', assigned_staff_id: '' });
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not add the route.'));
    } finally {
      setAdding(false);
    }
  }

  async function toggle(r) {
    try { await leadRoutesApi.update(r.id, { is_active: !r.is_active }); refresh(); }
    catch (err) { toast.error(getErrorMessage(err, 'Could not update the route.')); }
  }

  async function remove(r) {
    if (!(await dialog.confirm({ title: `Delete the route for "${r.form_name}"?`, message: 'Leads from that form will still arrive, just without the product or fixed rep.', danger: true, confirmLabel: 'Delete' }))) return;
    try { await leadRoutesApi.remove(r.id); refresh(); }
    catch (err) { toast.error(getErrorMessage(err, 'Could not delete the route.')); }
  }

  return (
    <SectionCard
      title="Website form leads"
      description="Leads from your website forms (WPForms and similar) arrive here automatically. A route links a form to the product it advertises and, optionally, to a fixed rep; forms without a route still create leads and are shared out evenly."
    >
      <div className="border border-line rounded-lg p-3 sm:p-4 mb-4 text-sm">
        <div className="font-medium mb-2">Connect your form</div>
        <ol className="list-decimal pl-5 space-y-1 text-xs text-text-muted">
          <li>In your form plugin, add a webhook that POSTs JSON to <span className="font-mono text-text break-all">{endpoint}</span> (when the form is on your public website, use your server's public address in place of this one)</li>
          <li>
            Add a header <span className="font-mono text-text">X-Intake-Secret</span> with this install's secret (made for you automatically; kept out of the URL so it never reaches a log):
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {secret === null ? (
                <button type="button" onClick={revealSecret} disabled={secretBusy} className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium text-text hover:border-text-muted disabled:opacity-50">
                  {secretBusy ? 'Loading…' : 'Show secret'}
                </button>
              ) : secret === '' ? (
                <span className="text-danger">No secret is configured on the server.</span>
              ) : (
                <>
                  <span className="font-mono text-text break-all select-all bg-paper border border-line rounded px-2 py-1">{secret}</span>
                  <button type="button" onClick={copySecret} className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium text-text hover:border-text-muted">Copy</button>
                  <button type="button" onClick={() => setSecret(null)} className="text-xs hover:text-text">Hide</button>
                </>
              )}
            </div>
          </li>
          <li>Send the form name and entry id (WPForms: <span className="font-mono">formName</span>, <span className="font-mono">wpEntryId</span>) — the entry id stops a retried delivery creating a duplicate.</li>
        </ol>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2 items-end">
        <Field label="Form name (exactly as the form calls itself)">
          <input className={inputCls} value={form.form_name} onChange={(e) => setForm({ ...form, form_name: e.target.value })} placeholder="Leather Office Chair" />
        </Field>
        <Field label="Product">
          <select className={inputCls} value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
            <option value="">— none —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Always assign to">
          <select className={inputCls} value={form.assigned_staff_id} onChange={(e) => setForm({ ...form, assigned_staff_id: e.target.value })}>
            <option value="">Share evenly</option>
            {activeStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <button onClick={add} disabled={adding || !form.form_name.trim()} className={`${btnPrimary} mb-3`}>{adding ? 'Adding…' : 'Add route'}</button>
      </div>

      {routes.length === 0 ? (
        <div className="text-sm text-text-muted">No routes yet.</div>
      ) : (
        <div className="scroll-x border border-line rounded-lg">
          <table className="stack-sm w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-line">
                <th className="px-3 py-2 font-medium">Form</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">Assigned to</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id} className={`border-b border-line last:border-b-0 ${r.is_active ? '' : 'opacity-50'}`}>
                  <td className="px-3 py-2 font-medium">{r.form_name}</td>
                  <td className="px-3 py-2">{r.product_name || '—'}</td>
                  <td className="px-3 py-2">{r.staff_name || 'Shared evenly'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => toggle(r)} className="text-xs text-text-muted hover:text-text mr-3">{r.is_active ? 'Pause' : 'Resume'}</button>
                    <button onClick={() => remove(r)} className="text-xs text-danger hover:opacity-70">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
