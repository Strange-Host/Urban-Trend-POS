import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { getErrorMessage } from '../api/client';
import { ordersApi } from '../api/endpoints';
import { PageHeader } from '../components/DataUI';
import DispatchSheet from '../components/DispatchSheet';
import EditItemsSheet from '../components/EditItemsSheet';
import NewOrderSheet from '../components/NewOrderSheet';
import { OwnerDecisionQueue, IntegrityPanel } from '../components/OrderAdminPanels';
import Pager, { usePager } from '../components/Pager';
import PullOnlineOrders from '../components/PullOnlineOrders';
import TabBar from '../components/TabBar';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../context/UIContext';
import useModules from '../hooks/useModules';
import usePendingDecisionCount from '../hooks/usePendingDecisionCount';
import OrderList from './orders/OrderList';
import OrderDetail from './orders/OrderDetail';
import { money, STATUS_LABELS, RETURN_REASONS, CHANNELS, CHANNEL_PARAM } from './orders/helpers';

export default function Orders() {
  const { hasRole } = useAuth();
  const dialog = useDialog();
  const modules = useModules();
  const isManager = hasRole('admin', 'manager');
  const isAdmin = hasRole('admin');
  const queryClient = useQueryClient();

  const pager = usePager(25);
  // Admin/manager-only views over the same screen: the order list, damaged returns waiting on the owner, and the data check.
  const [view, setView] = useState('orders');
  const pendingDecisions = usePendingDecisionCount(isManager);
  const [channel, setChannel] = useState('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingItems, setEditingItems] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [newOrder, setNewOrder] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ method: 'mobile_money', amount: '', reference: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['orders', { channel, statusFilter, search, page: pager.page, size: pager.pageSize }],
    queryFn: () => ordersApi.list({ ...pager.params, channel: CHANNEL_PARAM[channel], status: statusFilter || undefined, search: search || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,            // new online orders appear without a reload
  });
  const orders = data?.data || [];

  const { data: order } = useQuery({
    queryKey: ['orders', selectedId],
    queryFn: () => ordersApi.get(selectedId).then((r) => r.data.data),
    enabled: !!selectedId,
  });

  // Customers who have more than one order waiting for dispatch (several forms, several orders): flagged so they can be merged.
  const { data: mergeGroups = [] } = useQuery({
    queryKey: ['orders', 'merge-groups', 'all'],
    queryFn: () => ordersApi.mergeGroups().then((r) => r.data.data),
    refetchInterval: 30_000,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    queryClient.invalidateQueries({ queryKey: ['products'] }); // dispatch/return move stock
  }

  // Every action goes through this so the busy/error handling is identical
  // across all of them — these are all "one call, then refresh" operations.
  // confirmOpts can be a plain string (default button styling) or
  // { message, danger } when the action being confirmed is destructive.
  async function act(fn, confirmOpts) {
    if (confirmOpts) {
      const opts = typeof confirmOpts === 'string' ? { message: confirmOpts } : confirmOpts;
      if (!(await dialog.confirm(opts))) return;
    }
    setBusy(true);
    setError('');
    try {
      await fn();
      invalidate();
    } catch (err) {
      setError(getErrorMessage(err, 'That action failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordPayment() {
    const amount = Math.round(parseFloat(paymentForm.amount) * 100);
    if (!amount || amount <= 0) { setError('Enter a payment amount.'); return; }
    await act(async () => {
      await ordersApi.recordPayment(order.id, {
        method: paymentForm.method,
        amount,
        reference: paymentForm.reference || undefined,
      });
      setPaymentForm({ method: 'mobile_money', amount: '', reference: '' });
    });
  }

  async function handleReturn() {
    const picked = await dialog.prompt({
      title: 'Why is this parcel coming back?',
      options: RETURN_REASONS,
    });
    if (picked === null) return;
    const reason = RETURN_REASONS.find((r) => r.value === picked);
    await act(() => ordersApi.returnedInTransit(order.id, reason ? { reason_code: reason.value } : {}));
  }

  const outstanding = order ? order.total - order.amount_paid : 0;

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow={`${CHANNELS.find((c) => c.key === channel).label}${statusFilter ? ` · ${STATUS_LABELS[statusFilter]}` : ''}`}
        title="Orders"
        description="Online and COD orders — confirmation, courier dispatch, payment, and returns."
        meta={data?.total > 0 ? `${data.total} order${data.total === 1 ? '' : 's'}\n${money(data.summary?.outstanding || 0)} outstanding` : null}
        actions={(
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => setNewOrder(true)} className="px-3.5 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">+ New order</button>
            <PullOnlineOrders onPulled={invalidate} />
          </div>
        )}
        tabs={isManager ? {
          items: [
            { key: 'orders', label: 'All orders' },
            { key: 'decisions', label: pendingDecisions > 0 ? `Needs decision (${pendingDecisions})` : 'Needs decision' },
            { key: 'integrity', label: 'Integrity' },
          ],
          active: view,
          onChange: (k) => { setView(k); setError(''); },
        } : undefined}
      />

      {view === 'orders' && <TabBar tabs={CHANNELS} active={channel} onChange={(k) => { setChannel(k); pager.reset(); setSelectedId(null); }} variant="filter" className="mb-4" />}

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      {view === 'orders' && mergeGroups.length > 0 && (
        <div role="status" className="mb-4 px-3.5 py-2.5 rounded-lg border border-accent/40 bg-accent/10 text-sm">
          <span className="font-medium">{mergeGroups.length === 1 ? '1 customer has' : `${mergeGroups.length} customers have`} more than one order waiting for dispatch.</span>{' '}
          {mergeGroups.slice(0, 5).map((g) => (
            <button key={g.customer_id} type="button" onClick={() => setSelectedId(g.suggested_keep_order_id)} className="mr-2 underline text-xs">
              {g.customer_name} ({g.orders.length})
            </button>
          ))}
        </div>
      )}

      {view === 'orders' && <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); pager.reset(); }}
          placeholder="Search customer name or phone…"
          className="flex-1 px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); pager.reset(); }}
          className="px-3.5 py-2.5 rounded-lg border border-line bg-surface focus:border-accent outline-none"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>}

      <div className="grid xl:grid-cols-[1fr_400px] gap-5 items-start">
        {/* Order list + pager (one grid cell, so the pager never becomes a column of its own) */}
        <div className="min-w-0">
        {isManager && view === 'decisions' && <OwnerDecisionQueue canDecide={isAdmin} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setError(''); }} />}
        {isManager && view === 'integrity' && <IntegrityPanel selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setError(''); }} />}
        {view === 'orders' && (<>
        <OrderList
          orders={orders} isLoading={isLoading} channel={channel} statusFilter={statusFilter} search={search}
          selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setError(''); }} modules={modules}
        />

        <Pager pager={pager} data={data} noun="orders" />
        </>)}
        </div>

        {/* Detail / action panel. Below xl it is a slide-up sheet (opens when an order is picked);
            from xl up it is the sticky side panel. */}
        {selectedId && (
          <button
            type="button"
            aria-label="Close order details"
            onClick={() => setSelectedId(null)}
            className="xl:hidden fixed inset-0 z-40 bg-black/40"
          />
        )}
        <div
          className={`bg-surface border border-line p-5 xl:sticky xl:top-6 xl:inset-x-auto xl:bottom-auto xl:max-h-none xl:overflow-visible xl:rounded-xl xl:shadow-none xl:block ${
            selectedId
              ? 'fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-2xl shadow-2xl pb-[calc(1.25rem+env(safe-area-inset-bottom))]'
              : 'hidden rounded-xl'
          }`}
        >
          {selectedId && (
            <div className="xl:hidden flex justify-end -mt-2 -mr-2 mb-1">
              <button type="button" onClick={() => setSelectedId(null)} className="px-3 py-2 text-sm text-text-muted hover:text-text">Close ✕</button>
            </div>
          )}
          {!order && (
            <div className="text-text-muted text-sm text-center py-12">
              Select an order to see its details and available actions.
            </div>
          )}

          {order && (
            <OrderDetail
              order={order} outstanding={outstanding} busy={busy} act={act} modules={modules}
              isManager={isManager} isAdmin={isAdmin}
              paymentForm={paymentForm} setPaymentForm={setPaymentForm}
              handleRecordPayment={handleRecordPayment} handleReturn={handleReturn}
              setEditingItems={setEditingItems} setDispatching={setDispatching} setSelectedId={setSelectedId}
            />
          )}
        </div>
      </div>

      {editingItems && order && order.status === 'awaiting_dispatch' && (
        <EditItemsSheet order={order} onClose={() => setEditingItems(false)} onSaved={invalidate} />
      )}

      {dispatching && order && order.status === 'awaiting_dispatch' && (
        <DispatchSheet order={order} onClose={() => setDispatching(false)} onDispatched={invalidate} />
      )}

      {newOrder && (
        <NewOrderSheet
          onClose={() => setNewOrder(false)}
          onCreated={(created) => { invalidate(); setView('orders'); if (created?.id) setSelectedId(created.id); }}
        />
      )}
    </div>
  );
}
