import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi, incomeSourcesApi, backupsApi, paymentGatewaysApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { SectionCard, Field, inputCls } from '../components/SettingsUI';
import { useDialog } from '../context/UIContext';
import { CustomerPaymentDetails, SmsSection, WebFormLeadsSection } from './SettingsMessaging';
import { ServerAddressSection, EmailSection, KcbAdvancedSection, LiveSyncControls, LiveSyncSettings } from './SettingsSystem';
import { useSearchParams } from 'react-router-dom';
import { modulesApi } from '../api/endpoints';
import TabBar from '../components/TabBar';

const PLATFORM_LABEL = { shopify: 'Shopify', woocommerce: 'WooCommerce' };

/* ---------------------------- General settings ---------------------------- */

function GeneralSettings() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.get().then((r) => r.data.data) });
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (data && !form) setForm(data); }, [data]);

  if (!form) return <SectionCard title="Business & receipt">Loading…</SectionCard>;

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      // Only this card's own keys. Sending the whole settings object would
      // overwrite changes saved from other cards (SMS, payment details) with
      // whatever this form loaded earlier.
      await settingsApi.update({
        business_name: form.business_name, business_currency: form.business_currency,
        business_phone: form.business_phone, business_address: form.business_address,
        low_stock_default_reorder_level: form.low_stock_default_reorder_level, receipt_footer: form.receipt_footer,
      });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Business & receipt" description="Shown on receipts and used as defaults across the POS.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <Field label="Business name">
          <input className={inputCls} value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
        </Field>
        <Field label="Currency">
          <input className={inputCls} value={form.business_currency} onChange={(e) => setForm({ ...form, business_currency: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input className={inputCls} value={form.business_phone} onChange={(e) => setForm({ ...form, business_phone: e.target.value })} />
        </Field>
        <Field label="Address">
          <input className={inputCls} value={form.business_address} onChange={(e) => setForm({ ...form, business_address: e.target.value })} />
        </Field>
        <Field label="Default low-stock reorder level">
          <input className={inputCls} value={form.low_stock_default_reorder_level} onChange={(e) => setForm({ ...form, low_stock_default_reorder_level: e.target.value })} />
        </Field>
      </div>
      <Field label="Receipt footer">
        <textarea rows={2} className={inputCls} value={form.receipt_footer} onChange={(e) => setForm({ ...form, receipt_footer: e.target.value })} />
      </Field>
      <div className="flex items-center gap-3 mt-2">
        <button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="text-success text-sm">Saved.</span>}
      </div>
    </SectionCard>
  );
}

