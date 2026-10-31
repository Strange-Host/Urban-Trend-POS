import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CostsTab from './CostsTab';
import { couriersApi } from '../../api/endpoints';

vi.mock('../../api/endpoints', () => ({ couriersApi: { costs: vi.fn(), recordCost: vi.fn(), approveCost: vi.fn(), rejectCost: vi.fn() } }));
let perms = new Set();
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 5 }, can: (p) => perms.has(p) }) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../context/UIContext', () => ({ useToast: () => toast, useDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }) }));

const ok = (data) => Promise.resolve({ data: { data } });
const courier = { id: 2, name: 'Juma', kind: 'rider' };
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CostsTab courier={courier} /></QueryClientProvider>);

beforeEach(() => {
  Object.values(couriersApi).forEach((f) => f.mockReset());
  [toast.success, toast.error].forEach((f) => f.mockReset());
  couriersApi.costs.mockReturnValue(ok([]));
  perms = new Set(['couriers.costs.record', 'couriers.costs.approve']);
});

describe('CostsTab', () => {
  it('enters a cost with the amount converted to cents', async () => {
    couriersApi.recordCost.mockReturnValue(ok({ id: 9 }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Enter cost' }));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'return_trip' } });
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '1,250.5' } });
    fireEvent.change(screen.getByLabelText('What was it for?'), { target: { value: ' Parcel returned ' } });
    fireEvent.change(screen.getByLabelText(/Order number/), { target: { value: '88' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter cost' }));
    await waitFor(() => expect(couriersApi.recordCost).toHaveBeenCalledWith(2, {
      kind: 'return_trip', amount: 125050, description: 'Parcel returned', order_id: 88, receipt_ref: null,
    }));
  });

  it('rejects a missing or invalid amount without calling the API', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Enter cost' }));
    fireEvent.change(screen.getByLabelText('What was it for?'), { target: { value: 'Fuel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter cost' }));
    expect(await screen.findByText(/Enter the amount in KES/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter cost' }));
    expect(screen.getByText(/Enter the amount in KES/)).toBeInTheDocument();
    expect(couriersApi.recordCost).not.toHaveBeenCalled();
  });

  it('shows the server message when the cost is refused', async () => {
    couriersApi.recordCost.mockRejectedValue({ response: { data: { error: { message: 'Order not found.' } } } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Enter cost' }));
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('What was it for?'), { target: { value: 'Fuel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter cost' }));
    expect(await screen.findByText('Order not found.')).toBeInTheDocument();
  });

  it('lets someone who can only enter costs do so, without listing anything', async () => {
    perms = new Set(['couriers.costs.record']);
    mount();
    expect(await screen.findByRole('button', { name: '+ Enter cost' })).toBeInTheDocument();
    expect(screen.getByText(/reviewed by a manager/)).toBeInTheDocument();
    expect(couriersApi.costs).not.toHaveBeenCalled();
  });

  it('hides the entry button from someone who can only approve', async () => {
    perms = new Set(['couriers.costs.approve']);
    mount();
    expect(await screen.findByText('No costs recorded for Juma.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Enter cost' })).not.toBeInTheDocument();
  });
});
