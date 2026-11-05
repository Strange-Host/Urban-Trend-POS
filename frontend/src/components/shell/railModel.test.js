import { describe, it, expect } from 'vitest';
import { ALL_ITEMS, filterVisible, homeRouteFor } from '../navItems';
import { buildRail, activeEntryId, coversPath } from './railModel';
import { ROLES, canFor, hasRoleFor } from './testRoles';

function railFor(role, can = canFor(role)) {
  const visible = filterVisible(ALL_ITEMS, { hasRole: hasRoleFor(role), can, modules: { hr: true, control: true } });
  return { visible, rail: buildRail(visible) };
}
const labels = (list) => list.map((e) => e.label);

describe('buildRail', () => {
  it('gives admins and managers the workspace rail', () => {
    for (const role of ['admin', 'manager']) {
      const { rail } = railFor(role);
      expect(rail.flat).toBe(false);
      expect(labels(rail.entries)).toEqual(['Today', 'Sell', 'Stock', 'Money', 'Team']);
    }
  });

  it('shows Settings in the bottom stack for admins only', () => {
    expect(railFor('admin').rail.settings?.to).toBe('/settings');
    expect(railFor('manager').rail.settings).toBeNull();
    expect(railFor('cashier').rail.settings).toBeNull();
  });

  it('gives the cashier a flat rail of their seven pages, in workspace order', () => {
    const { rail } = railFor('cashier');
    expect(rail.flat).toBe(true);
    expect(labels(rail.entries)).toEqual(['Terminal', 'Orders', 'Leads', 'Sales history', 'Approvals', 'Requisitions', 'Attendance']);
  });

  it('gives the storekeeper a flat rail of two', () => {
    expect(labels(railFor('store').rail.entries)).toEqual(['Catalog', 'Stock control']);
  });

  it('sends each workspace item to its first visible page', () => {
    const to = Object.fromEntries(railFor('admin').rail.entries.map((e) => [e.id, e.to]));
    expect(to).toEqual({ today: '/dashboard', sell: '/terminal', stock: '/catalog', money: '/finance', team: '/attendance' });
  });

  it('falls back to a later page when the first is not visible', () => {
    // A manager who may not see the till still lands in Sell, on Orders.
    const visible = filterVisible(ALL_ITEMS.filter((i) => i.to !== '/terminal'), { hasRole: hasRoleFor('manager'), can: canFor('manager'), modules: { hr: true } });
    expect(buildRail(visible).entries.find((e) => e.id === 'sell').to).toBe('/orders');
  });

  it('leaves out a workspace with nothing visible in it', () => {
    const { rail } = railFor('manager', (p) => p !== 'reports.view');
    expect(labels(rail.entries)).not.toContain('Today');
  });

  it('is flat for any role that ends up with fewer than eight destinations', () => {
    const visible = ALL_ITEMS.filter((i) => ['/terminal', '/orders', '/finance'].includes(i.to));
    expect(buildRail(visible).flat).toBe(true);
  });
});

describe('every page stays reachable (Phase 1: from the rail, plus its workspace tabs)', () => {
  it.each(ROLES)('%s can reach every page they can see today', (role) => {
    const { visible, rail } = railFor(role);
    const reachable = new Set(rail.entries.flatMap((e) => e.pages.map((p) => p.to)));
    if (rail.settings) reachable.add(rail.settings.to);
    expect([...reachable].sort()).toEqual(visible.map((i) => i.to).sort());
  });
});

describe('activeEntryId', () => {
  const admin = railFor('admin').rail;
  const cashier = railFor('cashier').rail;

  it('finds the workspace a page belongs to', () => {
    expect(activeEntryId(admin, '/orders', '/dashboard')).toBe('sell');
    expect(activeEntryId(admin, '/reports', '/dashboard')).toBe('money');
    expect(activeEntryId(admin, '/staff-logs', '/dashboard')).toBe('team');
  });

  it('counts sub-pages, but not look-alike paths', () => {
    expect(activeEntryId(admin, '/attendance/end-of-day', '/dashboard')).toBe('team');
    expect(activeEntryId(admin, '/stock-whatever', '/dashboard')).toBeNull();
  });

  it('treats / as wherever that role lands', () => {
    expect(activeEntryId(admin, '/', '/dashboard')).toBe('today');
    expect(activeEntryId(cashier, '/', '/terminal')).toBe('/terminal');
  });

  it('marks Settings, and nothing for pages outside the navigation', () => {
    expect(activeEntryId(admin, '/settings', '/dashboard')).toBe('settings');
    expect(activeEntryId(admin, '/security', '/dashboard')).toBeNull();
  });

  it('agrees with the home route of every role', () => {
    for (const role of ROLES) {
      const { rail } = railFor(role);
      const home = homeRouteFor(role, canFor(role));
      expect(activeEntryId(rail, '/', home), role).not.toBeNull();
    }
  });
});

describe('coversPath', () => {
  it('matches the page itself and its sub-pages only', () => {
    expect(coversPath('/attendance', '/attendance')).toBe(true);
    expect(coversPath('/attendance/end-of-day', '/attendance')).toBe(true);
    expect(coversPath('/staff-logs', '/staff')).toBe(false);
  });
});
