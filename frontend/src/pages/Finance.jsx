import { useState } from 'react';
import PageHeader from '../components/shell/PageHeader';
import PageSection from '../components/shell/PageSection';
import Payments from './Payments';
import Expenses from './Expenses';
import CashSessions from './CashSessions';
import Couriers from './Couriers';
import DeliveryAreas from './DeliveryAreas';
import Custody from './Custody';
import { useAuth } from '../context/AuthContext';

// Merges Payments, Expenses, and Cash sessions under one sidebar entry,
// same "mini page" pattern Sales History already uses to separate Local
// Store / Shopify / WooCommerce — one tab bar switching which full page
// renders below it.
const TABS = [
  { key: 'payments', label: 'Payments' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'cash-sessions', label: 'Cash sessions' },
  { key: 'couriers', label: 'Couriers' },
  { key: 'custody', label: 'Custody', permission: 'custody.manage' },
  { key: 'delivery-rates', label: 'Delivery rates' },
];

export default function Finance() {
  const { can } = useAuth();
  const [tab, setTab] = useState('payments');
  // A tab with a `permission` shows only to people the API would let use it.
  const tabs = TABS.filter((t) => !t.permission || can(t.permission));

  return (
    <div>
      <PageHeader title="Finance" titleless padding="px-4 md:px-8 pt-4 md:pt-6" tabs={{ items: tabs, active: tab, onChange: setTab }} />
      <PageSection>
        {tab === 'payments' && <Payments />}
        {tab === 'expenses' && <Expenses />}
        {tab === 'cash-sessions' && <CashSessions />}
        {tab === 'couriers' && <Couriers />}
        {tab === 'custody' && can('custody.manage') && <Custody />}
        {tab === 'delivery-rates' && <DeliveryAreas />}
      </PageSection>
    </div>
  );
}
