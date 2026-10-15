import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi, smsApi, leadRoutesApi, productsApi, staffApi } from '../api/endpoints';
import { getErrorMessage, API_BASE_URL } from '../api/client';
import { fetchAll } from '../api/fetchAll';
import { SectionCard, Field, inputCls } from '../components/SettingsUI';
import { StatusPill } from '../components/DataUI';
import { useDialog, useToast } from '../context/UIContext';

const btnPrimary = 'px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50';
const btnSecondary = 'px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50';

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.get().then((r) => r.data.data) });
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex items-start gap-3 mb-3 cursor-pointer">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

/* ------------------------- How customers pay (paybill) ------------------------- */

export function CustomerPaymentDetails() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: settings } = useSettings();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings && !form) setForm({ paybill_number: settings.paybill_number || '', kcb_account_prefix: settings.kcb_account_prefix || '' });
  }, [settings]);

  if (!form) return null;

  const prefix = form.kcb_account_prefix.trim().replace(/#+$/, '');
  const exampleAccount = prefix ? `${prefix}#UT000123` : 'UT000123';
  const exampleLine = form.paybill_number.trim()
    ? `Pay via Paybill ${form.paybill_number.trim()}, Account ${exampleAccount}.`
    : `Your payment reference: ${exampleAccount}.`;

  async function save() {
    setSaving(true);
    try {
      // Only this card's two keys — never the whole settings object, which could
      // overwrite changes made in another card with stale values.
      await settingsApi.update({ paybill_number: form.paybill_number.trim(), kcb_account_prefix: prefix });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Payment details saved.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not save payment details.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="How customers pay"
      description="Told to customers in their order SMS. Payments are matched to orders by the UT code, whether or not the prefix is typed."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <Field label="Paybill number" hint="Confirm this with KCB — the older system showed 522533 in SMS but 522522 on its receipt.">
          <input className={inputCls} inputMode="numeric" value={form.paybill_number} onChange={(e) => setForm({ ...form, paybill_number: e.target.value })} />
        </Field>
        <Field label="Account prefix (optional)" hint="Your KCB business key prefix, e.g. 8025631. Leave blank to use the bare code.">
          <input className={inputCls} value={form.kcb_account_prefix} onChange={(e) => setForm({ ...form, kcb_account_prefix: e.target.value })} />
        </Field>
      </div>
      <div className="text-xs text-text-muted mb-3">
        A customer will read: <span className="font-mono text-text">{exampleLine}</span>
      </div>
      <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save payment details'}</button>
    </SectionCard>
  );
}

/* ------------------------------ Customer SMS ------------------------------ */

const STATUS_TONE = { sent: 'success', failed: 'danger', expired: 'danger', queued: 'neutral', sending: 'neutral' };
const TEMPLATE_LABEL = { order_received: 'Order received', payment_received: 'Payment received', test: 'Test' };

function formatWhen(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

export function SmsSection() {
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const toast = useToast();

  const { data: status } = useQuery({ queryKey: ['sms', 'status'], queryFn: () => smsApi.status().then((r) => r.data.data), refetchInterval: 30_000 });
  const { data: settings } = useSettings();
  const { data: outbox } = useQuery({ queryKey: ['sms', 'outbox'], queryFn: () => smsApi.outbox({ limit: 10 }).then((r) => r.data.data), refetchInterval: 30_000 });

  const [cred, setCred] = useState({ user_id: '', password: '', sender_id: '' });
  const [credTouched, setCredTouched] = useState(false);
  const [savingCred, setSavingCred] = useState(false);

  const [opts, setOpts] = useState(null);
  const [savingOpts, setSavingOpts] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (status && !credTouched) setCred((c) => ({ ...c, sender_id: status.credentials.sender_id || '' }));
  }, [status]);

  useEffect(() => {
    if (settings && !opts) {
      setOpts({
        sms_enabled: settings.sms_enabled === '1',
        sms_send_order_received: settings.sms_send_order_received === '1',
        sms_send_payment_received: settings.sms_send_payment_received === '1',
        sms_message_type: settings.sms_message_type || 'unicode',
        sms_delivery_promise: settings.sms_delivery_promise || '',
        sms_catalog_url: settings.sms_catalog_url || '',
      });
    }
  }, [settings]);

  if (!status || !opts) return null;
  const configured = status.credentials.configured;
  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['sms'] });
    queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  async function saveCredentials() {
    setSavingCred(true);
    try {
      // Same rule as the payment gateway cards: a blank secret field means "leave
      // the saved one alone", never "wipe it".
      const payload = { sender_id: cred.sender_id.trim() };
      if (cred.user_id.trim()) payload.user_id = cred.user_id.trim();
      if (cred.password) payload.password = cred.password;
      await smsApi.saveCredentials(payload);
      setCred((c) => ({ ...c, user_id: '', password: '' }));
      setCredTouched(false);
      refreshAll();
      toast.success('SMS credentials saved.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not save SMS credentials.'));
    } finally {
      setSavingCred(false);
    }
  }

  async function removeCredentials() {
    if (!(await dialog.confirm({ title: 'Remove SMS credentials?', message: 'Queued messages will wait until new credentials are saved.', danger: true, confirmLabel: 'Remove' }))) return;
    try {
      await smsApi.removeCredentials();
      refreshAll();
      toast.success('SMS credentials removed.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not remove the credentials.'));
    }
  }

  async function saveOptions() {
    setSavingOpts(true);
    try {
      await settingsApi.update({
        sms_enabled: opts.sms_enabled ? '1' : '0',
        sms_send_order_received: opts.sms_send_order_received ? '1' : '0',
        sms_send_payment_received: opts.sms_send_payment_received ? '1' : '0',
        sms_message_type: opts.sms_message_type,
        sms_delivery_promise: opts.sms_delivery_promise.trim(),
        sms_catalog_url: opts.sms_catalog_url.trim(),
      });
      refreshAll();
      toast.success('SMS settings saved.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not save SMS settings.'));
    } finally {
      setSavingOpts(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await smsApi.sendTest(testTo.trim());
      setTestResult(res.data.data);
      refreshAll();
    } catch (err) {
      setTestResult({ ok: false, error: getErrorMessage(err, 'The test could not be sent.'), providerResponse: null });
    } finally {
      setTesting(false);
    }
  }

  async function retry(id) {
    try {
      await smsApi.retry(id);
      refreshAll();
      toast.info('Message re-queued — it will go out within 30 seconds.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not retry that message.'));
    }
  }

  const counts = status.last7Days || {};

  return (
    <SectionCard
      title="Customer SMS (Zettatel)"
      description="Texts customers when an order is received and when a payment arrives. Messages are queued and sent in the background, so a slow SMS provider never holds up an order."
    >
      <div className="border border-line rounded-lg p-3 sm:p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="font-medium text-sm">Zettatel account</div>
          <StatusPill tone={configured ? 'success' : 'neutral'}>{configured ? `Connected (${status.credentials.source})` : 'Not set up'}</StatusPill>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4">
          <Field label="User ID" hint={status.credentials.has_user_id ? 'Saved — type only to replace it.' : undefined}>
            <input className={inputCls} autoComplete="off" value={cred.user_id} placeholder={status.credentials.has_user_id ? '••••••••' : ''}
              onChange={(e) => { setCredTouched(true); setCred({ ...cred, user_id: e.target.value }); }} />
          </Field>
          <Field label="Password" hint={status.credentials.has_password ? 'Saved — type only to replace it.' : undefined}>
            <input type="password" className={inputCls} autoComplete="new-password" value={cred.password} placeholder={status.credentials.has_password ? '••••••••' : ''}
              onChange={(e) => { setCredTouched(true); setCred({ ...cred, password: e.target.value }); }} />
          </Field>
          <Field label="Sender ID" hint="The name customers see.">
            <input className={inputCls} value={cred.sender_id} onChange={(e) => { setCredTouched(true); setCred({ ...cred, sender_id: e.target.value }); }} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={saveCredentials} disabled={savingCred} className={btnPrimary}>{savingCred ? 'Saving…' : 'Save credentials'}</button>
          {status.credentials.has_user_id && <button onClick={removeCredentials} className={btnSecondary}>Remove</button>}
        </div>
      </div>

      <div className="border border-line rounded-lg p-3 sm:p-4 mb-4">
        <div className="font-medium text-sm mb-3">Send a test message</div>
        <p className="text-xs text-text-muted mb-3">
          Do this before switching SMS on. It sends straight away and shows exactly what Zettatel replied — that reply is how we confirm what a success and a rejection look like.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1">
            <Field label="Your phone number">
              <input className={inputCls} inputMode="tel" placeholder="0712 345 678" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
            </Field>
          </div>
          <button onClick={sendTest} disabled={testing || !configured || !testTo.trim()} className={`${btnSecondary} mb-3`}>
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
        {testResult && (
          <div className={`rounded-lg px-3 py-2 text-sm ${testResult.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
            {testResult.ok ? `Sent to ${testResult.to}. Check that it arrived.` : `Not sent: ${testResult.error}`}
            {testResult.providerResponse && (
              <div className="mt-2 font-mono text-xs break-all text-text">Zettatel replied: {testResult.providerResponse}</div>
            )}
          </div>
        )}
      </div>

      <div className="border border-line rounded-lg p-3 sm:p-4 mb-4">
        <div className="font-medium text-sm mb-3">What gets sent</div>
        <Toggle checked={opts.sms_enabled} onChange={(v) => setOpts({ ...opts, sms_enabled: v })}
          label="Send SMS to customers" hint={configured ? 'Master switch. Off means nothing is queued at all.' : 'Save your Zettatel credentials and send a test first.'} />
        <div className={opts.sms_enabled ? '' : 'opacity-50 pointer-events-none'}>
          <Toggle checked={opts.sms_send_order_received} onChange={(v) => setOpts({ ...opts, sms_send_order_received: v })} label="Order received" hint="Product, delivery promise and how to pay." />
          <Toggle checked={opts.sms_send_payment_received} onChange={(v) => setOpts({ ...opts, sms_send_payment_received: v })} label="Payment received" hint="Amount received, and any balance still due." />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
          <Field label="Delivery promise" hint="Added to the order message. Leave blank to omit.">
            <input className={inputCls} value={opts.sms_delivery_promise} onChange={(e) => setOpts({ ...opts, sms_delivery_promise: e.target.value })} />
          </Field>
          <Field label="Catalog link (optional)" hint="Added to the payment message.">
            <input className={inputCls} value={opts.sms_catalog_url} onChange={(e) => setOpts({ ...opts, sms_catalog_url: e.target.value })} />
          </Field>
          <Field label="Message encoding" hint="Unicode is what the live system uses. Plain text fits more characters per SMS — try it with a test first.">
            <select className={inputCls} value={opts.sms_message_type} onChange={(e) => setOpts({ ...opts, sms_message_type: e.target.value })}>
              <option value="unicode">Unicode (safe)</option>
              <option value="text">Plain text (cheaper)</option>
            </select>
          </Field>
        </div>
        <button onClick={saveOptions} disabled={savingOpts} className={btnPrimary}>{savingOpts ? 'Saving…' : 'Save SMS settings'}</button>
      </div>

      <div className="flex items-center justify-between mb-2">
        <div className="font-medium text-sm">Recent messages</div>
        <div className="text-xs text-text-muted">
          Last 7 days: {counts.sent || 0} sent · {counts.queued || 0} waiting · {(counts.failed || 0) + (counts.expired || 0)} not delivered
        </div>
      </div>
      {outbox?.length === 0 && <div className="text-sm text-text-muted">No messages yet. Order and payment texts will appear here.</div>}
      {outbox?.length > 0 && (
        <div className="scroll-x border border-line rounded-lg">
          <table className="stack-sm w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-line">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">To</th>
                <th className="px-3 py-2 font-medium">Message</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {outbox.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-b-0 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-text-muted">{formatWhen(m.sent_at || m.created_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{m.to_phone}</td>
                  <td className="px-3 py-2 text-xs">
                    <div className="font-medium">{TEMPLATE_LABEL[m.template] || m.template}</div>
                    {m.last_error && <div className="text-danger mt-0.5 break-words">{m.last_error}</div>}
                  </td>
                  <td className="px-3 py-2"><StatusPill tone={STATUS_TONE[m.status] || 'neutral'}>{m.status === 'queued' && m.attempts > 0 ? `retrying (${m.attempts})` : m.status}</StatusPill></td>
                  <td className="px-3 py-2 text-right">
                    {['failed', 'expired'].includes(m.status) && (
                      <button onClick={() => retry(m.id)} className="text-xs font-medium text-text-muted hover:text-text">Retry</button>
                    )}
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
