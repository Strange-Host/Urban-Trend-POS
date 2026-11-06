import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi, smsApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { SectionCard, Field, inputCls } from '../../components/SettingsUI';
import { StatusPill } from '../../components/DataUI';
import { useDialog, useToast } from '../../context/UIContext';
import { btnPrimary, btnSecondary } from './buttons';
import useSettings from './useSettings';
import Toggle from './Toggle';

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
