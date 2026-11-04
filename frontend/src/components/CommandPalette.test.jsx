import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette from './CommandPalette';
import { Package, Wallet } from 'lucide-react';

const items = [
  { to: '/orders', label: 'Orders', icon: Package, group: 'Sell', keywords: 'dispatch courier' },
  { to: '/finance', label: 'Finance', icon: Wallet, group: 'Money', keywords: 'expenses' },
];

function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }

function mount(props = {}) {
  const onClose = vi.fn();
  const run = vi.fn();
  render(
    <MemoryRouter initialEntries={['/']}>
      <CommandPalette open onClose={onClose} items={items} actions={[{ id: 'lock', label: 'Lock screen', run }]} recent={['/finance']} {...props} />
      <Where />
    </MemoryRouter>,
  );
  return { onClose, run };
}

describe('CommandPalette', () => {
  it('lists recent pages first when nothing is typed', () => {
    mount();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toContain('Finance');
    expect(screen.getByText('Recent')).toBeTruthy();
  });

  it('filters by name or hidden keyword and opens the first match with Enter', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    await user.type(screen.getByRole('combobox'), 'courier');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where').textContent).toBe('/orders');
    expect(onClose).toHaveBeenCalled();
  });

  it('moves with the arrow keys', async () => {
    const user = userEvent.setup();
    mount({ recent: [] });
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('where').textContent).toBe('/finance');
  });

  it('runs an action instead of navigating', async () => {
    const user = userEvent.setup();
    const { run } = mount();
    await user.type(screen.getByRole('combobox'), 'lock');
    await user.keyboard('{Enter}');
    expect(run).toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('closes on Escape and says so when nothing matches', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    await user.type(screen.getByRole('combobox'), 'qqqq');
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    mount({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
