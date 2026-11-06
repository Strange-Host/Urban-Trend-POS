import { useQuery } from '@tanstack/react-query';
import { paymentGatewaysApi } from '../../api/endpoints';
import { SectionCard } from '../../components/SettingsUI';
import PaymentGatewayCard from './PaymentGatewayCard';
import { GATEWAY_FIELDS } from './gatewayFields';

/* ------------------------------ Payment gateways ------------------------------ */
// One line per provider, from the list endpoint: is it set up, switched on, and which environment.
function GatewayOverview() {
  const { data: rows, isError } = useQuery({
    queryKey: ['payment-gateways', 'list'],
    queryFn: () => paymentGatewaysApi.list().then((r) => r.data.data),
  });
  if (isError || !rows) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-2" aria-label="Gateway status">
      {Object.entries(GATEWAY_FIELDS).map(([provider, def]) => {
        const row = rows.find((r) => r.provider === provider);
        const set = row && def.coreSecret.every((key) => row[`has_${key}`]);
        const state = !set ? 'Not set up' : row.is_active ? 'Live' : 'Switched off';
        const tone = state === 'Live' ? 'bg-success-soft text-success' : state === 'Switched off' ? 'bg-danger-soft text-danger' : 'bg-line text-text-muted';
        return (
          <li key={provider} className={`text-xs px-2.5 py-1 rounded-full ${tone}`}>
            {def.label}: {state}{set ? ` (${row.environment})` : ''}
          </li>
        );
      })}
    </ul>
  );
}

export function PaymentGatewaysSection() {
  return (
    <SectionCard
      title="Payment gateways (M-Pesa & KCB)"
      description="Credentials for matching incoming payments to orders automatically, and (where supported) sending payments out — e.g. supplier refunds. Secret fields are encrypted at rest and never sent back to the browser once saved."
    >
      <GatewayOverview />
      <PaymentGatewayCard provider="mpesa" />
      <PaymentGatewayCard provider="kcb" />
    </SectionCard>
  );
}
