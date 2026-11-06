import Sheet from '../../components/Sheet';

/** Move a product between the shop and the online listings (with an opening count when it goes to the shop). */
export default function MoveProductSheet({ moving, openingStock, setOpeningStock, moveError, onClose, onSubmit }) {
  return (
      <Sheet onClose={() => onClose()} size="sm" as="form" onSubmit={onSubmit}>
        <h2 className="font-display font-700 text-lg mb-1">{moving.to === 'shop' ? 'Add to shop' : 'Move to online products'}</h2>
        <p className="text-text-muted text-sm mb-4">{moving.product.name}</p>

        {moveError && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{moveError}</div>}

        {moving.to === 'shop' ? (
          <>
            <p className="text-sm mb-4">It will appear at the till. Enter only what you hold on the shelf today; online stock is not counted.</p>
            <label htmlFor="opening-stock" className="block text-xs font-medium text-text-muted mb-1">How many are on the shelf now?</label>
            <input
              id="opening-stock" type="text" inputMode="numeric" pattern="[0-9]*" enterKeyHint="done" autoComplete="off" maxLength={6}
              value={openingStock} onChange={(e) => setOpeningStock(e.target.value.replace(/\D/g, ''))}
              className="w-full px-3 py-3 rounded-lg border border-line outline-none focus:border-accent text-xl font-mono mb-5"
              placeholder="0"
            />
          </>
        ) : moving.product.total_stock > 0 ? (
          <p className="text-sm mb-5">
            The shop's records show <b>{moving.product.total_stock}</b> {moving.product.total_stock === 1 ? 'unit' : 'units'} of this product.
            Moving it writes them off in the stock history and takes it off the till. Count the shelf first if you are not sure they are gone.
          </p>
        ) : (
          <p className="text-sm mb-5">It will leave the till and the shop's stock lists. Its sales history stays.</p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={() => onClose()} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
          <button type="submit" className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">
            {moving.to === 'shop' ? 'Add to shop' : moving.product.total_stock > 0 ? `Write off ${moving.product.total_stock} and move` : 'Move to online'}
          </button>
        </div>
      </Sheet>
  );
}
