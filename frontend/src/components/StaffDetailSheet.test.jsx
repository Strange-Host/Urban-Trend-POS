import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StaffDetailSheet from './StaffDetailSheet';
import { staffApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({ staffApi: { getById: vi.fn(), sessions: vi.fn() } }));
let role = 'admin';
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasRole: (...r) => r.includes(role) }) }));

const ok = (data) => Promise.resolve({ data: { data } });
const listed = { id: 7, name: 'Grace', role: 'cashier', status: 'active', email: 'g@x.co', phone: '0711' };
const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <StaffDetailSheet staff={listed} onClose={vi.fn()} />
  </QueryClientProvider>,
);

beforeEach(() => {
  Object.values(staffApi).forEach((f) => f.mockReset());
  staffApi.getById.mockReturnValue(ok({ ...listed, created_at: '2026-01-05 08:00:00' }));
  role = 'admin';
});

describe('StaffDetailSheet', () => {
  it('shows the record and, for an admin, the devices they are signed in on', async () => {
    staffApi.sessions.mockReturnValue(ok([
      { id: 's1', device: 'Chrome on Android', ip: '10.0.0.4', state: 'active', signedInAt: '2026-11-01 07:00:00', lastActiveAt: '2026-11-01 09:00:00' },
    ]));
    mount();
    expect(await screen.findByText('Chrome on Android')).toBeInTheDocument();
    expect(screen.getByText('g@x.co')).toBeInTheDocument();
    expect(staffApi.getById).toHaveBeenCalledWith(7);
    expect(staffApi.sessions).toHaveBeenCalledWith(7);
  });

  it('says so when nobody is signed in', async () => {
    staffApi.sessions.mockReturnValue(ok([]));
    mount();
    expect(await screen.findByText('Not signed in anywhere.')).toBeInTheDocument();
  });

  it('never asks a non-admin for sessions (the server would refuse)', async () => {
    role = 'manager';
    mount();
    expect(await screen.findByText('g@x.co')).toBeInTheDocument();
    expect(screen.queryByText('Signed-in devices')).not.toBeInTheDocument();
    expect(staffApi.sessions).not.toHaveBeenCalled();
  });
});
