import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Tabs from './Tabs';
import TabBar from '../TabBar';
import { setUiVersion } from '../../utils/uiVersion';

const items = [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }];
const classOf = (name) => screen.getByRole('tab', { name }).className;

beforeEach(() => { localStorage.clear(); setUiVersion('v1'); });

describe('Tabs (button tabs)', () => {
  it('marks the active tab and reports a change', async () => {
    const onChange = vi.fn();
    render(<Tabs items={items} active="a" onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Beta' }).getAttribute('aria-selected')).toBe('false');
    await userEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('keeps today\'s pill style while the flag is off', () => {
    render(<Tabs items={items} active="a" onChange={() => {}} />);
    expect(classOf('Alpha')).toContain('bg-ink');
    expect(classOf('Alpha')).not.toContain('border-b-2');
  });

  it('switches to the underline style when the flag is on', () => {
    setUiVersion('v2');
    render(<Tabs items={items} active="a" onChange={() => {}} />);
    expect(classOf('Alpha')).toContain('border-b-2');
    expect(classOf('Alpha')).toContain('border-text');
    expect(classOf('Beta')).toContain('border-transparent');
    expect(classOf('Alpha')).not.toContain('bg-ink');
  });

  it('can force the underline in the old layout too (Stock control already was one)', () => {
    render(<Tabs items={items} active="a" onChange={() => {}} appearance="underline" />);
    expect(classOf('Alpha')).toContain('border-b-2');
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

describe('TabBar', () => {
  it('draws a page-variant call with Tabs, so there is one tab style', () => {
    setUiVersion('v2');
    render(<TabBar tabs={items} active="a" onChange={() => {}} />);
    expect(classOf('Alpha')).toContain('border-b-2');
  });

  it('keeps the filter variant as filter chips in both layouts', () => {
    for (const v of ['v1', 'v2']) {
      setUiVersion(v);
      const { unmount } = render(<TabBar tabs={items} active="a" onChange={() => {}} variant="filter" />);
      expect(classOf('Alpha')).toContain('text-xs');
      expect(classOf('Alpha')).toContain('bg-ink');
      expect(classOf('Alpha')).not.toContain('border-b-2');
      unmount();
    }
  });
});
