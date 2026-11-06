import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { paymentGatewaysApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { Field, inputCls } from '../../components/SettingsUI';
import { useDialog } from '../../context/UIContext';
import { GATEWAY_FIELDS, STK_TEST_MAX, STK_PHONE } from './gatewayFields';

export default function PaymentGatewayCard({ provider }) {
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const def = GATEWAY_FIELDS[provider];
  const { data: creds } = useQuery({
    queryKey: ['payment-gateways', provider],
    queryFn: () => paymentGatewaysApi.get(provider).then((r) => r.data.data),
  });

  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedWasOff, setSavedWasOff] = useState(false);
  const [actionBusy, setActionBusy] = useState(''); // '' | 'test' | 'register' | 'simulate'
  const [actionResult, setActionResult] = useState(null); // { ok, message } | null
  const [simForm, setSimForm] = useState({ amount: '10', msisdn: '254708374149', billRefNumber: '' });
  const [stkForm, setStkForm] = useState({ phone: '', amount: '1', reference: 'TEST' });

  useEffect(() => {
    if (creds !== undefined && !form) {
      const initial = { environment: creds?.environment || 'sandbox', webhook_secret: '' };
      for (const f of def.plain) initial[f.key] = creds?.[f.key] || '';
      for (const f of def.secret) initial[f.key] = '';
      setForm(initial);
    }
  }, [creds]);

  if (!form) return null;

  const hasCredentials = def.coreSecret.every((key) => creds?.[`has_${key}`]);
  const switchedOff = Boolean(creds) && !creds.is_active;
  // Only a gateway that is set up AND switched on can be tested or used; the server ignores a switched-off one.
  const isConfigured = hasCredentials && !switchedOff;
  const stkAmount = Number(stkForm.amount);
  const stkValid = STK_PHONE.test(stkForm.phone.trim()) && stkForm.reference.trim() && stkAmount >= 1 && stkAmount <= STK_TEST_MAX;

  async function handleSwitchOff() {
    if (!(await dialog.confirm({
      title: `Switch off ${def.label}?`,
      message: 'Incoming payments stop being matched to orders automatically and nothing can be sent through it. Your saved details are kept; saving them again switches it back on.',
      danger: true, confirmLabel: 'Switch off',
    }))) return;
    setError('');
    try {
      await paymentGatewaysApi.deactivate(provider);
      queryClient.invalidateQueries({ queryKey: ['payment-gateways'] });
      setActionResult(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not switch it off.'));
    }
  }

  // Sends a real PIN prompt to the phone. In production that is a real payment request, so it is confirmed first.
  async function handleStkPush() {
    if (creds?.environment === 'production' && !(await dialog.confirm({
      title: 'Send a real payment prompt?',
      message: `This is the live environment. ${stkForm.phone.trim()} will get a real M-Pesa request for KES ${stkAmount}, and if they enter their PIN the money is really paid to you.`,
      confirmLabel: 'Send prompt',
    }))) return;
    setActionBusy('stk');
    setActionResult(null);
    try {
      const res = await paymentGatewaysApi.mpesaStkPush({
        phone: stkForm.phone.trim(), amount: stkAmount, accountReference: stkForm.reference.trim(),
      });
      const out = res.data.data || {};
      const accepted = out.ResponseCode === undefined || String(out.ResponseCode) === '0';
      setActionResult({
        ok: accepted,
        message: out.CustomerMessage || out.ResponseDescription || (accepted ? 'Prompt sent. Check the phone.' : 'Safaricom did not accept the prompt.'),
      });
    } catch (err) {
      setActionResult({ ok: false, message: getErrorMessage(err, 'Could not send the prompt.') });
    } finally {
      setActionBusy('');
    }
  }

  async function runAction(kind, fn) {
    setActionBusy(kind);
    setActionResult(null);
    try {
      const res = await fn();
      setActionResult({ ok: true, message: res.data.data?.message || 'Done.', full: res.data.data });
    } catch (err) {
      setActionResult({ ok: false, message: getErrorMessage(err, 'That failed.') });
    } finally {
      setActionBusy('');
    }
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // Only send a secret field if the admin actually typed something —
      // an empty string here would otherwise wipe out an already-saved
      // secret the person didn't mean to touch (see upsert()'s
      // "undefined leaves it alone" rule on the backend).
      const payload = { environment: form.environment };
      for (const f of def.plain) payload[f.key] = form[f.key];
      for (const f of def.secret) if (form[f.key]) payload[f.key] = form[f.key];
      if (form.webhook_secret) payload.webhook_secret = form.webhook_secret;

      setSavedWasOff(switchedOff);
      await paymentGatewaysApi.upsert(provider, payload);
      queryClient.invalidateQueries({ queryKey: ['payment-gateways'] });
      setForm({ ...form, ...Object.fromEntries(def.secret.map((f) => [f.key, ''])), webhook_secret: '' });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save these credentials.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-line rounded-lg p-3 sm:p-4 mb-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-medium text-sm">{def.label}</span>
        {switchedOff ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-danger-soft text-danger">Switched off</span>
        ) : isConfigured ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-success-soft text-success">Configured</span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full bg-line text-text-muted">Not configured</span>
        )}
      </div>

      <Field label="Environment">
        <div className="flex flex-wrap gap-2">
          {['sandbox', 'production'].map((env) => (
            <button
              type="button"
              key={env}
              onClick={() => setForm({ ...form, environment: env })}
              className={`px-3 py-1.5 rounded-lg text-sm border ${form.environment === env ? 'bg-ink text-white border-ink' : 'border-line text-text-muted'}`}
            >
              {env === 'sandbox' ? 'Sandbox' : 'Production'}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        {def.plain.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input className={inputCls} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          </Field>
        ))}
        {def.secret.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input
              type="password"
              className={inputCls}
              placeholder={creds?.[`has_${f.key}`] ? '•••• (unchanged)' : ''}
              value={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          </Field>
        ))}
      </div>

      <Field
        label="Webhook shared secret (optional)"
        hint={`Overrides the server-wide PAYMENT_WEBHOOK_SECRET for ${def.label} specifically. Whatever you set here must also be configured on ${provider === 'mpesa' ? "Safaricom's" : 'KCB\u2019s'} side as the value sent back in the X-Webhook-Secret header.`}
      >
        <input
          type="password"
          className={inputCls}
          placeholder={creds?.has_webhook_secret ? '•••• (unchanged)' : ''}
          value={form.webhook_secret}
          onChange={(e) => setForm({ ...form, webhook_secret: e.target.value })}
        />
      </Field>

      <div className="text-xs text-text-muted bg-line/40 rounded-lg p-3 mt-1 mb-3">
        {provider === 'mpesa' ? (
          <>
            "Register webhook URLs" below tells Safaricom exactly where to send payment notifications for this
            paybill — you don't need to paste a URL anywhere yourself. It requires <code className="font-mono">APP_BASE_URL</code> set
            in the backend's <code className="font-mono">.env</code> to a public HTTPS URL (an ngrok tunnel while developing, your
            real domain in production) and a webhook shared secret saved above.
          </>
        ) : (
          <>
            KCB's raw callback endpoint is <code className="font-mono">/api/integrations/payments/callbacks/kcb/&lt;webhook secret&gt;/callback</code> —
            register that URL (with your webhook shared secret from above substituted in) wherever KCB's Buni portal asks for it.
            The exact registration process varies by which KCB product you're subscribed to, so there's no one-click
            button for this one yet.
          </>
        )}{' '}
        Incoming payments matched by order code are applied automatically; anything that can't be matched lands in the
        reconciliation queue for manual review instead of being silently dropped.
      </div>

      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-success text-sm">Saved.</span>}

        <button
          onClick={() => runAction('test', () => paymentGatewaysApi.test(provider))}
          disabled={!isConfigured || !!actionBusy}
          className="px-3 py-1.5 rounded-lg border border-line text-xs disabled:opacity-50"
        >
          {actionBusy === 'test' ? 'Testing…' : 'Test connection'}
        </button>

        {Boolean(creds) && !switchedOff && (
          <button onClick={handleSwitchOff} disabled={!!actionBusy} className="px-3 py-1.5 rounded-lg border border-line text-xs text-danger disabled:opacity-50">
            Switch off
          </button>
        )}

        {provider === 'mpesa' && (
          <button
            onClick={() => runAction('register', () => paymentGatewaysApi.registerMpesaUrls())}
            disabled={!isConfigured || !!actionBusy}
            className="px-3 py-1.5 rounded-lg border border-line text-xs disabled:opacity-50"
          >
            {actionBusy === 'register' ? 'Registering…' : 'Register webhook URLs with Safaricom'}
          </button>
        )}
      </div>

      {actionResult && (
        <div className={`mt-3 px-3 py-2 rounded-lg text-sm ${actionResult.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {actionResult.message}
          {actionResult.ok && actionResult.full?.confirmationUrl && (
            <div className="mt-1 text-xs font-mono break-all opacity-80">{actionResult.full.confirmationUrl}</div>
          )}
        </div>
      )}

      {provider === 'mpesa' && (
        <div className="border-t border-line mt-4 pt-3">
          <div className="text-sm font-medium mb-2">Send a test payment prompt</div>
          <div className="text-xs text-text-muted mb-2">
            Sends an M-Pesa PIN prompt to a phone so you can check the gateway end to end without making a sale. Needs a webhook shared secret saved above.
            {creds?.environment === 'production' ? ' This gateway is live, so the prompt is real: keep the amount small.' : ''}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-3">
            <Field label="Phone (2547XXXXXXXX)">
              <input className={inputCls} inputMode="numeric" value={stkForm.phone} onChange={(e) => setStkForm({ ...stkForm, phone: e.target.value })} />
            </Field>
            <Field label={`Amount (KES, 1 to ${STK_TEST_MAX})`}>
              <input className={inputCls} type="number" min="1" max={STK_TEST_MAX} value={stkForm.amount} onChange={(e) => setStkForm({ ...stkForm, amount: e.target.value })} />
            </Field>
            <Field label="Reference" hint="Shown on the prompt. Leave as TEST so it matches no order.">
              <input className={inputCls} value={stkForm.reference} onChange={(e) => setStkForm({ ...stkForm, reference: e.target.value })} />
            </Field>
          </div>
          <button
            onClick={handleStkPush}
            disabled={!isConfigured || !!actionBusy || !stkValid}
            className="px-3 py-1.5 rounded-lg border border-line text-xs disabled:opacity-50"
          >
            {actionBusy === 'stk' ? 'Sending…' : 'Send test prompt'}
          </button>
        </div>
      )}

      {provider === 'mpesa' && form.environment === 'sandbox' && (
        <div className="border-t border-line mt-4 pt-3">
          <div className="text-sm font-medium mb-2">Send a sandbox test payment</div>
          <div className="text-xs text-text-muted mb-2">
            Fires a fake customer payment at your own shortcode via Safaricom's sandbox — the real way to test the
            whole pipeline (webhook → match → order) without a real phone or real money.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-3">
            <Field label="Amount (KES)">
              <input className={inputCls} value={simForm.amount} onChange={(e) => setSimForm({ ...simForm, amount: e.target.value })} />
            </Field>
            <Field label="Test phone (2547XXXXXXXX)">
              <input className={inputCls} value={simForm.msisdn} onChange={(e) => setSimForm({ ...simForm, msisdn: e.target.value })} />
            </Field>
            <Field label="Order product code" hint="e.g. UT004521 — the code this test payment should match against.">
              <input className={inputCls} value={simForm.billRefNumber} onChange={(e) => setSimForm({ ...simForm, billRefNumber: e.target.value })} />
            </Field>
          </div>
          <button
            onClick={() =>
              runAction('simulate', () =>
                paymentGatewaysApi.simulateMpesaPayment({
                  amount: parseFloat(simForm.amount),
                  msisdn: simForm.msisdn,
                  billRefNumber: simForm.billRefNumber,
                })
              )
            }
            disabled={!isConfigured || !!actionBusy || !simForm.billRefNumber}
            className="px-3 py-1.5 rounded-lg border border-line text-xs disabled:opacity-50"
          >
            {actionBusy === 'simulate' ? 'Sending…' : 'Send test payment'}
          </button>
        </div>
      )}
    </div>
  );
}
