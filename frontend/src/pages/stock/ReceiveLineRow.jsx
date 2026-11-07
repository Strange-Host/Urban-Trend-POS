import { Fragment } from 'react';
import Picker from '../../components/Picker';
import { ProductSearch } from './shared';
import { inputCls, kes, labelCls } from './helpers';

// One line of the new Receive form: Item | Quantity | Selling price | Buying price, with batch, expiry and (for a new
// product) image and category tucked under "More". On a phone the cells stack and carry their own label.
export const LINE_GRID = 'md:grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_9.5rem_4.5rem]';
const cellLabel = 'md:hidden block text-xs font-medium text-text-muted mb-1';

export default function ReceiveLineRow({ line: l, index, removable, canCost, canManage, categories, topLevel, catLabel, setLine, onRemove }) {
  const n = index + 1;
  const isNew = l.mode === 'new';
  const hasExtras = Boolean(l.batchNo || l.expiry || l.image || l.categoryId || l.subOn);
  const price = l.product?.sell_price;
  const swap = (mode) => setLine(l.key, { mode });

  return (
    <div className="border-t border-line py-3">
      <div className={`grid grid-cols-1 gap-3 md:items-start ${LINE_GRID}`}>
        <div>
          <span className={cellLabel}>Item</span>
          {isNew ? (
            <input value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value })} aria-label={`Line ${n} new item name`} placeholder="Name of the new item" className={inputCls} />
          ) : (
            <ProductSearch value={l.product} onChange={(product) => setLine(l.key, { product })} ariaLabel={`Line ${n} item`} placeholder="Search for an item" />
          )}
          <button type="button" onClick={() => swap(isNew ? 'existing' : 'new')} className="mt-1 text-xs text-text-muted hover:text-text">
            {isNew ? 'Choose an existing item instead' : 'Not in the catalog? Add it as a new item'}
          </button>
        </div>

        <div>
          <span className={cellLabel}>Quantity</span>
          <input type="number" min="1" inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} aria-label={`Line ${n} quantity`} className={inputCls} />
        </div>

        <div>
          <span className={cellLabel}>Selling price</span>
          {isNew ? (
            <input type="number" min="0" step="0.01" inputMode="decimal" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} aria-label={`Line ${n} selling price (KES)`} className={inputCls} />
          ) : (
            <span className="block py-2 text-sm text-text-muted" title="The price the catalog already has. Change it on the product.">{Number.isFinite(price) ? kes(price) : '–'}</span>
          )}
        </div>

        <div>
          <span className={cellLabel}>Buying price</span>
          {canCost ? (
            <input type="number" min="0" step="0.01" inputMode="decimal" value={l.cost} onChange={(e) => setLine(l.key, { cost: e.target.value })} aria-label={`Line ${n} buying price per unit (KES)`} className={inputCls} />
          ) : (
            <span className="block py-2 text-sm text-text-muted">Set by admin</span>
          )}
        </div>

        <div className="md:text-right">
          {removable && <button type="button" onClick={onRemove} aria-label={`Remove line ${n}`} className="min-h-11 px-2 text-xs text-danger hover:opacity-70">Remove</button>}
        </div>
      </div>

      <details className="mt-2 text-sm" open={hasExtras}>
        <summary className="cursor-pointer select-none text-xs font-medium text-text-muted">{isNew ? 'More: image, category, batch and expiry' : 'More: batch and expiry'}</summary>
        <div className="mt-3 space-y-3">
          {isNew && (
            <Fragment>
              <div>
                <label className={labelCls} htmlFor={`line-${l.key}-image`}>Image link (optional)</label>
                <input id={`line-${l.key}-image`} value={l.image} onChange={(e) => setLine(l.key, { image: e.target.value })} placeholder="https://…" className={inputCls} />
              </div>
              {!l.subOn ? (
                <div>
                  <label className={labelCls}>Category</label>
                  <Picker value={l.categoryId} onChange={(v) => setLine(l.key, { categoryId: v })} title="Category" aria-label={`Line ${n} category`} allowClear clearLabel="No category"
                    options={categories.map((c) => ({ value: c.id, label: catLabel(c) }))} />
                  <button type="button" onClick={() => setLine(l.key, { subOn: true })} className="mt-1 text-xs text-text-muted hover:text-text">+ Add a new sub-category instead</button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>Put it inside{canManage ? ' (blank = new top-level category)' : ''}</label>
                    <Picker value={l.parentId} onChange={(v) => setLine(l.key, { parentId: v })} title="Parent category" aria-label={`Line ${n} parent category`} allowClear={canManage} clearLabel="Top level"
                      options={topLevel.map((c) => ({ value: c.id, label: c.name }))} />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`line-${l.key}-sub`}>New sub-category name</label>
                    <input id={`line-${l.key}-sub`} value={l.subName} onChange={(e) => setLine(l.key, { subName: e.target.value })} className={inputCls} />
                    <button type="button" onClick={() => setLine(l.key, { subOn: false, subName: '', parentId: '' })} className="mt-1 text-xs text-text-muted hover:text-text">Use an existing category instead</button>
                  </div>
                </div>
              )}
            </Fragment>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor={`line-${l.key}-batch`}>Batch / lot no. (optional)</label>
              <input id={`line-${l.key}-batch`} value={l.batchNo} onChange={(e) => setLine(l.key, { batchNo: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor={`line-${l.key}-expiry`}>Expiry date (if it expires)</label>
              <input id={`line-${l.key}-expiry`} type="date" value={l.expiry} onChange={(e) => setLine(l.key, { expiry: e.target.value })} className={inputCls} />
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
