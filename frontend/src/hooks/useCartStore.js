import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Persisted to localStorage so an in-progress cart survives a page reload,
// a browser crash, or the register being closed and reopened mid-sale —
// the cashier shouldn't have to re-scan a half-built basket because the
// tab refreshed. Same reasoning as useOfflineQueue: this is business data
// the customer is standing there watching, not a credential.
const useCartStore = create(
  persist(
    (set, get) => ({
      items: [], // { product_id, name, sku, unit_price, tax_rate, quantity, available }

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
    set({
      items: get().items.map((i) =>
        i.product_id === productId ? { ...i, quantity: Math.min(quantity, i.available) } : i
      ),
    });
  },

  removeItem: (productId) => set({ items: get().items.filter((i) => i.product_id !== productId) }),

  clear: () => set({ items: [] }),

  totals: () => {
    const items = get().items;
    // Tax is no longer added at checkout (see CHANGES.md) — total is just
    // the sum of line prices, matching what sales.service.js actually charges.
    const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    return { subtotal, total: subtotal };
  },
    }),
    { name: 'ut_cart' }
  )
);

export default useCartStore;
