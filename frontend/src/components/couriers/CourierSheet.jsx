import { useState } from 'react';
import Sheet from '../Sheet';
import TabBar from '../TabBar';
import { StatusPill } from '../DataUI';
import CostsTab from './CostsTab';
import PayablesTab from './PayablesTab';
import PayoutsTab from './PayoutsTab';
import { StandingTab, CollectionsTab, StatementsTab } from './OrgTabs';

// Which tabs a courier gets, for this viewer. The API splits couriers in two and each half rejects the other's
// calls (payables are riders only; standing / collections / statements are organizations only), and every call
// has its own permission, so a tab shows only when the viewer could actually use what is in it.
export function availableTabs(courier, can) {
  if (courier.kind === 'organization') {
    return can('couriers.settle')
      ? [{ key: 'standing', label: 'Standing' }, { key: 'collections', label: 'Collections' }, { key: 'statements', label: 'Statements' }]
      : [];
  }
  const tabs = [];
  if (can('couriers.costs.approve') || can('couriers.costs.record')) tabs.push({ key: 'costs', label: 'Costs' });
  if (can('couriers.pay')) tabs.push({ key: 'payables', label: 'Payables' }, { key: 'payouts', label: 'Payouts' });
  return tabs;
}

const PANES = { costs: CostsTab, payables: PayablesTab, payouts: PayoutsTab, standing: StandingTab, collections: CollectionsTab, statements: StatementsTab };

export default function CourierSheet({ courier, tabs, initialTab, onClose }) {
  const [tab, setTab] = useState(tabs.some((t) => t.key === initialTab) ? initialTab : tabs[0]?.key);
  const Pane = PANES[tab];
  return (
    <Sheet onClose={onClose} size="lg" label={`${courier.name} payables`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="font-display font-700 text-lg truncate">{courier.name}</h2>
          <p className="text-xs text-text-muted mt-0.5">
            {courier.kind === 'organization' ? 'Courier organization' : 'Rider'}
            {courier.phone ? ` · ${courier.phone}` : ''}{' '}
            {!courier.is_active && <StatusPill tone="neutral">inactive</StatusPill>}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-sm text-text-muted hover:text-text shrink-0">Close</button>
      </div>
      <TabBar tabs={tabs} active={tab} onChange={setTab} variant="filter" className="mb-4" />
      {Pane && <Pane courier={courier} />}
    </Sheet>
  );
}
