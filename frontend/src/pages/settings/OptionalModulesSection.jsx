import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { modulesApi } from '../../api/endpoints';
import { SectionCard } from '../../components/SettingsUI';
import { LoadingBlock } from '../../components/Skeleton';

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

export default function OptionalModulesSection() {
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
      {!data && <LoadingBlock />}
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