/* -------------------------------- Backups -------------------------------- */

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function BackupsSection() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [error, setError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [recipients, setRecipients] = useState(null);
  const [savingRecipients, setSavingRecipients] = useState(false);
  const [recipientsSaved, setRecipientsSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: () => backupsApi.list().then((r) => r.data),
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.get().then((r) => r.data.data) });
  const backups = data?.data;
  const emailConfigured = data?.emailConfigured;
  const lastEmail = data?.lastEmail;

  useEffect(() => { if (settings && recipients === null) setRecipients(settings.backup_email_recipients || ''); }, [settings]);

  async function handleRunNow() {
    setRunning(true);
    setError('');
    try {
      await backupsApi.run();
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    } catch (err) {
      setError(getErrorMessage(err, 'Backup failed.'));
    } finally {
      setRunning(false);
    }
  }

  async function handleEmailNow() {
    setEmailing(true);
    setEmailError('');
    try {
      await backupsApi.emailNow();
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    } catch (err) {
      setEmailError(getErrorMessage(err, 'Could not send backup email.'));
    } finally {
      setEmailing(false);
    }
  }

  async function handleSaveRecipients() {
    setSavingRecipients(true);
    setRecipientsSaved(false);
    try {
      await settingsApi.update({ backup_email_recipients: recipients });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['backups'] }); // emailConfigured depends on this
      setRecipientsSaved(true);
      setTimeout(() => setRecipientsSaved(false), 2500);
    } finally {
      setSavingRecipients(false);
    }
  }

  return (
    <SectionCard
      title="Backups"
      description="The database is backed up automatically every 6 hours locally (last 7 days kept), and — when email is configured — a copy is also emailed off-machine every 24 hours."
    >
      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <button
        onClick={handleRunNow}
        disabled={running}
        className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50 mb-4 mr-2"
      >
        {running ? 'Backing up…' : 'Run backup now'}
      </button>

      {isLoading && <div className="text-text-muted text-sm">Loading…</div>}
      {backups?.length === 0 && !isLoading && (
        <div className="text-text-muted text-sm mb-4">
          No backups yet — the first automatic one runs 6 hours after the server starts, or click "Run backup now" above.
        </div>
      )}
      {backups?.length > 0 && (
        <div className="text-sm divide-y divide-line mb-5">
          {backups.slice(0, 8).map((b) => (
            <div key={b.file} className="flex items-center justify-between py-2">
              <span className="font-mono text-xs text-text-muted">{b.file}</span>
              <span className="text-xs text-text-muted">{formatBytes(b.sizeBytes)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-4">
        <h3 className="text-sm font-medium mb-1">Email backups</h3>

        <Field label="Recipient emails" hint="Comma-separated — e.g. owner@urbantrends.com, backups@urbantrends.com. Saved here, no server restart needed.">
          <textarea
            rows={2}
            className={inputCls}
            value={recipients ?? ''}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="owner@urbantrends.com, backups@urbantrends.com"
          />
        </Field>
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={handleSaveRecipients}
            disabled={savingRecipients || recipients === null}
            className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
          >
            {savingRecipients ? 'Saving…' : 'Save recipients'}
          </button>
          {recipientsSaved && <span className="text-success text-sm">Saved.</span>}
        </div>

        {!emailConfigured ? (
          <p className="text-text-muted text-sm">
            Add at least one recipient above, and finish <b>Settings → Email (outgoing mail)</b> (Resend or SMTP). Both
            take effect immediately; no restart or server file editing is needed.
          </p>
        ) : (
          <>
            {emailError && <div className="mb-2 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{emailError}</div>}
            {lastEmail ? (
              <p className="text-text-muted text-sm mb-3">
                Last sent: {lastEmail.status === 'sent' ? (
                  <span className="text-success">{lastEmail.file} at {new Date(lastEmail.sentAt).toLocaleString()}</span>
                ) : (
                  <span className="text-danger">failed ({lastEmail.error}) at {new Date(lastEmail.sentAt).toLocaleString()}</span>
                )}
              </p>
            ) : (
              <p className="text-text-muted text-sm mb-3">No email backup sent yet — the first automatic one goes out 24 hours after the server starts.</p>
            )}
            <button
              onClick={handleEmailNow}
              disabled={emailing}
              className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50"
            >
              {emailing ? 'Sending…' : 'Send backup email now'}
            </button>
          </>
        )}
      </div>
    </SectionCard>
  );
}

/* ------------------------------ Payment gateways ------------------------------ */

const GATEWAY_FIELDS = {
  mpesa: {
    label: 'M-Pesa (Safaricom Daraja)',
    plain: [
      { key: 'mpesa_shortcode', label: 'Paybill / Till number', hint: 'Published to customers — this is what they pay to, not a secret.' },
      { key: 'mpesa_initiator_name', label: 'Initiator name', hint: 'Only needed for B2C (money going OUT — supplier/refund payments), not for receiving payments.' },
    ],
    // Required to receive/match incoming payments — "Configured" reflects only these.
    coreSecret: ['mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_passkey'],
    secret: [
      { key: 'mpesa_consumer_key', label: 'Consumer key' },
      { key: 'mpesa_consumer_secret', label: 'Consumer secret' },
      { key: 'mpesa_passkey', label: 'Passkey', hint: 'From the Daraja portal, used to validate STK push / C2B callbacks.' },
      { key: 'mpesa_initiator_password', label: 'Initiator password', hint: 'For B2C (money out) only — not required just to receive payments.' },
    ],
  },
  kcb: {
    label: 'KCB',
    plain: [
      { key: 'kcb_account_number', label: 'Account number' },
    ],
    coreSecret: ['kcb_client_id', 'kcb_api_key', 'kcb_api_secret'],
    secret: [
      { key: 'kcb_client_id', label: 'Client ID' },
      { key: 'kcb_api_key', label: 'API key' },
      { key: 'kcb_api_secret', label: 'API secret' },
    ],
  },
};

function PaymentGatewayCard({ provider }) {
  const queryClient = useQueryClient();
  const def = GATEWAY_FIELDS[provider];
  const { data: creds } = useQuery({
    queryKey: ['payment-gateways', provider],
    queryFn: () => paymentGatewaysApi.get(provider).then((r) => r.data.data),
  });

  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionBusy, setActionBusy] = useState(''); // '' | 'test' | 'register' | 'simulate'
  const [actionResult, setActionResult] = useState(null); // { ok, message } | null
  const [simForm, setSimForm] = useState({ amount: '10', msisdn: '254708374149', billRefNumber: '' });

  useEffect(() => {
    if (creds !== undefined && !form) {
      const initial = { environment: creds?.environment || 'sandbox', webhook_secret: '' };
      for (const f of def.plain) initial[f.key] = creds?.[f.key] || '';
      for (const f of def.secret) initial[f.key] = '';
      setForm(initial);
    }
  }, [creds]);

  if (!form) return null;

  const isConfigured = def.coreSecret.every((key) => creds?.[`has_${key}`]);

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

      await paymentGatewaysApi.upsert(provider, payload);
      queryClient.invalidateQueries({ queryKey: ['payment-gateways', provider] });
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
        {isConfigured ? (
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

function PaymentGatewaysSection() {
  return (
    <SectionCard
      title="Payment gateways (M-Pesa & KCB)"
      description="Credentials for matching incoming payments to orders automatically, and (where supported) sending payments out — e.g. supplier refunds. Secret fields are encrypted at rest and never sent back to the browser once saved."
    >
      <PaymentGatewayCard provider="mpesa" />
      <PaymentGatewayCard provider="kcb" />
    </SectionCard>
  );
}

function IncomeSourceForm({ initial, onCancel, onSaved }) {
  const isEdit = !!initial?.id;
  const [platform, setPlatform] = useState(initial?.platform || 'shopify');
  const [form, setForm] = useState({
    name: initial?.name || '',
    shop_domain: initial?.shop_domain || '',
    api_key: initial?.api_key || '',
    api_secret: '',
    site_url: initial?.site_url || '',
    consumer_key: '',
    consumer_secret: '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const payload = { name: form.name, platform };
      if (platform === 'shopify') {
        Object.assign(payload, {
          shop_domain: form.shop_domain,
          api_key: form.api_key,
          api_secret: form.api_secret,
        });
      } else {
        Object.assign(payload, {
          site_url: form.site_url,
          consumer_key: form.consumer_key,
          consumer_secret: form.consumer_secret,
        });
      }
      if (isEdit) await incomeSourcesApi.update(initial.id, payload);
      else await incomeSourcesApi.create(payload);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save this income source.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-line rounded-lg p-3 sm:p-4 bg-paper mb-4">
      <Field label="Display name" hint='e.g. "Urban Trends – Main Shopify" or "Sister store WooCommerce"'>
        <input required className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>

      {!isEdit && (
        <Field label="Platform">
          <div className="flex flex-wrap gap-2">
            {['shopify', 'woocommerce'].map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => setPlatform(p)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${platform === p ? 'bg-ink text-white border-ink' : 'border-line text-text-muted'}`}
              >
                {PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
        </Field>
      )}

      {platform === 'shopify' ? (
        <>
          <Field label="Shop domain" hint="e.g. urban-trends.myshopify.com">
            <input className={inputCls} value={form.shop_domain} onChange={(e) => setForm({ ...form, shop_domain: e.target.value })} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Client ID" hint="From your app's Settings page in the Shopify Dev Dashboard">
              <input className={inputCls} value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
            </Field>
            <Field label="Client secret">
              <input type="password" className={inputCls} placeholder={isEdit ? '•••• (unchanged)' : ''} value={form.api_secret} onChange={(e) => setForm({ ...form, api_secret: e.target.value })} />
            </Field>
          </div>
          <div className="text-xs text-text-muted bg-line/40 rounded-lg p-3 mt-1">
            That's all that's needed — save this, then click <strong>"Connect"</strong> on the source below. The POS
            exchanges these directly with Shopify for an access token (no browser redirect), and refreshes it
            automatically before every sync since these tokens expire every 24 hours.
          </div>
        </>
      ) : (
        <>
          <Field label="Site URL" hint="e.g. https://sisterstore.com">
            <input className={inputCls} value={form.site_url} onChange={(e) => setForm({ ...form, site_url: e.target.value })} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Consumer key" hint="WooCommerce → Settings → Advanced → REST API">
              <input type="password" className={inputCls} placeholder={isEdit ? '•••• (unchanged)' : ''} value={form.consumer_key} onChange={(e) => setForm({ ...form, consumer_key: e.target.value })} />
            </Field>
            <Field label="Consumer secret">
              <input type="password" className={inputCls} placeholder={isEdit ? '•••• (unchanged)' : ''} value={form.consumer_secret} onChange={(e) => setForm({ ...form, consumer_secret: e.target.value })} />
            </Field>
          </div>
        </>
      )}

      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {saving ? 'Saving…' : isEdit ? 'Save' : 'Add income source'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-line text-sm">Cancel</button>
      </div>
    </form>
  );
}

/* ---------------------------- Income source row ---------------------------- */

function IncomeSourceRow({ source, onEdit }) {
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);

  async function run(action, fn) {
    setBusy(action);
    setMessage(null);
    try {
      const { data } = await fn();
      setMessage({ ok: !(data.data?.failed > 0 || data.data?.hint), text: describeResult(action, data.data) });
      queryClient.invalidateQueries({ queryKey: ['income-sources'] });
      queryClient.invalidateQueries({ queryKey: ['shopify-staging'] });
      queryClient.invalidateQueries({ queryKey: ['sales'] });
    } catch (err) {
      setMessage({ ok: false, text: getErrorMessage(err, `${action} failed.`) });
    } finally {
      setBusy('');
    }
  }

  function describeResult(action, data) {
    if (action === 'connect') return `Connected. Granted scopes: ${data.scope || '(none — check the app\'s Admin API access scopes in the Dev Dashboard)'}.`;
    if (action === 'test') return data.message;
    if (action === 'sync-products') return `Pulled ${data.total} — ${data.created} new, ${data.updated} changed, ${data.unchanged} unchanged. Review on the Shopify sync page.`;
    if (action === 'sync-sales') {
      const parts = [`Found ${data.total} order${data.total === 1 ? '' : 's'}: ${data.imported} new`];
      if (data.updated) parts.push(`${data.updated} updated (cancelled / refunded / repriced)`);
      if (data.skipped) parts.push(`${data.skipped} already imported`);
      let text = `${parts.join(', ')}.`;
      if (data.oldest_order_at) text += ` Oldest: ${new Date(data.oldest_order_at).toLocaleDateString()}.`;
      if (data.failed) text += ` ${data.failed} could not be imported (${(data.errors || []).join('; ')}) - they will be retried on the next sync.`;
      if (data.hint) text += ` ${data.hint}`;
      return text;
    }
  }

  async function handleDeactivate() {
    if (!(await dialog.confirm({ message: `Disconnect "${source.name}"? Its sales history stays intact.`, danger: true }))) return;
    await incomeSourcesApi.remove(source.id);
    queryClient.invalidateQueries({ queryKey: ['income-sources'] });
  }

  const needsAuth = source.platform === 'shopify' && !source.has_access_token;
  const hasZeroScopes = source.platform === 'shopify' && source.has_access_token && !source.oauth_scopes;

  return (
    <div className="border border-line rounded-lg p-3 sm:p-4 mb-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{source.name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-line text-text-muted">{PLATFORM_LABEL[source.platform]}</span>
            {needsAuth ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-danger-soft text-danger">Needs connection</span>
            ) : hasZeroScopes ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-danger-soft text-danger">Connected, but no scopes granted</span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-success-soft text-success">Connected</span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-1 font-mono">
            {source.platform === 'shopify' ? source.shop_domain || '—' : source.site_url || '—'}
          </div>
          {source.platform === 'shopify' && !!source.has_access_token && (
            <div className="text-xs mt-1">
              <span className="text-text-muted">Granted scopes: </span>
              {source.oauth_scopes ? (
                <span className="font-mono">{source.oauth_scopes}</span>
              ) : (
                <span className="text-danger">none — check the app's Admin API access scopes in the Dev Dashboard, then reconnect.</span>
              )}
            </div>
          )}
          <div className="text-xs text-text-muted mt-1">
            Products last synced {source.last_synced_at ? new Date(source.last_synced_at).toLocaleString() : 'never'} ·
            {' '}Sales last synced {source.last_sales_synced_at ? new Date(source.last_sales_synced_at).toLocaleString() : 'never'}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {source.platform === 'shopify' && (
            <button
              onClick={() => run('connect', () => incomeSourcesApi.connect(source.id))}
              disabled={!!busy}
              className="px-3 py-1.5 rounded-lg bg-accent text-accent-ink text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'connect' ? 'Connecting…' : needsAuth ? 'Connect' : 'Reconnect'}
            </button>
          )}
          <button onClick={() => run('test', () => incomeSourcesApi.test(source.id))} disabled={!!busy} className="px-3 py-1.5 rounded-lg border border-line text-xs disabled:opacity-50">
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button onClick={() => run('sync-products', () => incomeSourcesApi.syncProducts(source.id))} disabled={!!busy} className="px-3 py-1.5 rounded-lg border border-line text-xs disabled:opacity-50">
            {busy === 'sync-products' ? 'Syncing…' : 'Sync products'}
          </button>
          <select
            aria-label="Sync sales"
            disabled={!!busy}
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              const opts = v === 'all' ? { all: true } : v === 'new' ? {} : { days: Number(v) };
              run('sync-sales', () => incomeSourcesApi.syncSales(source.id, opts));
            }}
            className="px-3 py-1.5 rounded-lg border border-line text-xs bg-surface disabled:opacity-50"
          >
            <option value="">{busy === 'sync-sales' ? 'Syncing…' : 'Sync sales ▾'}</option>
            <option value="new">New &amp; changed since last sync</option>
            <option value="30">Load the last 30 days</option>
            <option value="90">Load the last 90 days</option>
            <option value="365">Load the last 12 months</option>
            <option value="all">Load all history</option>
          </select>
          <button onClick={() => onEdit(source)} className="px-3 py-1.5 rounded-lg border border-line text-xs">Edit</button>
          <button onClick={handleDeactivate} className="px-3 py-1.5 rounded-lg text-xs text-danger hover:opacity-70">Disconnect</button>
        </div>
      </div>
      {message && (
        <div className={`mt-3 px-3 py-2 rounded-lg text-xs ${message.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {message.text}
        </div>
      )}
      <LiveSyncControls source={source} />
    </div>
  );
}

/* -------------------------------- Main page -------------------------------- */

const SETTINGS_TABS = [
  { key: 'business', label: 'Business' },
  { key: 'payments', label: 'Payments' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'stores', label: 'Stores' },
  { key: 'server', label: 'Server' },
];

// Optional parts of the system. Both ship OFF; switching one off hides its screens and closes its API,
// but never deletes anything - switch it back on and it is all there.
const MODULE_CHOICES = [
  {
    key: 'hr',
    title: 'HR & back office',
    detail: 'Attendance and clock-in, payroll, staff onboarding (documents and agreements) and requisitions.',
    offNote: 'While off, new leads and orders are shared out to every active cashier instead of only those who clocked in.',
  },
  {
    key: 'control',
    title: 'Control extras',
    detail: 'Per-person permission overrides, two-factor sign-in set-up, order disputes, and the "prepay only / watch" customer badges.',
    offNote: 'While off, permission overrides and two-factor sign-in that were already set keep being enforced; you just cannot change them.',
  },
];

function OptionalModulesSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['modules'], queryFn: () => modulesApi.get().then((r) => r.data.data) });
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState('');

  async function toggle(key, next) {
    setBusyKey(key); setError('');
    const previous = queryClient.getQueryData(['modules']);
    // Show the new state at once (and in the menu); put it back if the server refuses.
    queryClient.setQueryData(['modules'], (old) => ({ ...old, [key]: next }));
    try {
      await modulesApi.update({ [key]: next });
      await queryClient.invalidateQueries({ queryKey: ['modules'] });
    } catch (e) {
      queryClient.setQueryData(['modules'], previous);
      setError(getErrorMessage(e));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <SectionCard title="Optional modules" description="Switch off what your shop does not use to keep the menu and the system simple. Nothing is deleted.">
      {!data && <div className="text-text-muted text-sm">Loading…</div>}
      {data && MODULE_CHOICES.map((m) => (
        <label key={m.key} className="flex items-start gap-3 py-3 border-t border-line first:border-t-0 cursor-pointer">
          <input
            type="checkbox"
            checked={!!data[m.key]}
            disabled={busyKey === m.key}
            onChange={(e) => toggle(m.key, e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{m.title} <span className="font-normal text-text-muted">- {data[m.key] ? 'on' : 'off'}</span></span>
            <span className="block text-xs text-text-muted mt-0.5">{m.detail}</span>
            {!data[m.key] && <span className="block text-xs text-text-muted mt-1">{m.offNote}</span>}
          </span>
        </label>
      ))}
      {error && <div className="text-danger text-sm mt-2">{error}</div>}
    </SectionCard>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  // The open tab lives in the address (?tab=stores) so a refresh, the back button
  // and links from other pages (e.g. "turn on live sync") land on the right one.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab = SETTINGS_TABS.some((t) => t.key === requested) ? requested : 'business';
  function selectTab(key) {
    setSearchParams(key === 'business' ? {} : { tab: key }, { replace: true });
  }

  const { data: sources, isLoading } = useQuery({
    queryKey: ['income-sources'],
    queryFn: () => incomeSourcesApi.list().then((r) => r.data.data),
  });

  function closeForm() {
    setShowAdd(false);
    setEditing(null);
  }
  function handleSaved() {
    closeForm();
    queryClient.invalidateQueries({ queryKey: ['income-sources'] });
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <h1 className="font-display font-700 text-2xl mb-1">Settings</h1>
      <p className="text-text-muted text-sm mb-4">Business details, payments, messaging, your online stores, and the server.</p>

      <TabBar tabs={SETTINGS_TABS} active={tab} onChange={selectTab} className="mb-5 -mx-4 px-4 md:mx-0 md:px-0" />

      {tab === 'business' && (
        <>
          <OptionalModulesSection />
          <GeneralSettings />
          <CustomerPaymentDetails />
        </>
      )}

      {tab === 'payments' && (
        <>
          <PaymentGatewaysSection />
          <KcbAdvancedSection />
        </>
      )}

      {tab === 'messaging' && (
        <>
          <SmsSection />
          <WebFormLeadsSection />
        </>
      )}

      {tab === 'server' && (
        <>
          <ServerAddressSection />
          <EmailSection />
          <BackupsSection />
        </>
      )}

      {tab === 'stores' && (
      <SectionCard
        title="Income sources"
        description="Every place money comes in from — the register, and any number of Shopify or WooCommerce stores. Sales pulled in here show up in Sales History and analytics tagged by channel; nothing changes your local inventory automatically."
      >
        <LiveSyncSettings />
        {isLoading && <div className="text-text-muted text-sm">Loading…</div>}
        {sources?.length === 0 && !showAdd && (
          <div className="text-text-muted text-sm mb-3">No income sources connected yet — everything is attributed to the local register.</div>
        )}
        {sources?.map((s) => (
          editing?.id === s.id
            ? <IncomeSourceForm key={s.id} initial={editing} onCancel={closeForm} onSaved={handleSaved} />
            : <IncomeSourceRow key={s.id} source={s} onEdit={setEditing} />
        ))}

        {showAdd && <IncomeSourceForm onCancel={closeForm} onSaved={handleSaved} />}

        {!showAdd && !editing && (
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted">
            + Add income source
          </button>
        )}
      </SectionCard>
      )}
    </div>
  );
}
