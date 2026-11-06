import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AttentionQueue from './AttentionQueue';

const item = (o) => ({ id: 'x', label: 'Thing', count: 1, detail: 'detail', to: '/x', tone: 'accent', ...o });
const show = (queue) => render(<MemoryRouter><AttentionQueue queue={{ items: [], quiet: [], isLoading: false, count: 0, ...queue }} /></MemoryRouter>);

describe('AttentionQueue', () => {
  it('shows a row per item with its count, and links it to where it is dealt with', () => {
    show({ items: [
      item({ id: 'a', label: 'Unmatched M-Pesa', count: 3, to: '/reconciliation', tone: 'warning' }),
      item({ id: 'b', label: 'Counts to review', count: 1, to: '/stock?tab=counts' }),
    ] });
    const row = screen.getByRole('link', { name: /Unmatched M-Pesa/ });
    expect(row.getAttribute('href')).toBe('/reconciliation');
    expect(row).toHaveTextContent('3');
    expect(screen.getByRole('link', { name: /Counts to review/ }).getAttribute('href')).toBe('/stock?tab=counts');
  });

  it('folds the clear checks into one quiet line under the rows', () => {
    show({ items: [item({ label: 'Transfers to approve' })], quiet: ['Courier balances', 'Void and refund requests'] });
    expect(screen.getByText('All clear: Courier balances, Void and refund requests.')).toBeInTheDocument();
  });

  it('shows one calm card when everything is clear', () => {
    show({ quiet: ['Courier balances', 'Unmatched M-Pesa'] });
    expect(screen.getByText('All clear')).toBeInTheDocument();
    expect(screen.getByText(/Checked: Courier balances, Unmatched M-Pesa/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says so when nothing is routed to this role', () => {
    show({});
    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
  });

  it('shows no rows while it is still loading', () => {
    show({ isLoading: true, items: [item({ label: 'Hidden until loaded' })] });
    expect(screen.queryByText('Hidden until loaded')).toBeNull();
  });
});
