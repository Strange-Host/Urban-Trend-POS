import { useState } from 'react';
import TabBar from '../components/TabBar';
import Payments from './Payments';
import Expenses from './Expenses';
import CashSessions from './CashSessions';
import Couriers from './Couriers';

// Merges Payments, Expenses, and Cash sessions under one sidebar entry,
// same "mini page" pattern Sales History already uses to separate Local
// Store / Shopify / WooCommerce — one tab bar switching which full page
// renders below it.
const TABS = [
  { key: 'payments', label: 'Payments' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'cash-sessions', label: 'Cash sessions' },
  { key: 'couriers', label: 'Couriers' },
];

export default function Finance() {
  const [tab, setTab] = useState('payments');

  return (
    <div>
      <TabBar tabs={TABS} active={tab} onChange={setTab} className="px-4 md:px-8 pt-4 md:pt-6" />
      {tab === 'payments' && <Payments />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'cash-sessions' && <CashSessions />}
      {tab === 'couriers' && <Couriers />}
    </div>
  );
}
