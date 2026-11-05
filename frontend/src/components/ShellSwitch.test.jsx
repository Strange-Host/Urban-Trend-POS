import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import ShellSwitch from './ShellSwitch';
import { setUiVersion } from '../utils/uiVersion';

// The real Layout has its own tests; here it only needs to prove which shell was picked and that pages still render inside it.
vi.mock('./Layout', () => ({
  default: () => (
    <div data-testid="layout-v1"><Outlet /></div>
  ),
}));

function mount() {
  return render(
    <MemoryRouter initialEntries={['/orders']}>
      <Routes>
        <Route element={<ShellSwitch />}>
          <Route path="/orders" element={<div>Orders page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { localStorage.clear(); setUiVersion('v1'); });

describe('ShellSwitch', () => {
  it('renders the current layout by default, with no v2 marker', () => {
    mount();
    expect(screen.getByTestId('layout-v1')).toBeTruthy();
    expect(screen.getByText('Orders page')).toBeTruthy();
    expect(screen.queryByTestId('ui-v2-marker')).toBeNull();
  });

  it('renders the v2 shell when the flag is on, and the page still renders inside it', () => {
    setUiVersion('v2');
    mount();
    expect(screen.getByTestId('ui-v2-marker')).toBeTruthy();
    expect(screen.getByText('Orders page')).toBeTruthy();
  });

  it('switches live when the flag changes', () => {
    mount();
    expect(screen.queryByTestId('ui-v2-marker')).toBeNull();
    act(() => setUiVersion('v2'));
    expect(screen.getByTestId('ui-v2-marker')).toBeTruthy();
    act(() => setUiVersion('v1'));
    expect(screen.queryByTestId('ui-v2-marker')).toBeNull();
  });
});
