// A highlight "pill" that slides to whichever child is currently active and
// stretches like a drop while it moves: the edge it is moving towards goes
// first and fast, the trailing edge catches up slower (see .sliding-pill in
// index.css). Plain CSS transitions, no animation library.
//
//   const { rootRef, pillProps } = useSlidingPill('y', location.pathname);
//   <div ref={rootRef} className="relative">
//     <span {...pillProps} className="sliding-pill bg-accent rounded-lg" />
//     ...children; the active one carries aria-current / aria-selected / data-active
//   </div>
//
// Rules for the markup: the root must be `position: relative`, the active
// child is found with the selector below, and every child that should sit
// above the pill needs `position: relative` itself (the pill comes first in
// the DOM, so positioned children paint over it).
//
// `key` is anything that should trigger a re-measure when it changes (the
// route, the selected range, ...). Size changes of the root (a group being
// collapsed, a font arriving) are picked up by a ResizeObserver.
import { useLayoutEffect, useRef, useState } from 'react';

const ACTIVE = '[aria-current="page"], [aria-selected="true"], [data-active="true"]';
const HIDDEN = { start: 0, end: 0, cs: 0, ce: 0, visible: false, dir: 'fwd' };

export default function useSlidingPill(axis = 'y', key) {
  const rootRef = useRef(null);
  const [pill, setPill] = useState(HIDDEN);
  const [animate, setAnimate] = useState(false); // off for the first paint so the pill doesn't fly in from 0

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const vertical = axis === 'y';

    function measure() {
      const el = root.querySelector(ACTIVE);
      if (!el) {
        setPill((p) => (p.visible ? { ...p, visible: false } : p));
        return;
      }
      // Along the axis (start/end) and across it (cs/ce), so the pill matches the
      // active child exactly even when the root has padding around its children.
      const start = vertical ? el.offsetTop : el.offsetLeft;
      const size = vertical ? el.offsetHeight : el.offsetWidth;
      const total = vertical ? root.clientHeight : root.clientWidth;
      const end = Math.max(0, total - start - size);
      const cs = vertical ? el.offsetLeft : el.offsetTop;
      const csize = vertical ? el.offsetWidth : el.offsetHeight;
      const ctotal = vertical ? root.clientWidth : root.clientHeight;
      const ce = Math.max(0, ctotal - cs - csize);
      setPill((p) => {
        if (p.visible && p.start === start && p.end === end && p.cs === cs && p.ce === ce) return p;
        return { start, end, cs, ce, visible: true, dir: p.visible && start < p.start ? 'back' : 'fwd' };
      });
    }

    measure();
    const raf = requestAnimationFrame(() => setAnimate(true));
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(root);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
    };
  }, [axis, key]);

  const vertical = axis === 'y';
  const pillProps = {
    'aria-hidden': true,
    'data-axis': axis,
    'data-dir': pill.dir,
    'data-visible': pill.visible,
    'data-animate': animate,
    style: vertical
      ? { top: pill.start, bottom: pill.end, left: pill.cs, right: pill.ce }
      : { left: pill.start, right: pill.end, top: pill.cs, bottom: pill.ce },
  };
  return { rootRef, pillProps };
}
