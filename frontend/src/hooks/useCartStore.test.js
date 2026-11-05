import { describe, it, expect, beforeEach } from 'vitest';
import useCartStore from './useCartStore';

const tee = { id: 1, name: 'Tee', sku: 'T-1', sell_price: 120000, tax_rate: 0, total_stock: 5 };
const hat = { id: 2, name: 'Hat', sku: 'H-1', sell_price: 90000, tax_rate: 0, total_stock: 2 };

beforeEach(() => useCartStore.getState().clear());

describe('cart store', () => {
  it('adds a product once and counts repeat adds as quantity', () => {
    const { addItem } = useCartStore.getState();
    addItem(tee);
    addItem(tee);
    const { items } = useCartStore.getState();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ product_id: 1, name: 'Tee', unit_price: 120000, quantity: 2, available: 5 });
  });

  it('will not add more than the stock on hand', () => {
    const { addItem } = useCartStore.getState();
    addItem(hat);
    addItem(hat);
    addItem(hat);
    expect(useCartStore.getState().items[0].quantity).toBe(2);
  });

  it('caps a typed quantity at the stock on hand', () => {
    const { addItem, updateQuantity } = useCartStore.getState();
    addItem(tee);
    updateQuantity(1, 99);
    expect(useCartStore.getState().items[0].quantity).toBe(5);
  });

  it('removes a line when its quantity drops to zero', () => {
    const { addItem, updateQuantity } = useCartStore.getState();
    addItem(tee);
    updateQuantity(1, 0);
    expect(useCartStore.getState().items).toEqual([]);
  });

  it('removes a line on request and clears the whole cart', () => {
    const { addItem, removeItem, clear } = useCartStore.getState();
    addItem(tee);
    addItem(hat);
    removeItem(1);
    expect(useCartStore.getState().items.map((i) => i.product_id)).toEqual([2]);
    clear();
    expect(useCartStore.getState().items).toEqual([]);
  });

  it('totals are the sum of price times quantity, in whole cents', () => {
    const { addItem, updateQuantity, totals } = useCartStore.getState();
    addItem(tee);
    updateQuantity(1, 2);
    addItem(hat);
    expect(totals()).toMatchObject({ subtotal: 330000, total: 330000 });
  });

  it('an empty cart totals zero', () => {
    expect(useCartStore.getState().totals()).toMatchObject({ subtotal: 0, total: 0 });
  });
});
