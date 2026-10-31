import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SmsSection } from './SettingsMessaging';
import { smsApi, settingsApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  smsApi: { status: vi.fn(), outbox: vi.fn(), saveCredentials: vi.fn(), removeCredentials: vi.fn(), sendTest: vi.fn(), retry: vi.fn() },
  settingsApi: { get: vi.fn(), update: vi.fn() },
  leadRoutesApi: {}, productsApi: {}, staffApi: {},
}));
vi.mock('../api/fetchAll', () => ({ fetchAll: vi.fn(() => Promise.resolve([])) }));
vi.mock('../context/UIContext', () => ({ useDialog: () => ({ confirm: vi.fn() }), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const ok = (data) => Promise.resolve({ data: { data } });
const status = (credentials) => ({ enabled: false, last7Days: {}, credentials });
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SmsSection /></QueryClientProvider>);

beforeEach(() => {
  Object.values(smsApi).forEach((f) => f.mockReset());
  settingsApi.get.mockReturnValue(ok({ sms_enabled: '0' }));
  smsApi.outbox.mockReturnValue(ok([]));
});

describe('SMS account status', () => {
  it('shows a connected account with only placeholders for the saved user ID and password', async () => {
    smsApi.status.mockReturnValue(ok(status({ configured: true, source: 'database', has_user_id: true, has_password: true, sender_id: 'URBANTREND', is_active: 1 })));
    const { container } = mount();
    expect(await screen.findByText('Connected (database)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('URBANTREND')).toBeInTheDocument();     // the sender name is not a secret
    expect(screen.getAllByText('Saved — type only to replace it.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    const secretInputs = [...container.querySelectorAll('input[type="password"]')];
    expect(secretInputs.every((i) => i.value === '')).toBe(true);
  });

  it('shows not set up, with no Remove button and the test button disabled', async () => {
    smsApi.status.mockReturnValue(ok(status({ configured: false, source: null, has_user_id: false, has_password: false, sender_id: '', is_active: null })));
    mount();
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test' })).toBeDisabled();
  });
});
