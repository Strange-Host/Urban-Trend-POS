import { describe, it, expect } from 'vitest';
import {
  ALL_ITEMS, WORKSPACES, ROUTE_ORDER, FLAT_BELOW, filterVisible, byRouteOrder, homeRouteFor,
} from './navItems';
import { canFor, hasRoleFor } from './shell/testRoles';

// What a typical person of each role sees, with both optional modules on.
function visibleFor(role, { modules = { control: true }, can = canFor(role) } = {}) {
  return filterVisible(ALL_ITEMS, { hasRole: hasRoleFor(role), can, modules });
}
const labels = (items) => items.map((i) => i.label);

describe('filterVisible: who sees what (unchanged by the redesign)', () => {
  it('admin sees all 16 destinations', () => {
    expect(visibleFor('admin')).toHaveLength(16);
  });

  it('manager sees all but the three admin-only pages', () => {
    const seen = labels(visibleFor('manager'));
    expect(seen).toHaveLength(13);
    for (const adminOnly of ['Staff', 'Activity log', 'Settings']) expect(seen).not.toContain(adminOnly);
  });

  it('cashier sees their Start screen and the same seven pages as before, storekeeper two', () => {
    expect(labels(visibleFor('cashier'))).toEqual(['Start', 'Terminal', 'Orders', 'Leads', 'Sales history', 'Approvals']);
    expect(labels(visibleFor('store'))).toEqual(['Catalog', 'Stock control']);
  });

  it('lets a permission override the role list', () => {
    const can = (p) => p === 'reports.view';
    expect(labels(visibleFor('manager', { can }))).toEqual(expect.arrayContaining(['Dashboard', 'Reports']));
    expect(labels(visibleFor('manager', { can }))).not.toContain('Staff');
  });
});

describe('workspaces', () => {
  const ids = new Set([...WORKSPACES.map((w) => w.id), 'settings']);

  it('puts every page in exactly one known workspace', () => {
    for (const item of ALL_ITEMS) expect(ids.has(item.workspace), item.to).toBe(true);
  });

  it('matches the plan: where the pages live', () => {
    const inWorkspace = (id) => labels(byRouteOrder(ALL_ITEMS.filter((i) => i.workspace === id)));
    expect(inWorkspace('today')).toEqual(['Dashboard']);
    // Start is the cashier's landing page; only a cashier sees it, so no workspace rail ever lists it.
    expect(inWorkspace('sell')).toEqual(['Start', 'Terminal', 'Orders', 'Leads', 'Sales history', 'Approvals']);
    expect(inWorkspace('stock')).toEqual(['Catalog', 'Stock control', 'Shopify sync']);
    expect(inWorkspace('money')).toEqual(['Finance', 'Reconciliation', 'Money at risk', 'Reports']);
    expect(inWorkspace('team')).toEqual(['Staff', 'Activity log']);
    expect(inWorkspace('settings')).toEqual(['Settings']);
  });

  it('orders pages by a list that covers every page exactly once', () => {
    expect([...ROUTE_ORDER].sort()).toEqual(ALL_ITEMS.map((i) => i.to).sort());
  });

  it('switches to the flat rail below eight destinations', () => {
    expect(FLAT_BELOW).toBe(8);
  });
});

describe('homeRouteFor', () => {
  const all = () => true;
  const none = () => false;
  it('sends the storekeeper to the catalog', () => expect(homeRouteFor('store', all)).toBe('/catalog'));
  it('sends admins and managers who can see reports to the dashboard', () => {
    expect(homeRouteFor('admin', all)).toBe('/dashboard');
    expect(homeRouteFor('manager', all)).toBe('/dashboard');
  });
  it('sends admins and managers without the reports permission to the till', () => {
    expect(homeRouteFor('manager', none)).toBe('/terminal');
    expect(homeRouteFor('admin', none)).toBe('/terminal');
  });
  it('sends cashiers to the till (Home and the layout decide whether they see Start first)', () => {
    expect(homeRouteFor('cashier', all)).toBe('/terminal');
    expect(homeRouteFor('cashier', none)).toBe('/terminal');
  });
});
