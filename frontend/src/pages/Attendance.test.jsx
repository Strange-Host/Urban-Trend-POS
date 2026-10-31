import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Attendance from './Attendance';
import { attendanceApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  attendanceApi: { today: vi.fn(), absencesToday: vi.fn(), clockIn: vi.fn(), clockOut: vi.fn() },
  telesalesApi: { rebalance: vi.fn() },
  shiftApi: { handover: vi.fn() },
}));
vi.mock('../components/HandoverModal', () => ({ default: () => null }));
let role = 'manager';
let perms = new Set();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1 }, hasRole: (...r) => r.includes(role), can: (p) => perms.has(p) }),
}));

const ok = (data) => Promise.resolve({ data: { data } });
const mount = () => render(
  <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Attendance /></QueryClientProvider></MemoryRouter>,
);

beforeEach(() => {
  Object.values(attendanceApi).forEach((f) => f.mockReset());
  attendanceApi.today.mockReturnValue(ok([
    { staff_id: 2, name: 'Peter', clock_in_at: '2026-11-01T06:00:00Z' },
    { staff_id: 3, name: 'Amina', clock_in_at: null },
  ]));
  role = 'manager';
  perms = new Set(['attendance.view']);
});

describe('Attendance absent-today card', () => {
  it('shows how many are absent and who', async () => {
    attendanceApi.absencesToday.mockReturnValue(ok([{ staff_id: 3, name: 'Amina' }]));
    mount();
    expect(await screen.findByText('Absent today')).toBeInTheDocument();
    expect(screen.getAllByText(/Amina/).length).toBeGreaterThan(0);
    expect(attendanceApi.absencesToday).toHaveBeenCalledTimes(1);
  });

  it('says everyone is in when nobody is absent', async () => {
    attendanceApi.today.mockReturnValue(ok([{ staff_id: 2, name: 'Peter', clock_in_at: '2026-11-01T06:00:00Z' }]));
    attendanceApi.absencesToday.mockReturnValue(ok([]));
    mount();
    expect(await screen.findByText('Everyone has clocked in')).toBeInTheDocument();
  });

  it('does not call the endpoint without attendance.view', async () => {
    perms = new Set();
    mount();
    await screen.findByText('Attendance');
    expect(screen.queryByText('Absent today')).not.toBeInTheDocument();
    expect(attendanceApi.absencesToday).not.toHaveBeenCalled();
  });

  it('is not shown to a cashier', async () => {
    role = 'cashier';
    mount();
    await screen.findByText('Attendance');
    expect(attendanceApi.absencesToday).not.toHaveBeenCalled();
  });
});
