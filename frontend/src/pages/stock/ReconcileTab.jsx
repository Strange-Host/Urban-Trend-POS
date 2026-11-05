import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '../../api/client';
import { inventoryApi } from '../../api/endpoints';
import MovementsSheet from '../../components/MovementsSheet';
import { useAuth } from '../../context/AuthContext';
import { useToast, useDialog } from '../../context/UIContext';
import { ProductSearch, Table } from './shared';
import { btnGhost, btnPrimary, cardCls } from './helpers';

// ---------------------------------------------------------------------------------------------------------------------
// Reconcile: the stored quantity of every product checked against its movement ledger, and the movement trail of any
// product. This is not a stock count - it never looks at what is physically on the shelf (that is the Counts tab). It
// catches a stored quantity that changed without a ledger entry. The check always covers every branch, whichever one
// is picked above; resetting is admin-only because it overwrites the stored figure with the ledger total.
// ---------------------------------------------------------------------------------------------------------------------
export function ReconcileTab({ storeParams, stores }) {
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const { can, hasRole } = useAuth();
  const [open, setOpen] = useState(null);   // { product, storeParams } whose movements are showing

  const currentId = stores.find((s) => s.is_current)?.id;
  const branchName = (id) => stores.find((s) => s.id === id)?.name || `Branch ${id}`;
  const isOwn = (id) => id === currentId;

  const { data: drift = [], isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['inventory', 'reconcile'],
    queryFn: () => inventoryApi.reconcileCheck().then((r) => r.data.data),
  });

  const fix = useMutation({
    mutationFn: () => inventoryApi.reconcile().then((r) => r.data.data),
    onSuccess: (fixed) => {
      toast.success(`${fixed.length} row${fixed.length === 1 ? '' : 's'} reset to the ledger.`);
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
    },
    onError: (err) => toast.error(getErrorMessage(err, 'Could not reset the stored quantities.')),
  });

  async function reset() {
    const ok = await dialog.confirm({
      title: 'Reset stored quantities to the ledger?',
      message: `${drift.length} row${drift.length === 1 ? '' : 's'} across all branches will have the stored quantity set to the movement ledger total. No movement is written. Only do this if you trust the ledger over the stored figures.`,
      confirmLabel: `Reset ${drift.length} row${drift.length === 1 ? '' : 's'}`,
      danger: true,
    });
    if (ok) fix.mutate();
  }

  return (
    <>
      <p className="text-sm text-text-muted mb-4 max-w-2xl">
        Checks that the stock figure shown for each product still matches the sum of its recorded movements. It does not look at what is on the shelf;
        use Counts for that. This check covers every branch.
      </p>

      <div className={`${cardCls} p-4 mb-6`}>
        <h2 className="font-display font-700 text-sm mb-1">See why a quantity is what it is</h2>
        <p className="text-xs text-text-muted mb-3">Pick a product to see every stock change recorded for it at the branch shown above.</p>
        <ProductSearch value={null} onChange={(product) => product && setOpen({ product, storeParams })} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-display font-700 text-sm">
          {isLoading ? 'Checking…' : error ? 'Check failed' : drift.length === 0 ? 'Everything matches' : `${drift.length} row${drift.length === 1 ? '' : 's'} do not match`}
        </h2>
        <div className="flex gap-2">
          <button type="button" onClick={() => refetch()} disabled={isFetching} className={btnGhost}>{isFetching ? 'Checking…' : 'Check again'}</button>
          {hasRole('admin') && drift.length > 0 && (
            <button type="button" onClick={reset} disabled={fix.isPending} className={btnPrimary}>{fix.isPending ? 'Resetting…' : `Reset ${drift.length} to the ledger`}</button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{getErrorMessage(error, 'Could not run the check.')}</div>}

      {!error && (
        <Table head={['Product', 'Branch', 'Stored', 'Ledger', 'Difference', '']} loading={isLoading}
          empty={drift.length === 0 && 'No differences. The stored quantity of every product agrees with its movements.'}>
          {drift.map((r) => (
            <tr key={`${r.product_id}-${r.store_id}`} className="border-b border-line last:border-0">
              <td className="px-4 py-3">{r.product_name}<div className="text-xs text-text-muted font-mono">{r.sku}</div></td>
              <td className="px-4 py-3 whitespace-nowrap">{branchName(r.store_id)}</td>
              <td className="px-4 py-3 font-mono">{r.cached_quantity}</td>
              <td className="px-4 py-3 font-mono">
                {r.ledger_quantity}
                {r.ledger_quantity < 0 && <div className="text-xs text-text-muted font-sans">Below zero: a reset sets stock to 0 and this row stays listed.</div>}
              </td>
              <td className={`px-4 py-3 font-mono ${r.drift < 0 ? 'text-danger' : ''}`}>{r.drift > 0 ? `+${r.drift}` : r.drift}</td>
              <td className="px-4 py-3 text-right">
                {(isOwn(r.store_id) || can('stock.review')) && (
                  <button type="button" onClick={() => setOpen({ product: { id: r.product_id, name: r.product_name, sku: r.sku }, storeParams: isOwn(r.store_id) ? {} : { store_id: r.store_id } })}
                    className={btnGhost} aria-label={`Movements for ${r.product_name}`}>Movements</button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {!hasRole('admin') && drift.length > 0 && <p className="mt-2 text-xs text-text-muted">Only an admin can reset these figures.</p>}

      {open && <MovementsSheet product={open.product} storeParams={open.storeParams} onClose={() => setOpen(null)} />}
    </>
  );
}
