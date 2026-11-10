import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { incomeSourcesApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { SectionCard, Field, inputCls } from '../../components/SettingsUI';
import { useDialog } from '../../context/UIContext';
import { LiveSyncControls, LiveSyncSettings } from '../SettingsSystem';
import { LoadingBlock } from '../../components/Skeleton';

const PLATFORM_LABEL = { shopify: 'Shopify', woocommerce: 'WooCommerce' };

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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
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
          <div className="text-xs text-text-muted mt-1 font-mono break-all">
            {source.platform === 'shopify' ? source.shop_domain || '—' : source.site_url || '—'}
          </div>
          {source.platform === 'shopify' && !!source.has_access_token && (
            <div className="text-xs mt-1 break-words">
              <span className="text-text-muted">Granted scopes: </span>
              {source.oauth_scopes ? (
                <span className="font-mono">{source.oauth_scopes.split(',').map((x) => x.trim()).filter(Boolean).join(', ')}</span>
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

export default function IncomeSourcesSection() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);

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
    <SectionCard
      title="Income sources"
      description="Every place money comes in from — the register, and any number of Shopify or WooCommerce stores. Sales pulled in here show up in Sales History and analytics tagged by channel; nothing changes your local inventory automatically."
    >
      <LiveSyncSettings />
      {isLoading && <LoadingBlock />}
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
  );
}
