import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { systemApi, incomeSourcesApi, settingsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { SectionCard, Field, inputCls } from '../components/SettingsUI';
import { useToast, useDialog } from '../context/UIContext';

const btnPrimary = 'px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50';
const btnSecondary = 'px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50';

// Everything here used to mean editing backend/.env on the server and restarting it. It is
// saved in the app now and takes effect immediately.
function useSystemConfig() {
  return useQuery({ queryKey: ['system-config'], queryFn: () => systemApi.getConfig().then((r) => r.data.data) });
}

function EnvNote({ show }) {
  if (!show) return null;
  return <p className="text-[11px] text-text-muted -mt-2 mb-3">Currently coming from the server's old settings file. Save a value here to replace it.</p>;
}

/* ------------------------------- Public address ------------------------------- */

export function ServerAddressSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data } = useSystemConfig();
  const [url, setUrl] = useState(null);
  const [origins, setOrigins] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState(null);

  useEffect(() => {
    if (data && url === null) { setUrl(data.effective.public_base_url || ''); setOrigins((data.effective.allowed_origins || '').split(',').filter(Boolean).join('\n')); }
  }, [data]);
  if (!data || url === null) return null;

  async function save() {
    setSaving(true);
    try {
      const res = await systemApi.saveConfig({ values: { public_base_url: url.trim(), allowed_origins: origins.split(/[\s,]+/).filter(Boolean).join(',') } });
      setUrl(res.data.data.effective.public_base_url || '');
      queryClient.invalidateQueries({ queryKey: ['system-config'] });
      toast.success('Saved. It applies immediately - no restart needed.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not save.'));
    } finally { setSaving(false); }
  }

  async function runCheck() {
    setChecking(true); setCheck(null);
    try { setCheck((await systemApi.checkPublicUrl(url.trim() || undefined)).data.data); }
    catch (err) { setCheck({ reachable: false, message: getErrorMessage(err, 'Could not run the check.') }); }
    finally { setChecking(false); }
  }

  const fromEnv = data.from_environment.includes('public_base_url');
  return (
    <SectionCard
      title="Server & public address"
      description="The internet address other companies use to reach this system. Safaricom (M-Pesa) and KCB need it to tell you about payments, and your website needs it to send you leads."
    >
      <Field label="Public web address" hint="Starts with https:// - for example https://pos.yourshop.co.ke, or the address your tunnel (ngrok) gives you while testing. No trailing slash. It must not contain the words “mpesa” or “safaricom”.">
        <input className={inputCls} value={url} onChange={(e) => { setUrl(e.target.value); setCheck(null); }} placeholder="https://pos.yourshop.co.ke" inputMode="url" />
      </Field>
      <EnvNote show={fromEnv} />

      {check && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-sm ${check.reachable && check.looks_like_pos ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>{check.message}</div>
      )}

      <details className="mb-4 border border-line rounded-lg p-3">
        <summary className="text-sm font-medium cursor-pointer">Advanced: allowed website addresses</summary>
        <p className="text-xs text-text-muted mt-2 mb-2">
          Leave this empty and the system works from this computer and anything on your shop network (phones, tablets on the same WiFi). Only fill it in if your
          <b> web app is hosted on a public address</b> (for example a Vercel site) - then list it here, one per line, e.g. <span className="font-mono">https://app.yourshop.co.ke</span>. Once you list any address, ONLY the listed ones are allowed.
        </p>
        <textarea className={`${inputCls} font-mono text-xs`} rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://app.yourshop.co.ke" />
      </details>

      <div className="flex flex-wrap gap-2">
        <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={runCheck} disabled={checking || !url.trim()} className={btnSecondary}>{checking ? 'Checking…' : 'Check this address'}</button>
      </div>
    </SectionCard>
  );
}

/* ---------------------------------- Email ---------------------------------- */

const PROVIDERS = [
  { label: 'Gmail', host: 'smtp.gmail.com', port: '587', secure: false, note: 'Use a Google "App Password" as the password (Google Account → Security → 2-Step Verification → App passwords). Your normal password will not work.' },
  { label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: '587', secure: false, note: 'Use your full email address as the username.' },
  { label: 'Other', host: '', port: '587', secure: false, note: 'Ask your email provider for the "SMTP" (outgoing mail) server name and port.' },
];

