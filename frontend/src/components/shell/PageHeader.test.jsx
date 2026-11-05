import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PageHeader from './PageHeader';
import PageSection from './PageSection';
import { ShellChromeContext } from './pageChromeContext';
import { setUiVersion } from '../../utils/uiVersion';

const tabs = { items: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }], active: 'a', onChange: () => {} };

function withShell(ui, claim = vi.fn(() => vi.fn())) {
  const shell = { claim, status: <div data-testid="status-line" />, workspaceTabs: <div data-testid="workspace-tabs" /> };
  return { claim, ...render(<ShellChromeContext.Provider value={shell}>{ui}</ShellChromeContext.Provider>) };
}

beforeEach(() => { localStorage.clear(); setUiVersion('v1'); });

describe('PageHeader with the flag off (the old layout)', () => {
  it('shows title, description, eyebrow, meta and actions', () => {
    render(<PageHeader eyebrow="Open" title="Orders" description="All orders." meta="3 orders" actions={<button>New</button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeTruthy();
    expect(screen.getByText('All orders.')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('3 orders')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
  });

  it('draws tabs under the title', () => {
    render(<PageHeader title="Reports" tabs={tabs} />);
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows no title for a titleless page that only fronts tabs, as before', () => {
    render(<PageHeader title="Finance" titleless padding="px-4" tabs={tabs} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Beta' })).toBeTruthy();
  });

  it('never draws or claims the shell chrome', () => {
    // The context only exists inside the v2 shell; even if it were present, the old layout ignores it.
    const { claim } = withShell(<PageHeader title="Orders" />);
    expect(screen.queryByTestId('status-line')).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('PageHeader with the flag on (the new pattern)', () => {
  beforeEach(() => setUiVersion('v2'));

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

  it('still shows the title of a titleless page that fronts tabs', () => {
    withShell(<PageHeader title="Finance" titleless tabs={tabs} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Finance' })).toBeTruthy();
  });

  it('works without a shell (no chrome, no claim)', () => {
    render(<PageHeader title="Orders" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeTruthy();
    expect(screen.queryByTestId('status-line')).toBeNull();
  });
});

describe('PageHeader inside a PageSection (an embedded page)', () => {
  const embedded = (
    <PageSection>
      <PageHeader title="Payments" description="Money in and out." actions={<button>Record</button>} />
    </PageSection>
  );

  it('keeps its title in the old layout', () => {
    render(embedded);
    expect(screen.getByRole('heading', { level: 1, name: 'Payments' })).toBeTruthy();
  });

  it('drops the page title in the new one, keeping description and actions, and does not claim the chrome', () => {
    setUiVersion('v2');
    const { claim } = withShell(embedded);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Payments' }).className).toContain('sr-only');
    expect(screen.getByText('Money in and out.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record' })).toBeTruthy();
    expect(screen.queryByTestId('status-line')).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });
});
