import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Sheet from './Sheet';

describe('Sheet', () => {
  it('shows its content as a dialog and locks page scroll while open', () => {
    const { unmount } = render(<Sheet onClose={() => {}} label="Edit thing"><p>Hello</p></Sheet>);
    expect(screen.getByRole('dialog', { name: 'Edit thing' })).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('closes with Escape, and with a click on the dimmed backdrop, but not on a click inside', () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose}><button>inside</button></Sheet>);
    fireEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = document.querySelector('.sheet-backdrop');
    fireEvent.mouseDown(backdrop); fireEvent.mouseUp(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not close when a drag starts inside and ends on the backdrop (e.g. selecting text)', () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose}><input aria-label="field" /></Sheet>);
    fireEvent.mouseDown(screen.getByLabelText('field'));
    fireEvent.mouseUp(document.querySelector('.sheet-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('can refuse backdrop dismissal (for sheets that need a decision)', () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} dismissOnBackdrop={false}><p>x</p></Sheet>);
    const backdrop = document.querySelector('.sheet-backdrop');
    fireEvent.mouseDown(backdrop); fireEvent.mouseUp(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes with the phone back gesture instead of leaving the page', async () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose}><p>x</p></Sheet>);
    expect(window.history.state?.__sheet).toBeTruthy();       // it owns one history entry while open
    window.history.back();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('cleans up its history entry when closed by a button', async () => {
    const { unmount } = render(<Sheet onClose={() => {}}><p>x</p></Sheet>);
    const marker = window.history.state.__sheet;
    unmount();
    await waitFor(() => expect(window.history.state?.__sheet).not.toBe(marker));
  });

  it('only the top sheet answers Escape when sheets are stacked', () => {
    const bottom = vi.fn(); const top = vi.fn();
    render(<><Sheet onClose={bottom}><p>bottom</p></Sheet><Sheet onClose={top}><p>top</p></Sheet></>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
  });

  it('keeps a trailing row of buttons stuck to the bottom, and leaves other layouts alone', () => {
    const { container, rerender } = render(
      <Sheet onClose={() => {}}><input aria-label="a" /><div className="flex"><button>Cancel</button><button>Save</button></div></Sheet>
    );
    expect(container.ownerDocument.querySelector('.sheet-actions')).not.toBeNull();

    rerender(<Sheet onClose={() => {}}><div data-no-sticky="true" className="flex"><button>Only</button></div></Sheet>);
    expect(document.querySelector('.sheet-actions')).toBeNull();

    rerender(<Sheet onClose={() => {}}><div className="flex"><input aria-label="b" /><button>Go</button></div></Sheet>);
    expect(document.querySelector('.sheet-actions')).toBeNull();     // a row with an input in it is a field, not a button bar
  });

  it('renders as the form itself with as="form"', () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(<Sheet onClose={() => {}} as="form" onSubmit={onSubmit}><button type="submit">Save</button></Sheet>);
    fireEvent.click(screen.getByText('Save'));
    expect(onSubmit).toHaveBeenCalled();
    expect(screen.getByRole('dialog').tagName).toBe('FORM');
  });
});
