import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Tabs from './Tabs';
import TabBar from '../TabBar';

const items = [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }];
const classOf = (name) => screen.getByRole('tab', { name }).className;

describe('Tabs (button tabs)', () => {
  it('marks the active tab and reports a change', async () => {
    const onChange = vi.fn();
    render(<Tabs items={items} active="a" onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Beta' }).getAttribute('aria-selected')).toBe('false');
    await userEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('draws the underline style: the active tab has the dark underline, the others a clear one', () => {
    render(<Tabs items={items} active="a" onChange={() => {}} />);
    expect(classOf('Alpha')).toContain('border-b-2');
    expect(classOf('Alpha')).toContain('border-text');
    expect(classOf('Beta')).toContain('border-transparent');
    expect(classOf('Alpha')).not.toContain('bg-ink');
  });
});

describe('Tabs (link tabs)', () => {
  const links = [{ key: '/orders', label: 'Orders', to: '/orders' }, { key: '/leads', label: 'Leads', to: '/leads' }];

  it('renders ordinary links and marks the current page', () => {
    render(<MemoryRouter><Tabs items={links} active="/leads" label="Pages" /></MemoryRouter>);
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Orders' }).getAttribute('href')).toBe('/orders');
    expect(screen.getByRole('link', { name: 'Leads' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Orders' }).getAttribute('aria-current')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('TabBar (filter chips)', () => {
  it('draws small bordered chips, not a tab underline', () => {
    render(<TabBar tabs={items} active="a" onChange={() => {}} />);
    expect(classOf('Alpha')).toContain('text-xs');
    expect(classOf('Alpha')).toContain('bg-ink');
    expect(classOf('Alpha')).not.toContain('border-b-2');
  });

  it('reports a change', async () => {
    const onChange = vi.fn();
    render(<TabBar tabs={items} active="a" onChange={onChange} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Tabs count badge', () => {
  it('shows a count after the label when an item has one, and nothing for zero or none', () => {
    render(<Tabs items={[{ key: 'a', label: 'Alpha', badge: 4 }, { key: 'b', label: 'Beta', badge: 0 }, { key: 'c', label: 'Gamma' }]} active="a" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: /Alpha/ })).toHaveTextContent('Alpha4');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveTextContent(/^Beta$/);
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveTextContent(/^Gamma$/);
  });

  it('works on link tabs too', () => {
    render(<MemoryRouter><Tabs items={[{ key: 'a', label: 'Alpha', to: '/a', badge: 2 }]} active="a" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Alpha/ })).toHaveTextContent('Alpha2');
  });
});
