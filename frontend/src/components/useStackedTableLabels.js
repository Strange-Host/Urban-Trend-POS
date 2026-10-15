import { useEffect } from 'react';

// Copies each column heading onto the cells beneath it (data-label) so the
// phone layout in index.css can print "TOTAL  KES 900" on every card line.
// One observer for the whole app means every table (and any added later,
// including ones that only appear after data loads) gets it without each
// page having to repeat the header text.
function labelTables(root) {
  root.querySelectorAll('table.stack-sm').forEach((table) => {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (heads.length === 0) return;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      let col = 0;
      [...tr.children].forEach((td) => {
        // A cell spanning several columns is an empty-state / note row, not a field.
        const label = (td.colSpan || 1) > 1 ? '' : (heads[col] ?? '');
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
        col += td.colSpan || 1;
      });
    });
  });
}

export default function useStackedTableLabels(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => labelTables(root));
    };
    schedule();
    // childList/characterData only: setting the attribute above must not retrigger us.
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [rootRef]);
}
