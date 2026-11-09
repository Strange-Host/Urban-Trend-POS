import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PageHeader from './PageHeader';
import PageSection from './PageSection';
import { ShellChromeContext } from './pageChromeContext';

const tabs = { items: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }], active: 'a', onChange: () => {} };

function withShell(ui, claim = vi.fn(() => vi.fn())) {
  const shell = { claim, status: <div data-testid="status-line" />, workspaceTabs: <div data-testid="workspace-tabs" /> };
  return { claim, ...render(<ShellChromeContext.Provider value={shell}>{ui}</ShellChromeContext.Provider>) };
}

describe('PageHeader', () => {
  it('shows title, description, eyebrow, meta and actions', () => {
    render(<PageHeader eyebrow="Open" title="Orders" description="All orders." meta="3 orders" actions={<button>New</button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeTruthy();
    expect(screen.getByText('All orders.')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('3 orders')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
  });

  it('puts the status line and workspace tabs under the title, then in-page tabs', () => {
    withShell(<PageHeader title="Orders" description="All orders." tabs={tabs} />);
    const order = ['Orders', 'status-line', 'All orders.', 'workspace-tabs', 'Alpha'];
    const nodes = [
      screen.getByRole('heading', { level: 1, name: 'Orders' }),
      screen.getByTestId('status-line'),
      screen.getByText('All orders.'),
      screen.getByTestId('workspace-tabs'),
      screen.getByRole('tab', { name: 'Alpha' }),
    ];
    for (let i = 1; i < nodes.length; i += 1) {
      expect(nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING, order[i]).toBeTruthy();
    }
  });

  it('claims the chrome while mounted and lets go when it unmounts', () => {
    const release = vi.fn();
    const claim = vi.fn(() => release);
    const { unmount } = withShell(<PageHeader title="Orders" />, claim);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('shows the title of a page that only fronts embedded tabs, such as Finance', () => {
    withShell(<PageHeader title="Finance" tabs={tabs} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Finance' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Beta' })).toBeTruthy();
  });

  it('works without a shell (no chrome, no claim)', () => {
    render(<PageHeader title="Orders" tabs={tabs} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('status-line')).toBeNull();
  });
});

describe('PageHeader inside a PageSection (an embedded page)', () => {
  const embedded = (
    <PageSection>
      <PageHeader title="Payments" description="Money in and out." actions={<button>Record</button>} />
    </PageSection>
  );

  it('drops the page title, keeping description and actions, and does not claim the chrome', () => {
    const { claim } = withShell(embedded);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Payments' }).className).toContain('sr-only');
    expect(screen.getByText('Money in and out.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record' })).toBeTruthy();
    expect(screen.queryByTestId('status-line')).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });
});
