// What the rail shows for one person, worked out from the pages they may open. Plain functions, no React, so the
// rules (flat or workspace rail, where each item goes, which one is active) can be tested per role.
import { FLAT_BELOW, WORKSPACES, byRouteOrder } from '../navItems';

/**
 * visibleItems: nav items this person may open (navItems' filterVisible output).
 *
 * Returns { flat, entries, settings }:
 *   flat      true when the person has fewer than FLAT_BELOW destinations (cashier, storekeeper)
 *   entries   rail items in order. Flat rail: one per page. Workspace rail: one per workspace that has a visible page.
 *             Each is { id, label, icon, to, pages }: `to` is where the item goes, `pages` every page it covers.
 *   settings  the Settings page when they may open it (it lives in the rail's bottom stack), otherwise null
 */
export function buildRail(visibleItems) {
  const settings = visibleItems.find((i) => i.workspace === 'settings') || null;
  const nav = byRouteOrder(visibleItems.filter((i) => i.workspace !== 'settings'));
  const flat = nav.length < FLAT_BELOW;

  const entries = flat
    ? nav.map((page) => ({ id: page.to, label: page.label, icon: page.icon, to: page.to, pages: [page] }))
    : WORKSPACES
      .map((w) => {
        const pages = nav.filter((i) => i.workspace === w.id);
        return pages.length ? { id: w.id, label: w.label, icon: w.icon, to: pages[0].to, pages } : null;
      })
      .filter(Boolean);

  return { flat, entries, settings };
}

const covers = (path, to) => path === to || path.startsWith(`${to}/`);

/**
 * Which rail item the current page belongs to: an entry id, 'settings', or null for pages outside the navigation
 * (Security, Change password). "/" is each role's landing page, so it counts as wherever that lands.
 */
export function activeEntryId({ entries, settings }, pathname, homeRoute) {
  const path = pathname === '/' ? homeRoute : pathname;
  if (settings && covers(path, settings.to)) return 'settings';
  return entries.find((e) => e.pages.some((p) => covers(path, p.to)))?.id ?? null;
}

/** Whether `path` is the page `to` or one of its sub-pages (/attendance/end-of-day belongs to /attendance). */
export function coversPath(path, to) {
  return covers(path, to);
}
