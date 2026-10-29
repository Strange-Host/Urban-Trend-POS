import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const orderReceipt = vi.fn();
vi.mock('../api/endpoints', () => ({ receiptsApi: { order: (...a) => orderReceipt(...a) } }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ error: vi.fn() }) }));

import PrintWaybillButton, { WaybillView, QrCode, amountToCollect } from './PrintWaybill';

const data = (over = {}) => ({
  status: 'awaiting_dispatch',
  reference: 'UT000123',
  business: { name: 'Urban Trends', currency: 'KES' },
  customer: { name: 'Jane Wanjiru', phone: '0712345678', city: 'Nairobi' },
  delivery: { courier_name: 'Peter Rider', courier_phone: '0700111222', courier_type: 'boda', fee: 30000 },
  items: [{ name: 'Classic Crew T-Shirt', quantity: 2 }, { name: 'Cap', quantity: 1 }],
  totals: { total: 450000, paid: 100000, balance: 350000 },
  ...over,
});

describe('the waybill', () => {
  it('shows the order code, customer, items, the balance to collect and the rider', () => {
    render(<WaybillView data={data()} />);
    expect(screen.getByText('UT000123')).toBeInTheDocument();
    expect(screen.getByText('Jane Wanjiru')).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.getByText('KES 3,500')).toBeInTheDocument();
    expect(screen.getByText(/Rider: Peter Rider/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code for UT000123' })).toBeInTheDocument();
  });

  it('tells the rider to collect nothing when the order is paid', () => {
    render(<WaybillView data={data({ totals: { total: 450000, paid: 450000, balance: 0 } })} />);
    expect(screen.getByText('PAID: collect nothing')).toBeInTheDocument();
    expect(screen.queryByText('COLLECT')).toBeNull();
  });

  it('never collects on a cancelled order, and never goes negative', () => {
    expect(amountToCollect(data({ status: 'cancelled' }))).toBe(0);
    expect(amountToCollect(data({ totals: { balance: -500 } }))).toBe(0);
  });

  it('prints a customer name as text, never as markup', () => {
    const { container } = render(<WaybillView data={data({ customer: { name: '<img src=x onerror=alert(1)>', phone: '0700000000' } })} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('draws a QR made of squares', () => {
    const { container } = render(<QrCode text="UT000123" />);
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(50);
  });
});

describe('the Waybill button', () => {
  beforeEach(() => { orderReceipt.mockReset(); window.print = vi.fn(); });

  it('loads the current order receipt and opens the print dialog', async () => {
    orderReceipt.mockResolvedValue({ data: { data: data() } });
    render(<PrintWaybillButton orderId={7} status="awaiting_dispatch" />);
    fireEvent.click(screen.getByRole('button', { name: 'Waybill' }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(orderReceipt).toHaveBeenCalledWith(7);
    expect(document.querySelector('.print-root')).not.toBeNull();
  });

  it('is not offered for a cancelled order', () => {
    render(<PrintWaybillButton orderId={7} status="cancelled" />);
    expect(screen.queryByRole('button', { name: 'Waybill' })).toBeNull();
  });
});
