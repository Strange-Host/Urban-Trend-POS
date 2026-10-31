import { useState } from 'react';
import TabBar from '../components/TabBar';
import PayrollRuns from './PayrollRuns';
import PayrollSummary from './PayrollSummary';
import PayTerms from './PayTerms';
import { useAuth } from '../context/AuthContext';

// Two views of the same money. "Pay runs" are the record: a period is calculated, reviewed, approved (which locks the
// figures for good) and paid. "Live summary" is the old calculator: one person, any dates, worked out from today's
// records, which can change tomorrow.
const TABS = [
  { key: 'runs', label: 'Pay runs' },
  { key: 'live', label: 'Live summary' },
];
// Pay terms (fixed / percentage / combined commission per person) move money, so only admins get the tab.
const ADMIN_TABS = [...TABS, { key: 'terms', label: 'Pay terms' }];

export default function Payroll() {
  const { user } = useAuth();
  const [tab, setTab] = useState('runs');
  return (
    <div>
      <TabBar tabs={user?.role === 'admin' ? ADMIN_TABS : TABS} active={tab} onChange={setTab} className="px-4 md:px-6 pt-4 md:pt-6" />
      {tab === 'runs' && <PayrollRuns />}
      {tab === 'live' && <PayrollSummary />}
      {tab === 'terms' && <PayTerms />}
    </div>
  );
}