const METHODS = [
  { id: 'resend', title: 'Resend', sub: 'Sends over the web (HTTPS). Works on any host, including Railway Hobby.' },
  { id: 'smtp', title: 'SMTP', sub: 'A mail server such as Gmail or Outlook. Some hosts block this.' },
];

export function EmailSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();
  const { data } = useSystemConfig();
  const [f, setF] = useState(null);
  const [method, setMethod] = useState('smtp');
  const [password, setPassword] = useState('');
  const [resendKey, setResendKey] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (data && !f) {
      const e = data.effective;
      setMethod(e.mail_provider === 'resend' ? 'resend' : 'smtp');
      setF({
        smtp_host: e.smtp_host, smtp_port: String(e.smtp_port), smtp_secure: !!e.smtp_secure, smtp_user: e.smtp_user,
        smtp_from: data.values.smtp_from || '', resend_from: data.values.resend_from || '',
      });
    }
  }, [data]);
  if (!data || !f) return null;

  const set = (k, v) => setF({ ...f, [k]: v });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['system-config'] });
  const savedMethod = data.effective.mail_provider === 'resend' ? 'resend' : 'smtp';
  const configured = savedMethod === 'resend' ? Boolean(data.resend_api_key_set) : Boolean(data.effective.smtp_host);
  const unsavedSwitch = method !== savedMethod;

  async function save() {
    setSaving(true);
    try {
      const body = method === 'resend'
        ? { values: { mail_provider: 'resend', resend_from: f.resend_from.trim() }, ...(resendKey.trim() ? { resend_api_key: resendKey.trim() } : {}) }
        : {
          values: { mail_provider: 'smtp', smtp_host: f.smtp_host.trim(), smtp_port: f.smtp_port.trim(), smtp_secure: f.smtp_secure ? '1' : '0', smtp_user: f.smtp_user.trim(), smtp_from: f.smtp_from.trim() },
          ...(password ? { smtp_password: password } : {}),
        };
      await systemApi.saveConfig(body);
      setPassword(''); setResendKey(''); refresh();
      toast.success('Email settings saved. Press "Send test email" to check them.');
    } catch (err) { toast.error(getErrorMessage(err, 'Could not save the email settings.')); }
    finally { setSaving(false); }
  }

  async function removeSecret(kind) {
    const isKey = kind === 'resend';
    if (!(await dialog.confirm({ title: isKey ? 'Remove the saved Resend API key?' : 'Remove the saved email password?', message: 'Backups and alerts will stop being emailed until you enter one again.', danger: true, confirmLabel: 'Remove' }))) return;
    try {
      await systemApi.saveConfig({ values: {}, ...(isKey ? { clear_resend_api_key: true } : { clear_smtp_password: true }) });
      refresh(); toast.success(isKey ? 'API key removed.' : 'Password removed.');
    } catch (err) { toast.error(getErrorMessage(err, 'Could not remove it.')); }
  }

  async function sendTest() {
    setTesting(true); setResult(null);
    try { await systemApi.testEmail(testTo.trim()); setResult({ ok: true, text: `Sent to ${testTo.trim()}. Check that mailbox (and its spam folder).` }); }
    catch (err) { setResult({ ok: false, text: getErrorMessage(err, 'The test email could not be sent.') }); }
    finally { setTesting(false); }
  }

  return (
    <SectionCard
      title="Email (outgoing mail)"
      description="Lets the system email you database backups and warn you if a backup fails. Choose who receives them under Backups below."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label="How email is sent">
        {METHODS.map((m) => (
          <button
            key={m.id} type="button" role="radio" aria-checked={method === m.id} onClick={() => { setMethod(m.id); setNote(''); }}
            className={`text-left px-3 py-2.5 rounded-lg border text-sm ${method === m.id ? 'border-[var(--color-accent)] bg-accent/10' : 'border-line hover:border-text-muted'}`}
          >
            <div className="font-medium">{m.title}{savedMethod === m.id && configured ? <span className="ml-2 text-xs text-success">in use</span> : null}</div>
            <div className="text-xs text-text-muted mt-0.5">{m.sub}</div>
          </button>
        ))}
      </div>

      {method === 'resend' ? (
        <>
          <div className="mb-3 px-3 py-2 rounded-lg bg-accent/10 text-xs space-y-1">
            <div className="font-medium">Set up Resend (free):</div>
            <ol className="list-decimal pl-4 space-y-0.5">
              <li>Create an account at resend.com using the email address that should receive the backups.</li>
              <li>Open <b>API Keys</b> → <b>Create API Key</b> (Sending access is enough) and copy the key. It starts with <code className="font-mono">re_</code>.</li>
              <li>Paste it below, save, then send a test email to that same address.</li>
            </ol>
            <div className="text-text-muted">Until you verify a domain at resend.com → Domains, Resend only delivers to the address you signed up with. That is fine for backups sent to one owner address.</div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
            <Field label="Resend API key" hint={data.resend_api_key_set ? 'Saved - paste a new one only to replace it.' : 'Not saved yet.'}>
              <input type="password" className={inputCls} autoComplete="new-password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder={data.resend_api_key_set ? '••••••••••••' : 're_...'} />
            </Field>
            <Field label="Send from (optional)" hint="Leave blank to use Resend's test sender (onboarding@resend.dev). Only change it after you verify a domain.">
              <input className={inputCls} value={f.resend_from} onChange={(e) => set('resend_from', e.target.value)} placeholder="Urban Trends <backups@yourdomain.com>" />
            </Field>
          </div>
          <EnvNote show={data.resend_source === 'environment' && !data.values.mail_provider} />
        </>
      ) : (
        <>
          <div className="mb-3 px-3 py-2 rounded-lg bg-accent/10 text-xs border border-accent/30">
            If this POS is hosted on Railway's Free, Trial or Hobby plan, outgoing SMTP is blocked there and the test will fail with "could not connect". Use <b>Resend</b> above instead.
          </div>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs text-text-muted">Quick fill:</span>
            {PROVIDERS.map((p) => (
              <button key={p.label} type="button" onClick={() => { setF({ ...f, smtp_host: p.host, smtp_port: p.port, smtp_secure: p.secure }); setNote(p.note); }}
                className="px-2.5 py-1 rounded-md border border-line text-xs hover:border-text-muted">{p.label}</button>
            ))}
          </div>
          {note && <div className="mb-3 px-3 py-2 rounded-lg bg-accent/10 text-xs">{note}</div>}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4">
            <Field label="Mail server"><input className={inputCls} value={f.smtp_host} onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.gmail.com" /></Field>
            <Field label="Port" hint="Usually 587.">
              <input className={inputCls} inputMode="numeric" value={f.smtp_port} onChange={(e) => set('smtp_port', e.target.value)} />
            </Field>
            <Field label="Secure connection (SSL/TLS)" hint="Off for port 587, on for port 465.">
              <label className="flex items-center gap-2 mt-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={f.smtp_secure} onChange={(e) => set('smtp_secure', e.target.checked)} /> Use SSL/TLS</label>
            </Field>
            <Field label="Username"><input className={inputCls} autoComplete="off" value={f.smtp_user} onChange={(e) => set('smtp_user', e.target.value)} placeholder="yourshop@gmail.com" /></Field>
            <Field label="Password" hint={data.smtp_password_set ? 'Saved - type only to replace it.' : 'Not saved yet.'}>
              <input type="password" className={inputCls} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={data.smtp_password_set ? '••••••••' : ''} />
            </Field>
            <Field label="Send from (optional)" hint="Defaults to the username.">
              <input className={inputCls} value={f.smtp_from} onChange={(e) => set('smtp_from', e.target.value)} placeholder="yourshop@gmail.com" />
            </Field>
          </div>
          <EnvNote show={data.from_environment.includes('smtp_host')} />
        </>
      )}

      <div className="flex flex-wrap gap-2 mb-5">
        <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save email settings'}</button>
        {method === 'resend' && data.resend_api_key_set && data.resend_source === 'settings' && <button onClick={() => removeSecret('resend')} className={btnSecondary}>Remove saved API key</button>}
        {method === 'smtp' && data.smtp_password_set && <button onClick={() => removeSecret('smtp')} className={btnSecondary}>Remove saved password</button>}
      </div>

      <div className="border border-line rounded-lg p-3 sm:p-4">
        <div className="font-medium text-sm mb-2">Send a test email</div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1"><Field label="Send it to"><input className={inputCls} inputMode="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" /></Field></div>
          <button onClick={sendTest} disabled={testing || !configured || unsavedSwitch || !testTo.trim()} className={`${btnSecondary} mb-3`}>{testing ? 'Sending…' : 'Send test email'}</button>
        </div>
        {unsavedSwitch && <p className="text-xs text-text-muted">You changed the method. Press "Save email settings" first, then test.</p>}
        {!unsavedSwitch && !configured && <p className="text-xs text-text-muted">{savedMethod === 'resend' ? 'Paste and save your Resend API key first.' : 'Fill in and save the mail server first.'}</p>}
        {result && <div className={`px-3 py-2 rounded-lg text-sm ${result.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>{result.text}</div>}
      </div>
    </SectionCard>
  );
}

/* ------------------------------- KCB advanced ------------------------------- */

export function KcbAdvancedSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data } = useSystemConfig();
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !f) setF({ sandbox: data.values.kcb_api_base_url_sandbox, production: data.values.kcb_api_base_url_production, tokenPath: data.values.kcb_token_path });
  }, [data]);
  if (!data || !f) return null;
  const d = data.effective.kcb;

  async function save() {
    setSaving(true);
    try {
      await systemApi.saveConfig({ values: { kcb_api_base_url_sandbox: f.sandbox.trim(), kcb_api_base_url_production: f.production.trim(), kcb_token_path: f.tokenPath.trim() } });
      queryClient.invalidateQueries({ queryKey: ['system-config'] });
      toast.success('KCB connection details saved. Press Test connection in the KCB block above.');
    } catch (err) { toast.error(getErrorMessage(err, 'Could not save.')); }
    finally { setSaving(false); }
  }

  return (
    <details className="bg-surface border border-line rounded-xl p-5 mb-6">
      <summary className="font-display font-700 text-base cursor-pointer">KCB connection details <span className="font-normal text-sm text-text-muted">(only if KCB tells you they are different)</span></summary>
      <p className="text-text-muted text-sm mt-3 mb-4">
        Normally leave these empty - the standard KCB Buni addresses are used. If “Test connection” fails and KCB gives you different addresses, enter them here.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4">
        <Field label="Practice (sandbox) address" hint={`Default: ${d.sandbox}`}><input className={inputCls} value={f.sandbox} onChange={(e) => setF({ ...f, sandbox: e.target.value })} placeholder={d.sandbox} /></Field>
        <Field label="Live (production) address" hint={`Default: ${d.production}`}><input className={inputCls} value={f.production} onChange={(e) => setF({ ...f, production: e.target.value })} placeholder={d.production} /></Field>
        <Field label="Login (token) path" hint={`Default: ${d.tokenPath}`}><input className={inputCls} value={f.tokenPath} onChange={(e) => setF({ ...f, tokenPath: e.target.value })} placeholder="/token" /></Field>
      </div>
      <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save KCB details'}</button>
    </details>
  );
}

/* ------------------------------- Live sync ------------------------------- */

function ago(sqliteUtc) {
  if (!sqliteUtc) return null;
  const t = Date.parse(`${sqliteUtc.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  const s = Math.max(Math.round((Date.now() - t) / 1000), 0);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Shown inside each connected store's row: is live sync on, is it actually receiving, and the on/off switch. */
export function LiveSyncControls({ source }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const { data: st } = useQuery({
    queryKey: ['live-sync', source.id],
    queryFn: () => incomeSourcesApi.liveSyncStatus(source.id).then((r) => r.data.data),
    refetchInterval: 20_000,
  });
  const connected = source.platform === 'shopify' ? source.has_access_token : source.has_consumer_key;
  if (!connected || !st) return null;

  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['live-sync', source.id] }); queryClient.invalidateQueries({ queryKey: ['income-sources'] }); };

  async function toggle() {
    setBusy(true); setOutcome(null);
    try {
      const res = st.enabled ? await incomeSourcesApi.liveSyncDisable(source.id) : await incomeSourcesApi.liveSyncEnable(source.id);
      setOutcome(res.data.data);
      refresh();
      toast.success(st.enabled ? 'Live sync turned off.' : (res.data.data.enabled ? 'Live sync turned on.' : 'Live sync could not be fully turned on - see the details.'));
    } catch (err) {
      setOutcome({ message: getErrorMessage(err, 'Could not change live sync.'), error: true });
    } finally { setBusy(false); }
  }

  const registered = st.topics.filter((t) => t.registered).length;
  const failed = st.events_24h.failed;
  return (
    <div className="mt-3 pt-3 border-t border-line">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Live sync</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${st.enabled ? 'bg-success-soft text-success' : 'bg-line text-text-muted'}`}>{st.enabled ? 'ON' : 'OFF'}</span>
        <button onClick={toggle} disabled={busy || (!st.enabled && !st.public_address_ready)} className="px-3 py-1 rounded-lg border border-line text-xs hover:border-text-muted disabled:opacity-50">
          {busy ? 'Working…' : st.enabled ? 'Turn off' : 'Turn on live sync'}
        </button>
        {st.enabled && (
          <span className="text-[11px] text-text-muted">
            {registered}/{st.topics.length} change types registered · last message {ago(st.last_webhook_at) || 'none yet'} · {st.events_24h.processed} handled today
            {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
          </span>
        )}
      </div>
      {!st.enabled && !st.public_address_ready && (
        <p className="text-[11px] text-text-muted mt-1.5">First enter your public https web address under <b>Server &amp; public address</b> (above) - the store needs it to know where to send changes.</p>
      )}
      <p className="text-[11px] text-text-muted mt-1.5">
        Safety net: every few minutes the system also asks this store what changed{st.last_poll_at ? ` (last check ${ago(st.last_poll_at)})` : ''}, so nothing is missed even if a message is lost.
        {st.last_poll_error && <span className="text-danger"> Last check failed: {st.last_poll_error}</span>}
      </p>
      {failed > 0 && st.recent_failures.length > 0 && (
        <p className="text-[11px] text-danger mt-1">Latest problem: {st.recent_failures[0].detail}</p>
      )}
      {outcome && (
        <div className={`mt-2 px-3 py-2 rounded-lg text-xs ${outcome.error || outcome.enabled === false && !outcome.problems ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}>
          {outcome.message || (outcome.problems?.length ? `Turned off, but: ${outcome.problems.join('; ')}` : 'Done.')}
          {outcome.results?.filter((r) => !r.ok).map((r) => <div key={r.topic} className="mt-0.5 text-text">• {r.topic}: {r.error}</div>)}
        </div>
      )}
      {(outcome?.manual || (st.manual && source.platform === 'woocommerce' && !st.enabled)) && (
        <div className="mt-2 px-3 py-2 rounded-lg border border-line text-xs">
          <div className="font-medium mb-1">Add the webhooks in WooCommerce by hand</div>
          <p className="text-text-muted mb-1">WooCommerce → Settings → Advanced → Webhooks → Add webhook. Create one for each topic below, status <b>Active</b>, API version <b>WP REST API Integration v3</b>, and paste these two values:</p>
          <div className="font-mono break-all">Delivery URL: {(outcome?.manual || st.manual).delivery_url}</div>
          <div className="font-mono break-all">Secret: {(outcome?.manual || st.manual).secret}</div>
          <div className="mt-1 text-text-muted">Topics: {(outcome?.manual || st.manual).topics.join(', ')}</div>
        </div>
      )}
    </div>
  );
}

