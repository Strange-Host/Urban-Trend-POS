// Test helper: what each role can do, close to the real permission setup, so visibility tests start from a realistic
// person rather than "can do everything" (which, because a permission overrides the role list, shows every page to everyone).
const GRANTS = {
  admin: () => true,
  manager: () => true,
  cashier: (p) => ['sales.void_request', 'payments.refund_request'].includes(p),
  store: (p) => ['products.propose', 'stock.receive', 'stock.count'].includes(p),
};

export const ROLES = ['admin', 'manager', 'cashier', 'store'];
export const canFor = (role) => GRANTS[role] || (() => false);
export const hasRoleFor = (role) => (...roles) => roles.includes(role);
