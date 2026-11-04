import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from './UIContext';

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast.success('Saved')}>ok</button>
      <button onClick={() => toast.error('Failed')}>bad</button>
    </>
  );
}
const mount = () => render(<ToastProvider><Buttons /></ToastProvider>);
afterEach(() => vi.useRealTimers());

describe('toasts', () => {
  it('announces errors as alerts and successes as status', () => {
    mount();
    fireEvent.click(screen.getByText('ok'));
    fireEvent.click(screen.getByText('bad'));
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(screen.getByRole('alert').textContent).toContain('Failed');
  });

  it('disappears after a few seconds', () => {
    vi.useFakeTimers();
    mount();
    fireEvent.click(screen.getByText('ok'));
    act(() => vi.advanceTimersByTime(4100));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('stays while hovered, then goes after a short grace period', () => {
    vi.useFakeTimers();
    mount();
    fireEvent.click(screen.getByText('ok'));
    const toast = screen.getByRole('status');
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(20000));
    expect(screen.getByText('Saved')).toBeTruthy();
    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(2100));
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
