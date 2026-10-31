import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HandoverModal from './HandoverModal';

const empty = { count: 0, amount: 0, sample: [] };
const summary = (extra) => ({
  unconfirmed_cod: empty, unpaid_parcels: empty, nairobi_unpaid: empty, custody_open: empty,
  unmatched_payments: { count: 0, amount: 0 }, leads_needing_action: empty, has_open_items: false, ...extra,
});

describe('HandoverModal', () => {
  it('still offers a note for the manager when nothing is open, and sends it', () => {
    const onConfirm = vi.fn();
    render(<HandoverModal summary={summary()} actionLabel="Clock out" busy={false} onCancel={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByText(/Nothing of yours is left open/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Note for your manager/), { target: { value: '  Till is 200 short  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clock out' }));
    expect(onConfirm).toHaveBeenCalledWith('Till is 200 short');
  });

  it('lists Nairobi parcels, shop cash still held and unmatched payments', () => {
    const s = summary({
      has_open_items: true,
      unpaid_parcels: { count: 1, amount: 300000, sample: [{ id: 5, product_code: 'UT000005', total: 300000, amount_paid: 0 }] },
      nairobi_unpaid: { count: 1, amount: 300000, sample: [{ id: 5, product_code: 'UT000005', total: 300000, amount_paid: 0 }] },
      custody_open: { count: 1, amount: 100000, sample: [] },
      unmatched_payments: { count: 2, amount: 420000 },
    });
    render(<HandoverModal summary={s} actionLabel="Clock out anyway" busy={false} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText('Nairobi parcels not yet paid for')).toBeInTheDocument();
    expect(screen.getByText('Shop cash you still hold')).toBeInTheDocument();
    expect(screen.getByText(/2 payments .* still not matched to an order/)).toBeInTheDocument();
    expect(screen.getByText(/You still have items open/)).toBeInTheDocument();
  });
});
