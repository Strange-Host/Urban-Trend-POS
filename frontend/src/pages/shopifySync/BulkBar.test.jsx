import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BulkBar from './BulkBar';

const props = (over = {}) => ({
  selectedCount: 3,
  categoryOptions: [{ value: 1, label: 'Hoodies' }],
  busy: false,
  onSetCategory: vi.fn(),
  onApprove: vi.fn(),
  onCreateCategory: vi.fn(),
  ...over,
});

describe('Shopify staging: bulk bar', () => {
  it('says how many rows are ticked and offers to approve exactly those', () => {
    render(<BulkBar {...props()} />);
    expect(screen.getByText('3 ticked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve 3' })).toBeTruthy();
  });

  it('approves when asked', () => {
    const p = props();
    render(<BulkBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve 3' }));
    expect(p.onApprove).toHaveBeenCalledTimes(1);
  });

  it('is disabled while a bulk change is running', () => {
    render(<BulkBar {...props({ busy: true })} />);
    const btn = screen.getByRole('button', { name: 'Working…' });
    expect(btn).toBeDisabled();
  });
});