/** Two global switches for live sync. */
export function LiveSyncSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.get().then((r) => r.data.data) });
  const [minutes, setMinutes] = useState(null);
  const [auto, setAuto] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings && minutes === null) { setMinutes(settings.live_poll_minutes ?? '10'); setAuto((settings.online_auto_import_orders ?? '1') === '1'); }
  }, [settings]);
  if (minutes === null) return null;

  async function save() {
    setSaving(true);
    try {
      await settingsApi.update({ live_poll_minutes: String(minutes), online_auto_import_orders: auto ? '1' : '0' });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Live sync settings saved.');
    } catch (err) { toast.error(getErrorMessage(err, 'Could not save.')); }
    finally { setSaving(false); }
  }

  return (
    <div className="border border-line rounded-lg p-3 sm:p-4 mb-4">
      <div className="font-medium text-sm mb-1">Live sync</div>
      <p className="text-xs text-text-muted mb-3">
        Turn on <b>Live sync</b> for a store (below) and its new orders and product changes arrive within seconds. Independently of that, the system re-checks every connected store on a timer as a safety net.
      </p>
      <label className="flex items-start gap-3 mb-3 cursor-pointer">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-accent)]" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span><span className="block text-sm font-medium">Add new to-ship orders to the Orders page automatically</span>
          <span className="block text-xs text-text-muted">Off = they appear in Sales history only, and you use “Pull online orders” when you want them in the Orders page.</span></span>
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Re-check every">
          <select className={inputCls} value={minutes} onChange={(e) => setMinutes(e.target.value)}>
            <option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option>
            <option value="30">30 minutes</option><option value="60">1 hour</option><option value="0">Never (webhooks only)</option>
          </select>
        </Field>
        <button onClick={save} disabled={saving} className={`${btnPrimary} mb-3`}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}
