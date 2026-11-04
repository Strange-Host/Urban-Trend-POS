import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingBlock, SkeletonRows } from './Skeleton';
import EmptyState, { EmptyRow } from './EmptyState';

describe('loading and empty placeholders', () => {
  it('LoadingBlock keeps an accessible "Loading…" for screen readers', () => {
    render(<LoadingBlock />);
    expect(screen.getByRole('status').textContent).toContain('Loading…');
  });

  it('SkeletonRows draws the requested number of cells per row', () => {
    const { container } = render(<table><tbody><SkeletonRows cols={3} rows={2} /></tbody></table>);
    expect(container.querySelectorAll('tr')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(6);
    expect(screen.getAllByText('Loading…')).toHaveLength(1);
  });

  it('EmptyState shows its message and action', () => {
    render(<EmptyState title="No leads" action={<button>Add lead</button>}>Nobody has asked yet.</EmptyState>);
    expect(screen.getByText('No leads')).toBeTruthy();
    expect(screen.getByText('Nobody has asked yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add lead' })).toBeTruthy();
  });

  it('EmptyRow spans the table', () => {
    const { container } = render(<table><tbody><EmptyRow colSpan={5}>No staff found.</EmptyRow></tbody></table>);
    expect(container.querySelector('td').getAttribute('colspan')).toBe('5');
    expect(screen.getByText('No staff found.')).toBeTruthy();
  });
});
