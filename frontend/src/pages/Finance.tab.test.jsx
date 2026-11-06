import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Finance from './Finance';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
// Each sub-page has its own tests; here it is just a marker for "this tab is showing".
vi.mock('./Payments', () => ({ default: () => <div>Payments tab showing</div> }));
vi.mock('./Expenses', () => ({ default: () => <div>Expenses tab showing</div> }));
vi.mock('./CashSessions', () => ({ default: () => <div>Cash sessions tab showing</div> }));
vi.mock('./Couriers', () => ({ default: () => <div>Couriers tab showing</div> }));
vi.mock('./DeliveryAreas', () => ({ default: () => <div>Delivery rates tab showing</div> }));
vi.mock('./Custody', () => ({ default: () => <div>Custody tab showing</div> }));

const at = (url) => render(<MemoryRouter initialEntries={[url]}><Finance /></MemoryRouter>);

describe('Finance opening tab', () => {
  it('opens on Payments with no ?tab=, as it always has', () => {
    at('/finance');
    expect(screen.getByText('Payments tab showing')).toBeInTheDocument();
  });

  it('opens on the tab named in ?tab=, as the Attention queue links to it', () => {
    at('/finance?tab=couriers');
    expect(screen.getByText('Couriers tab showing')).toBeInTheDocument();
  });

  it('ignores an unknown tab name', () => {
    at('/finance?tab=nonsense');
    expect(screen.getByText('Payments tab showing')).toBeInTheDocument();
  });
});
