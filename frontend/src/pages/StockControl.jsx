import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { storesApi } from '../api/endpoints';
import Picker from '../components/Picker';
import PageHeader from '../components/shell/PageHeader';
import { useAuth } from '../context/AuthContext';
import ReceiveTab from './stock/ReceiveTab';
import IssueTab from './stock/IssueTab';
import TransfersTab from './stock/TransfersTab';
import CountsTab from './stock/CountsTab';
import ActivityTab from './stock/ActivityTab';
import BatchesTab from './stock/BatchesTab';
import CostingTab from './stock/CostingTab';
import { ReconcileTab } from './stock/ReconcileTab';


// Main-store inventory control: receiving shipments, issuing stock out, transfers between branches (with approval),
// outlet opening/closing counts, and a who-did-what log. Buying prices never appear here - the storekeeper does not
// see or enter them; the person who approves a new product adds it.

// Kept here so existing imports of ReconcileTab from this file keep working.
export { ReconcileTab };

export default function StockControl() {
  const { can } = useAuth();
  const [viewStore, setViewStore] = useState('');
  const { data: stores = [] } = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list().then((r) => r.data.data) });

  const tabs = [
    can('stock.receive') && { id: 'receive', label: 'Receive' },
    can('stock.receive') && { id: 'issue', label: 'Issue out' },
    can('stock.receive') && { id: 'batches', label: 'Batches & alerts' },
    can('products.view_cost') && can('stock.review') && { id: 'costing', label: 'Costing' },
    can('stock.transfer') && { id: 'transfers', label: 'Transfers' },
    can('stock.count') && { id: 'counts', label: 'Counts' },
    can('inventory.adjust') && { id: 'reconcile', label: 'Reconcile' },
    can('stock.review') && { id: 'activity', label: 'Who did what' },
  ].filter(Boolean);
  // /stock?tab=counts opens on that tab (the Start screen links here); anything else, or no parameter, opens on the first one.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => tabs.find((t) => t.id === searchParams.get('tab'))?.id ?? tabs[0]?.id);

  const current = stores.find((s) => s.is_current);
  const viewing = viewStore ? stores.find((s) => String(s.id) === String(viewStore)) : current;
  const isOwnStore = !viewStore || String(viewStore) === String(current?.id);
  const storeParams = isOwnStore ? {} : { store_id: viewStore };
  const canPickStore = can('stock.review') && stores.length > 1;

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <PageHeader
        title="Stock control"
        description={viewing ? `${viewing.name}${viewing.is_main ? ' (main store)' : ''}` : 'Receiving, transfers and counts.'}
        actions={canPickStore ? (
          <div className="sm:w-60">
            <Picker value={viewStore || (current ? String(current.id) : '')} onChange={(v) => setViewStore(String(v) === String(current?.id) ? '' : String(v))} title="Branch" aria-label="Branch"
              options={stores.map((s) => ({ value: String(s.id), label: s.name + (s.is_main ? ' (main)' : '') }))} />
          </div>
        ) : null}
        tabs={{ items: tabs.map((t) => ({ key: t.id, label: t.label })), active: tab, onChange: setTab, appearance: 'underline' }}
      />

      {tab === 'receive' && <ReceiveTab storeParams={storeParams} isMainStore={Boolean(viewing?.is_main) && isOwnStore} />}
      {tab === 'issue' && <IssueTab storeParams={storeParams} isOwnStore={isOwnStore} />}
      {tab === 'batches' && <BatchesTab storeParams={storeParams} isOwnStore={isOwnStore} />}
      {tab === 'costing' && <CostingTab storeParams={storeParams} />}
      {tab === 'transfers' && <TransfersTab stores={stores} />}
      {tab === 'counts' && <CountsTab storeParams={storeParams} isOwnStore={isOwnStore} />}
      {tab === 'reconcile' && <ReconcileTab storeParams={storeParams} stores={stores} />}
      {tab === 'activity' && <ActivityTab storeParams={storeParams} />}
    </div>
  );
}

