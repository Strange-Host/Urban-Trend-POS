import { useEffect, useId, useLayoutEffect, useRef } from 'react';

// The one pop-up used everywhere (forms, details, confirmations).
//   - Phones: slides up from the bottom as a "bottom sheet" that is as tall as it needs to be but never taller than
//     the screen, grows/shrinks with the on-screen keyboard (see the viewport tag in index.html), keeps its Save/Cancel
//     row stuck to the bottom so it is always in reach of a thumb, and closes with the phone's back gesture.
//   - Larger screens: the same centred card as before.
//
//   <Sheet onClose={close} size="md" as="form" onSubmit={save} label="Edit product"> ...content... </Sheet>
//
// size: 'sm' | 'md' | 'lg' (card width on large screens). bare: skip the default padding (for sheets that lay out
// their own header/body/footer). `as="form"` makes the sheet itself the <form>.

// Back-gesture support: while a sheet is open it owns one browser-history entry, so Android's back gesture / the
// browser back button closes the sheet instead of leaving the page. Several sheets can stack.
const openSheets = [];

function useBackToClose(onCloseRef) {
  const id = useId();
  useEffect(() => {
    openSheets.push(id);
    if (window.history.state?.__sheet !== id) {
      // Keep the router's own bookkeeping in the state object so it doesn't mistake this for a navigation.
      window.history.pushState({ ...(window.history.state || {}), __sheet: id }, '');
    }
    let closedByBack = false;
    const onPop = () => {
      if (window.history.state?.__sheet !== id && openSheets.includes(id) && openSheets[openSheets.length - 1] === id) {
        closedByBack = true;
        onCloseRef.current?.();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && openSheets[openSheets.length - 1] === id) onCloseRef.current?.();   // only the top sheet
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      const i = openSheets.lastIndexOf(id);
      if (i >= 0) openSheets.splice(i, 1);
      if (!closedByBack) {
        // closed by a button: remove the history entry we added (deferred so a React dev re-mount doesn't undo itself)
        setTimeout(() => {
          if (!openSheets.includes(id) && window.history.state?.__sheet === id) window.history.back();
        }, 0);
      }
    };
  }, [id, onCloseRef]);
}

export default function Sheet({
  onClose, children, size = 'md', as: Tag = 'div', onSubmit, label, className = '', bare = false, zIndex = 50, dismissOnBackdrop = true,
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ref = useRef(null);
  const downOnBackdrop = useRef(false);
  useBackToClose(onCloseRef);

  // Lock the page behind the sheet so a swipe scrolls the sheet, not the page underneath.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Convention: if the last thing in a sheet is a row of buttons, keep it stuck to the bottom (always reachable,
  // even with the keyboard up). Opt out with data-no-sticky. Done here once, for every pop-up in the app.
  useLayoutEffect(() => {
    const last = ref.current?.lastElementChild;
    if (last && last.tagName === 'DIV' && !last.dataset.noSticky && last.querySelector(':scope > button, :scope > a.btn, :scope > div > button')
      && !last.querySelector('input, select, textarea') && !last.classList.contains('sheet-actions')) {
      last.classList.add('sheet-actions');
    }
  });

  // When a field inside gets focus, make sure it is on screen above the keyboard.
  const onFocus = (e) => {
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      setTimeout(() => { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* old browser */ } }, 250);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      style={{ zIndex }}
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (dismissOnBackdrop && downOnBackdrop.current && e.target === e.currentTarget) onClose?.(); downOnBackdrop.current = false; }}
    >
      <Tag
        ref={ref}
        className={`sheet sheet-${size} ${bare ? '' : 'sheet-padded'} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onSubmit={onSubmit}
        onFocus={onFocus}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" aria-hidden="true" />
        {children}
      </Tag>
    </div>
  );
}
