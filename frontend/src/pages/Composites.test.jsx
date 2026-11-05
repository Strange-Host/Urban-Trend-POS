import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Finance from './Finance';
import Catalog from './Catalog';
import Payroll from './Payroll';
import { setUiVersion } from '../utils/uiVersion';

// Finance, Catalog and Payroll are "mini pages": a tab strip in front of full pages that each have their own header.
// The embedded pages are stand-ins that draw a PageHeader like the real ones do.
const auth = { role: 'admin', perms: new Set(['custody.manage', 'products.manage']) };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { role: auth.role }, can: (p) => auth.perms.has(p) }),
}));
// vi.mock is hoisted above everything, so the helper that builds the stand-ins has to be hoisted too and load PageHeader lazily.
const { stub } = vi.hoisted(() => ({
  stub: (title) => async () => {
    const { default: Header } = await import('../components/shell/PageHeader');
    const { createElement } = await import('react');
    return { default: () => createElement(Header, { title, description: `${title} page` }) };
  },
}));
vi.mock('./Payments', stub('Payments'));
vi.mock('./Expenses', stub('Expenses'));
vi.mock('./CashSessions', stub('Cash sessions'));
vi.mock('./Couriers', stub('Couriers'));
vi.mock('./Custody', stub('Custody'));
vi.mock('./DeliveryAreas', stub('Delivery rates'));
vi.mock('./Products', async () => {
  const { default: Header } = await import('../components/shell/PageHeader');
  const { createElement } = await import('react');
  return { default: ({ catalogue }) => createElement(Header, { title: catalogue === 'online' ? 'Online products' : 'Products' }) };
});
vi.mock('./Categories', stub('Categories'));
vi.mock('./PayrollRuns', stub('Pay runs'));
vi.mock('./PayrollSummary', stub('Payroll live'));
vi.mock('./PayTerms', stub('Pay terms'));

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);
const h1s = () => screen.queryAllByRole('heading', { level: 1 }).map((h) => h.textContent);

beforeEach(() => {
  localStorage.clear(); setUiVersion('v1');
  auth.role = 'admin'; auth.perms = new Set(['custody.manage', 'products.manage']);
});

describe('Finance', () => {
  it('old layout: the tab strip, then the embedded page with its own title (as before)', async () => {
    render(<Finance />);
    expect(tabNames()).toEqual(['Payments', 'Expenses', 'Cash sessions', 'Couriers', 'Custody', 'Delivery rates']);
    expect(h1s()).toEqual(['Payments']);
    await userEvent.click(screen.getByRole('tab', { name: 'Expenses' }));
    expect(h1s()).toEqual(['Expenses']);
  });

  it('hides Custody from people without that permission', () => {
    auth.perms = new Set();
    render(<Finance />);
    expect(tabNames()).not.toContain('Custody');
  });

  it('new layout: one page title (Finance), the embedded page only as a section', async () => {
    setUiVersion('v2');
    render(<Finance />);
    expect(h1s()).toEqual(['Finance']);
    expect(screen.getByText('Payments page')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Couriers' }));
    expect(h1s()).toEqual(['Finance']);
    expect(screen.getByText('Couriers page')).toBeTruthy();
  });
});

describe('Catalog', () => {
  it('managers get the three tabs; tabs switch the embedded page', async () => {
    render(<Catalog />);
    expect(tabNames()).toEqual(['Products', 'Online products', 'Categories']);
    await userEvent.click(screen.getByRole('tab', { name: 'Categories' }));
    expect(h1s()).toEqual(['Categories']);
  });

  it('a storekeeper gets Products alone, with no tabs, in both layouts', () => {
    auth.perms = new Set();
    const { unmount } = render(<Catalog />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(h1s()).toEqual(['Products']);
    unmount();
    setUiVersion('v2');
    render(<Catalog />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(h1s()).toEqual(['Products']); // nothing wraps it, so it keeps its own title
  });

  it('new layout, manager: Catalog is the title and Products is a section', () => {
    setUiVersion('v2');
    render(<Catalog />);
    expect(h1s()).toEqual(['Catalog']);
  });
});

describe('Payroll', () => {
  it('only admins get the Pay terms tab', () => {
    const { unmount } = render(<Payroll />);
    expect(tabNames()).toEqual(['Pay runs', 'Live summary', 'Pay terms']);
    unmount();
    auth.role = 'manager';
    render(<Payroll />);
    expect(tabNames()).toEqual(['Pay runs', 'Live summary']);
  });

  it('new layout: Payroll is the title and the embedded page a section', () => {
    setUiVersion('v2');
    render(<Payroll />);
    expect(h1s()).toEqual(['Payroll']);
    expect(screen.getByText('Pay runs page')).toBeTruthy();
  });
});
