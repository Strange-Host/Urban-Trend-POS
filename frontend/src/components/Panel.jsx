// The card used for dashboard-style sections: solid white surface, thin
// border, generous radius and padding. (No translucency or blur on purpose -
// cards stay solid so the palette in index.css is the only thing setting colour.)
// `title`, `description` and `action` are all optional; without them the
// children fill the card edge to edge, so a chart can bring its own header.
export default function Panel({ title, description, action, children, className = '' }) {
  const hasHeader = title || description || action;
  return (
    <section className={`bg-surface border border-line rounded-2xl overflow-hidden ${className}`}>
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div className="min-w-0">
            {title && <h2 className="font-display font-600 text-base tracking-tight">{title}</h2>}
            {description && <p className="text-xs text-text-muted mt-0.5">{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
