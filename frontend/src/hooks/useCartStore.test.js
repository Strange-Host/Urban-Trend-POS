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

  describe('sale discount', () => {
    it('takes the discount off the subtotal', () => {
      const { addItem, setDiscount } = useCartStore.getState();
      addItem(tee);
      setDiscount(20000);
      expect(useCartStore.getState().totals()).toEqual({ subtotal: 120000, discount: 20000, total: 100000 });
    });

    it('cuts a discount larger than the sale back to the subtotal', () => {
      const { addItem, setDiscount } = useCartStore.getState();
      addItem(tee);
      setDiscount(999999);
      expect(useCartStore.getState().discount).toBe(120000);
      expect(useCartStore.getState().totals().total).toBe(0);
    });

    it('treats a negative, fractional or non-numeric discount as none', () => {
      const { addItem, setDiscount } = useCartStore.getState();
      addItem(tee);
      for (const bad of [-5, 10.5, NaN, null, undefined, '500']) {
        setDiscount(bad);
        expect(useCartStore.getState().discount).toBe(0);
      }
    });

    it('cannot be set on an empty cart', () => {
      useCartStore.getState().setDiscount(1000);
      expect(useCartStore.getState().discount).toBe(0);
    });

    it('is cut back when removing or reducing items shrinks the sale below it', () => {
      const { addItem, updateQuantity, removeItem, setDiscount } = useCartStore.getState();
      addItem(tee);
      updateQuantity(1, 2);
      addItem(hat);
      setDiscount(300000);
      expect(useCartStore.getState().discount).toBe(300000);
      removeItem(1);
      expect(useCartStore.getState().discount).toBe(90000);
      removeItem(2);
      expect(useCartStore.getState().discount).toBe(0);
    });

    it('is cleared with the cart so the next sale starts without one', () => {
      const { addItem, setDiscount, clear } = useCartStore.getState();
      addItem(tee);
      setDiscount(5000);
      clear();
      expect(useCartStore.getState().discount).toBe(0);
    });

    it('a cart saved before discounts existed loads with no discount', () => {
      useCartStore.setState({ items: [{ product_id: 1, name: 'Tee', unit_price: 120000, quantity: 1, available: 5 }], discount: undefined });
      expect(useCartStore.getState().totals()).toEqual({ subtotal: 120000, discount: 0, total: 120000 });
    });
  });
});
