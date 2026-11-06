import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** @typedef {{ product_id: number, name: string, sku: string, unit_price: number, tax_rate: number, quantity: number, available: number }} CartItem */
/** @typedef {{ id: number, name: string, sku: string, sell_price: number, tax_rate: number, total_stock: number }} CartProduct */
/**
 * @typedef {object} CartState
 * @property {CartItem[]} items
 * @property {number} discount sale-wide discount in whole cents, taken off the subtotal (never more than it)
 * @property {(product: CartProduct) => void} addItem
 * @property {(productId: number, quantity: number) => void} updateQuantity
 * @property {(productId: number) => void} removeItem
 * @property {() => void} clear
 * @property {(cents: unknown) => void} setDiscount
 * @property {() => { subtotal: number, discount: number, total: number }} totals
 */

const subtotalOf = (/** @type {CartItem[]} */ items) => items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
// Whole, non-negative cents only (anything else counts as no discount), and never more than the subtotal: the server
// refuses a discount larger than the sale, so the till never offers one.
const clampDiscount = (/** @type {CartItem[]} */ items, /** @type {unknown} */ cents) =>
  typeof cents === 'number' && Number.isInteger(cents) && cents > 0 ? Math.min(cents, subtotalOf(items)) : 0;

// Persisted to localStorage so an in-progress cart survives a page reload,
// a browser crash, or the register being closed and reopened mid-sale —
// the cashier shouldn't have to re-scan a half-built basket because the
// tab refreshed. Same reasoning as useOfflineQueue: this is business data
// the customer is standing there watching, not a credential.
const useCartStore = /** @type {import('zustand').UseBoundStore<import('zustand').StoreApi<CartState>>} */ (create(
  persist(
    /** @returns {CartState} */
    (set, get) => ({
      items: [], // { product_id, name, sku, unit_price, tax_rate, quantity, available }
      discount: 0,

  addItem: (product) => {
    const items = get().items;
    const existing = items.find((i) => i.product_id === product.id);
    if (existing) {
      if (existing.quantity >= product.total_stock) return; // guard against overselling at the UI level too
      set({
        items: items.map((i) =>
          i.product_id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        ),
      });
    } else {
      set({
        items: [
          ...items,
          {
            product_id: product.id,
            name: product.name,
            sku: product.sku,
            unit_price: product.sell_price,
            tax_rate: product.tax_rate,
            quantity: 1,
            available: product.total_stock,
          },
        ],
      });
    }
  },

  updateQuantity: (productId, quantity) => {
    if (quantity <= 0) {
      get().removeItem(productId);
      return;
    }
    const items = get().items.map((i) =>
      i.product_id === productId ? { ...i, quantity: Math.min(quantity, i.available) } : i
    );
    set({ items, discount: clampDiscount(items, get().discount) });
  },

  removeItem: (productId) => {
    const items = get().items.filter((i) => i.product_id !== productId);
    set({ items, discount: clampDiscount(items, get().discount) });
  },

  // The discount belongs to this sale: an emptied cart never carries one into the next.
  clear: () => set({ items: [], discount: 0 }),

  setDiscount: (cents) => set({ discount: clampDiscount(get().items, cents) }),

  totals: () => {
    const items = get().items;
    // Tax is no longer added at checkout (see CHANGES.md) — total is just
    // the sum of line prices, matching what sales.service.js actually charges.
    const subtotal = subtotalOf(items);
    const discount = clampDiscount(items, get().discount);
    return { subtotal, discount, total: subtotal - discount };
  },
    }),
    { name: 'ut_cart' }
  )
));

export default useCartStore;
