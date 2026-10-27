import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WaybillView, QrCode, amountToCollect } from './PrintWaybill';
import PrintWaybillButton from './PrintWaybill';
import QRCode from 'qrcode';

const order = (over = {}) => ({
  id: 'UT-7K49M2XQ', status: 'awaiting_dispatch', outstanding: 580_000, customer: { name: 'Wanjiku', phone: '0712345678', city: null },
  items: [{ product_name: 'Sneakers', quantity: 1 }, { product_name: 'Socks', quantity: 2 }], courier: null, ...over,
});

describe('the waybill', () => {
  it('shows the reference, who it is for, what is in it and what to collect', () => {
    render(<WaybillView order={order()} />);
    expect(screen.getAllByText('UT-7K49M2XQ').length).toBeGreaterThan(0);
    expect(screen.getByText('Wanjiku')).toBeInTheDocument();
    expect(screen.getByText('0712345678')).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.getByText('COLLECT')).toBeInTheDocument();
    expect(screen.getByText('KES 5,800')).toBeInTheDocument();
  });

  it('says collect nothing for a paid order, and names the rider once there is one', () => {
    render(<WaybillView order={order({ outstanding: 0, courier: { name: 'Peter Rider' } })} />);
    expect(screen.getByText(/collect nothing/)).toBeInTheDocument();
    expect(screen.queryByText('COLLECT')).toBeNull();
    expect(screen.getByText('Rider: Peter Rider')).toBeInTheDocument();
  });

  it('prints a name as plain text, never as markup', () => {
    const { container } = render(<WaybillView order={order({ customer: { name: '<img src=x onerror=alert(1)>', phone: '0700000000' } })} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('collects the balance, and nothing for a cancelled order', () => {
    expect(amountToCollect(order())).toBe(580_000);
    expect(amountToCollect(order({ outstanding: -5 }))).toBe(0);
    expect(amountToCollect(order({ status: 'cancelled' }))).toBe(0);
  });
});

describe('the QR code', () => {
  it('draws exactly the dark squares of the code for the reference', () => {
    const { container } = render(<QrCode text="UT-7K49M2XQ" />);
    const qr = QRCode.create('UT-7K49M2XQ', { errorCorrectionLevel: 'M' });
    const dark = qr.modules.data.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(container.querySelectorAll('rect')).toHaveLength(dark);
    expect(screen.getByRole('img', { name: 'QR code for UT-7K49M2XQ' })).toBeInTheDocument();
  });
});

describe('the Waybill button', () => {
  it('is there for an order that can still be sent, and absent for a cancelled one', () => {
    const { rerender } = render(<PrintWaybillButton order={order()} />);
    expect(screen.getByRole('button', { name: 'Waybill' })).toBeInTheDocument();
    rerender(<PrintWaybillButton order={order({ status: 'cancelled' })} />);
    expect(screen.queryByRole('button', { name: 'Waybill' })).toBeNull();
  });
});
