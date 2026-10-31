import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaymentGatewaysSection } from './Settings';
import { paymentGatewaysApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  paymentGatewaysApi: {
    list: vi.fn(), get: vi.fn(), upsert: vi.fn(), deactivate: vi.fn(), test: vi.fn(),
    registerMpesaUrls: vi.fn(), simulateMpesaPayment: vi.fn(), mpesaStkPush: vi.fn(),
  },
  settingsApi: {}, incomeSourcesApi: {}, backupsApi: {}, modulesApi: {}, smsApi: {}, leadRoutesApi: {}, productsApi: {}, staffApi: {},
}));
const confirm = vi.fn();
vi.mock('../context/UIContext', () => ({ useDialog: () => ({ confirm, prompt: vi.fn() }), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
// The other settings sections are not under test here.
vi.mock('./SettingsMessaging', () => ({ CustomerPaymentDetails: () => null, SmsSection: () => null, WebFormLeadsSection: () => null }));
vi.mock('./SettingsBranches', () => ({ BranchesSection: () => null, SuppliersSection: () => null }));
vi.mock('./SettingsSystem', () => ({ ServerAddressSection: () => null, EmailSection: () => null, KcbAdvancedSection: () => null, LiveSyncControls: () => null, LiveSyncSettings: () => null }));

const ok = (data) => Promise.resolve({ data: { data } });
const mpesa = (o = {}) => ({
  provider: 'mpesa', is_active: 1, environment: 'sandbox', mpesa_shortcode: '600988',
  has_mpesa_consumer_key: true, has_mpesa_consumer_secret: true, has_mpesa_passkey: true, has_webhook_secret: true, ...o,
});
function setup(rows) {
  paymentGatewaysApi.list.mockReturnValue(ok(rows));
  paymentGatewaysApi.get.mockImplementation((provider) => ok(rows.find((r) => r.provider === provider) || null));
}
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PaymentGatewaysSection /></QueryClientProvider>);
const fillStk = (phone = '254712345678', amount = '2') => {
  fireEvent.change(screen.getByLabelText('Phone (2547XXXXXXXX)'), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText(/^Amount \(KES, 1 to/), { target: { value: amount } });
};

beforeEach(() => {
  Object.values(paymentGatewaysApi).forEach((f) => f.mockReset());
  confirm.mockReset();
});

describe('Payment gateways: status and switch-off', () => {
  it('shows each provider as live, switched off or not set up', async () => {
    setup([mpesa()]);
    mount();
    const status = await screen.findByRole('list', { name: 'Gateway status' });
    expect(status).toHaveTextContent('Live (sandbox)');
    expect(status).toHaveTextContent('KCB: Not set up');
  });

  it('shows a switched-off gateway as off and disables its actions', async () => {
    setup([mpesa({ is_active: 0 })]);
    mount();
    expect(await screen.findByRole('list', { name: 'Gateway status' })).toHaveTextContent('Switched off (sandbox)');
    expect(screen.getByText('Switched off', { selector: 'span' })).toBeInTheDocument();
    screen.getAllByRole('button', { name: 'Test connection' }).forEach((b) => expect(b).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Switch off' })).not.toBeInTheDocument();
  });

  it('switches a gateway off only after the confirmation', async () => {
    setup([mpesa()]);
    paymentGatewaysApi.deactivate.mockResolvedValue({ data: { data: mpesa({ is_active: 0 }) } });
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mount();
    const btn = await screen.findByRole('button', { name: 'Switch off' });
    fireEvent.click(btn);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(paymentGatewaysApi.deactivate).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(paymentGatewaysApi.deactivate).toHaveBeenCalledWith('mpesa'));
  });

  it('never puts a saved secret in the page', async () => {
    setup([mpesa()]);
    const { container } = mount();
    await screen.findByRole('list', { name: 'Gateway status' });
    // The API only ever sends has_* flags, so the form shows placeholders and no field holds a value.
    const filled = [...container.querySelectorAll('input[type="password"]')].filter((i) => i.value);
    expect(filled).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/secret-value|passkey-value/);
  });
});

describe('Payment gateways: test prompt', () => {
  it('keeps Send disabled until the phone, reference and amount are valid', async () => {
    setup([mpesa()]);
    mount();
    const send = await screen.findByRole('button', { name: 'Send test prompt' });
    expect(send).toBeDisabled();
    fillStk('0712345678');                 // wrong format
    expect(send).toBeDisabled();
    fillStk('254712345678', '500');        // over the test limit
    expect(send).toBeDisabled();
    fillStk('254712345678', '2');
    expect(send).toBeEnabled();
  });

  it('sends a sandbox prompt without asking, and shows what Safaricom said', async () => {
    setup([mpesa()]);
    paymentGatewaysApi.mpesaStkPush.mockResolvedValue({ data: { data: { ResponseCode: '0', CustomerMessage: 'Success. Request accepted for processing' } } });
    mount();
    await screen.findByRole('button', { name: 'Send test prompt' });
    fillStk();
    fireEvent.click(screen.getByRole('button', { name: 'Send test prompt' }));
    await waitFor(() => expect(paymentGatewaysApi.mpesaStkPush).toHaveBeenCalledWith({ phone: '254712345678', amount: 2, accountReference: 'TEST' }));
    expect(await screen.findByText('Success. Request accepted for processing')).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks first on a live gateway, and sends nothing if declined', async () => {
    setup([mpesa({ environment: 'production' })]);
    confirm.mockResolvedValue(false);
    mount();
    await screen.findByRole('button', { name: 'Send test prompt' });
    fillStk();
    fireEvent.click(screen.getByRole('button', { name: 'Send test prompt' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(paymentGatewaysApi.mpesaStkPush).not.toHaveBeenCalled();
  });

  it('shows a refusal from Safaricom as an error', async () => {
    setup([mpesa()]);
    paymentGatewaysApi.mpesaStkPush.mockResolvedValue({ data: { data: { ResponseCode: '1', ResponseDescription: 'Bad passkey' } } });
    mount();
    await screen.findByRole('button', { name: 'Send test prompt' });
    fillStk();
    fireEvent.click(screen.getByRole('button', { name: 'Send test prompt' }));
    expect(await screen.findByText('Bad passkey')).toBeInTheDocument();
  });

  it('shows the server message when the request itself fails', async () => {
    setup([mpesa()]);
    paymentGatewaysApi.mpesaStkPush.mockRejectedValue({ response: { data: { error: { message: 'Set a "Webhook shared secret" for M-Pesa first.' } } } });
    mount();
    await screen.findByRole('button', { name: 'Send test prompt' });
    fillStk();
    fireEvent.click(screen.getByRole('button', { name: 'Send test prompt' }));
    expect(await screen.findByText('Set a "Webhook shared secret" for M-Pesa first.')).toBeInTheDocument();
  });
});
