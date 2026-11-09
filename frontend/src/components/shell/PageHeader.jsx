import { useLayoutEffect } from 'react';
import Tabs from './Tabs';
import { useInPageSection, useShellChrome } from './pageChromeContext';

// The one page header: title, optional description / meta / actions, optional in-page tabs.
//
//   eyebrow      small label above the title
//   title        the page title
//   description  one muted line (or a few) under the title
//   meta         right-aligned mono text beside the actions
//   actions      buttons and pickers on the right
//   tabs         { items, active, onChange, className? } in-page tabs, drawn by <Tabs>
//   padding      classes for pages that sit outside any padded container (Finance, Catalog and Payroll front embedded pages)
//
// Title and actions, then the status line, the workspace tabs, then in-page tabs, then content. Inside a <PageSection> it is
// a section header: description and actions only, since the parent's tab names the page.
export default function PageHeader({ eyebrow, title, description, meta, actions, tabs, padding = '' }) {
  const shell = useShellChrome();
  const nested = useInPageSection();
  const withChrome = Boolean(shell) && !nested;
  const claim = shell?.claim;

  // Tell the shell this page draws the status line and workspace tabs itself, before the first paint so nothing jumps.
  useLayoutEffect(() => (withChrome ? claim() : undefined), [withChrome, claim]);

  const tabStrip = tabs && (
    <Tabs items={tabs.items} active={tabs.active} onChange={tabs.onChange} className={tabs.className || ''} />
  );
  const right = (meta || actions) && (
    <div className="flex items-center gap-3 shrink-0">
      {meta && <div className="font-mono text-xs text-text-muted text-right whitespace-pre-line">{meta}</div>}
      {actions}
    </div>
  );

  if (nested) {
    // A section inside another page: the parent's tab is the title.
    return (
      <div className={`${padding} mb-5`}>
        <h2 className="sr-only">{title}</h2>
        {(description || right || eyebrow) && (
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div className="min-w-0">
              {eyebrow && <div className="font-mono text-[11px] uppercase tracking-wider text-text-muted mb-1">{eyebrow}</div>}
              {description && <p className="text-text-muted text-sm max-w-2xl">{description}</p>}
            </div>
            {right}
          </div>
        )}
        {tabStrip && <div className="mt-3">{tabStrip}</div>}
      </div>
    );
  }

  return (
    <header className={`${padding} mb-6`}>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <div className="font-mono text-[11px] uppercase tracking-wider text-text-muted mb-1">{eyebrow}</div>}
          <h1 className="font-display font-700 text-2xl tracking-tight">{title}</h1>
        </div>
        {right}
      </div>
      {withChrome && shell.status && <div className="mt-1">{shell.status}</div>}
      {description && <p className="text-text-muted text-sm mt-2 max-w-2xl">{description}</p>}
      {withChrome && shell.workspaceTabs && <div className="mt-3">{shell.workspaceTabs}</div>}
      {tabStrip && <div className="mt-3">{tabStrip}</div>}
    </header>
  );
}
