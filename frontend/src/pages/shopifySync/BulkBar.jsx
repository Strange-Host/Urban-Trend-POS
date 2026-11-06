import Picker from '../../components/Picker';

/** The sticky bar that appears while rows are ticked: set a category for them, or approve them. */
export default function BulkBar({ selectedCount, categoryOptions, busy, onSetCategory, onApprove, onCreateCategory }) {
  return (
  <div className="sticky bottom-0 z-10 -mx-4 md:-mx-8 mt-4 px-4 md:px-8 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-surface border-t border-line shadow-[0_-6px_20px_rgb(0_0_0/0.08)]">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium mr-auto">{selectedCount} ticked</span>
      <div className="w-full sm:w-56">
        <Picker
          value="" onChange={onSetCategory} title="Set category for ticked products" aria-label="Set category for ticked products"
          placeholder="Set category…" options={categoryOptions} disabled={busy}
          onCreate={onCreateCategory}
          createLabel="New category"
        />
      </div>
      <button
        type="button" onClick={onApprove} disabled={busy}
        className="flex-1 sm:flex-none min-h-[44px] px-5 rounded-lg bg-success text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Working…' : `Approve ${selectedCount}`}
      </button>
    </div>
  </div>
  );
}
