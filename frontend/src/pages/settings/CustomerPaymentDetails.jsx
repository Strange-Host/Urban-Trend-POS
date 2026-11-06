import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { SectionCard, Field, inputCls } from '../../components/SettingsUI';
import { useToast } from '../../context/UIContext';
import { btnPrimary } from './buttons';
import useSettings from './useSettings';

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
