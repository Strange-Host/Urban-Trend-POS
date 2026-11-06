import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../../api/endpoints';
import { SectionCard, Field, inputCls } from '../../components/SettingsUI';

/* ---------------------------- General settings ---------------------------- */

export default function GeneralSettings() {
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
        business_pin: form.business_pin, vat_rate_percent: form.vat_rate_percent,
        max_discount_percent: form.max_discount_percent, delivery_use_area_rates: form.delivery_use_area_rates,
        inventory_valuation_method: form.inventory_valuation_method, expiry_alert_days: form.expiry_alert_days,
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
        <Field label="KRA PIN" hint="Printed on invoices.">
          <input className={inputCls} value={form.business_pin ?? ''} onChange={(e) => setForm({ ...form, business_pin: e.target.value })} />
        </Field>
        <Field label="VAT rate (%)" hint="Used by the VAT report, which treats prices as VAT-inclusive.">
          <input className={inputCls} inputMode="decimal" value={form.vat_rate_percent ?? ''} onChange={(e) => setForm({ ...form, vat_rate_percent: e.target.value })} />
        </Field>
        <Field label="Largest cashier discount (%)" hint="Of the goods' list value, line and sale discounts together. 0 = no limit. Managers and admins are not held to it.">
          <input className={inputCls} inputMode="decimal" value={form.max_discount_percent ?? ''} onChange={(e) => setForm({ ...form, max_discount_percent: e.target.value })} />
        </Field>
        <Field label="Delivery fee source" hint="Delivery rates uses the area table (Finance → Delivery rates) when the town matches.">
          <select className={inputCls} value={form.delivery_use_area_rates ?? '1'} onChange={(e) => setForm({ ...form, delivery_use_area_rates: e.target.value })}>
            <option value="1">Delivery rates, then flat/percent rule</option>
            <option value="0">Flat/percent rule only</option>
          </select>
        </Field>
        <Field label="Stock valuation method" hint="FIFO values stock by the batch it came from; average uses a moving average. It sets the cost recorded on each new sale from now on. Sales already recorded keep the cost they were made with.">
          <select className={inputCls} value={form.inventory_valuation_method ?? 'fifo'} onChange={(e) => setForm({ ...form, inventory_valuation_method: e.target.value })}>
            <option value="fifo">FIFO (oldest batch first)</option>
            <option value="average">Average cost</option>
          </select>
        </Field>
        <Field label="Expiry alert (days before)" hint="Batches expiring within this many days raise an alert. 0 = only alert once expired.">
          <input className={inputCls} inputMode="numeric" value={form.expiry_alert_days ?? '30'} onChange={(e) => setForm({ ...form, expiry_alert_days: e.target.value })} />
        </Field>
      </div>
      <Field label="Receipt footer">
        <textarea rows={2} className={inputCls} value={form.receipt_footer} onChange={(e) => setForm({ ...form, receipt_footer: e.target.value })} />
      </Field>
      <div className="flex items-center gap-3 mt-2">
        <button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="text-success text-sm">{savedWasOff ? 'Saved and switched on.' : 'Saved.'}</span>}
      </div>
    </SectionCard>
  );
}
