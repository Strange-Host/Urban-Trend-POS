import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import ShellSwitch from './ShellSwitch';
import { setUiVersion } from '../utils/uiVersion';

// Both shells have their own tests; here they only need to prove which one was picked and that pages render inside it.
vi.mock('./Layout', () => ({
  default: () => <div data-testid="layout-v1"><Outlet /></div>,
}));
vi.mock('./v2/LayoutV2', () => ({
  default: () => <div data-testid="layout-v2"><Outlet /></div>,
}));

function mount() {
  return render(
    <MemoryRouter initialEntries={['/orders']}>
      <Suspense fallback={<div>Loading…</div>}>
        <Routes>
          <Route element={<ShellSwitch />}>
            <Route path="/orders" element={<div>Orders page</div>} />
          </Route>
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
}

beforeEach(() => { localStorage.clear(); setUiVersion('v1'); });

describe('ShellSwitch', () => {
  it('renders the current layout by default', () => {
    mount();
    expect(screen.getByTestId('layout-v1')).toBeTruthy();
    expect(screen.getByText('Orders page')).toBeTruthy();
    expect(screen.queryByTestId('layout-v2')).toBeNull();
  });

  it('renders the v2 shell when the flag is on, and the page still renders inside it', async () => {
    setUiVersion('v2');
    mount();
    expect(await screen.findByTestId('layout-v2')).toBeTruthy();
    expect(screen.queryByTestId('layout-v1')).toBeNull();
    expect(screen.getByText('Orders page')).toBeTruthy();
  });

  it('switches live when the flag changes', async () => {
    mount();
    expect(screen.queryByTestId('layout-v2')).toBeNull();
    act(() => setUiVersion('v2'));
    expect(await screen.findByTestId('layout-v2')).toBeTruthy();
    act(() => setUiVersion('v1'));
    expect(screen.getByTestId('layout-v1')).toBeTruthy();
    expect(screen.queryByTestId('layout-v2')).toBeNull();
  });
});
