// The till's category list: a 190px column beside the product grid on large screens, a row of chips above it on small
// ones. `top` is whatever should sit above the list (the shift widget). Selecting a category asks the server for just
// those products; "All items" clears it.
export default function CategoryColumn({ categories, activeId, onSelect, top }) {
  const chip = (on) => `shrink-0 min-h-11 rounded-lg px-3 text-left text-sm transition-colors xl:w-full ${
    on ? 'bg-ink font-medium text-white' : 'text-text hover:bg-paper'
  }`;
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-line bg-surface p-3 xl:w-[190px] xl:overflow-y-auto xl:border-b-0 xl:border-r">
      {top}
      <nav aria-label="Categories" className="flex gap-1 overflow-x-auto xl:flex-col xl:overflow-visible">
        <button type="button" aria-pressed={activeId === null} onClick={() => onSelect(null)} className={chip(activeId === null)}>All items</button>
        {categories.map((c) => (
          <button key={c.id} type="button" aria-pressed={activeId === c.id} onClick={() => onSelect(c.id)} className={chip(activeId === c.id)}>
            {c.name}
          </button>
        ))}
      </nav>
    </div>
  );
}
