import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const dispatch = vi.fn();
vi.mock('../api/endpoints', () => ({ ordersApi: { dispatch: (...a) => dispatch(...a) } }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import DispatchSheet from './DispatchSheet';

const order = { id: 7, product_code: 'UT000007', delivery_fee: 30000, courier_id: 2, courier: { name: 'Juma', kind: 'rider' }, customer: { name: 'Jane' } };
const mount = (o = order) => { const onClose = vi.fn(); const onDispatched = vi.fn(); render(<DispatchSheet order={o} onClose={onClose} onDispatched={onDispatched} />); return { onClose, onDispatched }; };

beforeEach(() => { dispatch.mockReset(); dispatch.mockResolvedValue({}); });

describe('DispatchSheet', () => {
  it('will not dispatch until the delivery fee question is answered', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/whether the customer has paid the delivery fee/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sends the amount and method when the customer paid', async () => {
    const { onDispatched } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, paid' }));
    fireEvent.change(screen.getByLabelText(/Amount paid/), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('How the fee was paid'), { target: { value: 'cash' } });
    expect(screen.getByText(/of the fee is unpaid/)).toHaveTextContent(/100/);
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(7, { delivery_fee_paid: true, delivery_fee_collected: 20000, delivery_fee_method: 'cash' }));
    expect(onDispatched).toHaveBeenCalled();
  });

  it('records "not paid" and says the shop carries the cost', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'No, not paid' }));
    expect(screen.getByText(/The shop carries that part/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(7, { delivery_fee_paid: false }));
  });

  it('refuses an amount above the fee charged', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, paid' }));
    fireEvent.change(screen.getByLabelText(/Amount paid/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot have paid more/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('requires the package fee for a courier organization, and a reason when it is 0', async () => {
    mount({ ...order, courier: { name: 'Express', kind: 'organization' } });
    fireEvent.click(screen.getByRole('button', { name: 'No, not paid' }));
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/what the courier earns/i);
    fireEvent.change(screen.getByLabelText(/earns for this parcel/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a reason/);
    fireEvent.change(screen.getByLabelText(/earns for this parcel/), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(7, { delivery_fee_paid: false, package_fee: 25000 }));
  });

  it('asks nothing about the fee when none is charged', async () => {
    mount({ ...order, delivery_fee: 0, courier_id: null, courier: null });
    expect(screen.queryByText(/Has the customer paid/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Dispatch — deducts stock/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(7, {}));
  });
});
