import client from './client';

/** @typedef {import('../types').Id} Id */
/** @typedef {import('../types').Payload} Payload */
/** @typedef {import('../types').Params} Params */

export const authApi = {
  /**
   * @param {string} email
   * @param {string} password
   * @param {boolean} [remember]
   */
  login: (email, password, remember = false) => client.post('/auth/login', { email, password, remember }),
  /**
   * @param {string} challengeToken
   * @param {string} code
   * @param {boolean} [remember]
   */
  verifyOtp: (challengeToken, code, remember = false) => client.post('/auth/verify-otp', { challengeToken, code, remember }),
  /** @param {string} secret */
  unlock: (secret) => client.post('/auth/unlock', secret),          // { password } or { pin }
  activity: () => client.post('/auth/activity', {}),
  sessions: () => client.get('/auth/sessions'),
  /** @param {Id} id */
  endSession: (id) => client.delete(`/auth/sessions/${id}`),
  endOtherSessions: () => client.post('/auth/sessions/revoke-others', {}),
  /** @param {string} challengeToken */
  resendOtp: (challengeToken) => client.post('/auth/resend-otp', { challengeToken }),
  refresh: () => client.post('/auth/refresh'),
  logout: () => client.post('/auth/logout'),
  me: () => client.get('/auth/me'),
  /**
   * @param {string} currentPassword
   * @param {string} newPassword
   */
  changePassword: (currentPassword, newPassword) => client.post('/auth/change-password', { currentPassword, newPassword }),
};

export const productsApi = {
  /** @param {Params} params */
  list: (params) => client.get('/products', { params }),
  /** @param {string} code */
  getByBarcode: (code) => client.get(`/products/barcode/${code}`),
  /** @param {Payload} data */
  create: (data) => client.post('/products', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.put(`/products/${id}`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/products/${id}`),
  listPending: () => client.get('/products/pending/list'),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  approve: (id, data) => client.post(`/products/${id}/approve`, data || {}),
  /**
   * @param {Id} id
   * @param {string} note
   */
  reject: (id, note) => client.post(`/products/${id}/reject`, { note }),
  // Move a product between the shop catalogue and the online (Shopify/WooCommerce) one.
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  setCatalogue: (id, data) => client.post(`/products/${id}/catalogue`, data),
};

export const categoriesApi = {
  /** @param {Params} params */
  list: (params) => client.get('/categories', { params }),
  /** @param {Payload} data */
  create: (data) => client.post('/categories', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.put(`/categories/${id}`, data),
  /** @param {Id} id */
  usage: (id) => client.get(`/categories/${id}/usage`),
  /**
   * @param {Id} id
   * @param {Id} moveTo
   */
  remove: (id, moveTo) => client.delete(`/categories/${id}`, { params: moveTo ? { move_to: moveTo } : undefined }),
  /** @param {Id} id */
  archive: (id) => client.post(`/categories/${id}/archive`, {}),
  /** @param {Id} id */
  restore: (id) => client.post(`/categories/${id}/restore`, {}),
};

export const inventoryApi = {
  list: () => client.get('/inventory'),
  lowStock: () => client.get('/inventory/low-stock'),
  /** @param {Payload} data */
  adjust: (data) => client.post('/inventory/adjust', data),
  // Ledger for one product, newest first. params: { page, limit, store_id }.
  /**
   * @param {Id} productId
   * @param {Params} params
   */
  movements: (productId, params) => client.get(`/inventory/${productId}/movements`, { params }),
  // Rows whose cached quantity no longer matches the movement ledger. Read-only.
  reconcileCheck: () => client.get('/inventory/reconcile'),
  // Admin only: resets every drifted row (all branches) to the ledger sum.
  reconcile: () => client.post('/inventory/reconcile'),
};

export const salesApi = {
  /** @param {Payload} data */
  checkout: (data) => client.post('/sales', data),
  /** @param {Params} params */
  list: (params) => client.get('/sales', { params }),
  /** @param {Id} id */
  getById: (id) => client.get(`/sales/${id}`),
  /** @param {Id} id */
  void: (id) => client.post(`/sales/${id}/void`),
};

export const modulesApi = {
  get: () => client.get('/modules'),
  /** @param {Payload} data */
  update: (data) => client.put('/modules', data),
};

export const settingsApi = {
  get: () => client.get('/settings'),
  /** @param {Payload} data */
  update: (data) => client.put('/settings', data),
};

export const backupsApi = {
  list: () => client.get('/backups'),
  run: () => client.post('/backups/run'),
  emailNow: () => client.post('/backups/email-now'),
};

export const paymentGatewaysApi = {
  list: () => client.get('/settings/payment-gateways'),
  /** @param {string} provider */
  get: (provider) => client.get(`/settings/payment-gateways/${provider}`),
  /**
   * @param {string} provider
   * @param {Payload} data
   */
  upsert: (provider, data) => client.put(`/settings/payment-gateways/${provider}`, data),
  /** @param {string} provider */
  deactivate: (provider) => client.delete(`/settings/payment-gateways/${provider}`),
  /** @param {string} provider */
  test: (provider) => client.post(`/settings/payment-gateways/${provider}/test`),
  registerMpesaUrls: () => client.post('/settings/payment-gateways/mpesa/register-urls'),
  /** @param {Payload} data */
  simulateMpesaPayment: (data) => client.post('/settings/payment-gateways/mpesa/simulate', data),
  /** @param {Payload} data */
  mpesaStkPush: (data) => client.post('/settings/payment-gateways/mpesa/stk-push', data),
};

export const smsApi = {
  status: () => client.get('/sms/status'),
  getCredentials: () => client.get('/sms/credentials'),
  /** @param {Payload} data */
  saveCredentials: (data) => client.put('/sms/credentials', data),
  removeCredentials: () => client.delete('/sms/credentials'),
  /** @param {string} to */
  sendTest: (to) => client.post('/sms/test', { to }),
  /** @param {Params} params */
  outbox: (params) => client.get('/sms/outbox', { params }),
  /** @param {Id} id */
  retry: (id) => client.post(`/sms/outbox/${id}/retry`),
};

export const notificationsApi = {
  /** @param {Params} params */
  list: (params) => client.get('/notifications', { params }),
  unreadCount: () => client.get('/notifications/unread-count'),
  /** @param {Id} id */
  markRead: (id) => client.post(`/notifications/${id}/read`),
  markAllRead: () => client.post('/notifications/read-all'),
};

export const incomeSourcesApi = {
  list: () => client.get('/income-sources'),
  /** @param {Id} id */
  getById: (id) => client.get(`/income-sources/${id}`),
  /** @param {Payload} data */
  create: (data) => client.post('/income-sources', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.patch(`/income-sources/${id}`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/income-sources/${id}`),
  /** @param {Id} id */
  connect: (id) => client.post(`/income-sources/${id}/connect`),
  /** @param {Id} id */
  test: (id) => client.post(`/income-sources/${id}/test`),
  /** @param {Id} id */
  syncProducts: (id) => client.post(`/income-sources/${id}/sync-products`),
  // opts: {} = since the last sync | { days: 365 } = backfill N days | { all: true } = everything the platform allows
  /**
   * @param {Id} id
   * @param {Params} [opts]
   */
  syncSales: (id, opts = {}) => client.post(`/income-sources/${id}/sync-sales`, opts),
  /** @param {Id} id */
  liveSyncStatus: (id) => client.get(`/income-sources/${id}/live-sync`),
  /** @param {Id} id */
  liveSyncEnable: (id) => client.post(`/income-sources/${id}/live-sync/enable`),
  /** @param {Id} id */
  liveSyncDisable: (id) => client.post(`/income-sources/${id}/live-sync/disable`),
};

export const shopifyApi = {
  connections: () => client.get('/integrations/shopify/connections'),
  // incomeSourceId omitted = every connected store
  /** @param {Id} incomeSourceId */
  sync: (incomeSourceId) => client.post('/integrations/shopify/sync', incomeSourceId ? { income_source_id: incomeSourceId } : {}),
  /** @param {string} [status] */
  listStaging: (status = 'pending') => client.get('/integrations/shopify/staging', { params: { status } }),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  updateStaging: (id, data) => client.patch(`/integrations/shopify/staging/${id}`, data),
  /** @param {Id} id */
  approve: (id) => client.post(`/integrations/shopify/staging/${id}/approve`),
  /** @param {Id} id */
  reject: (id) => client.post(`/integrations/shopify/staging/${id}/reject`),
  approveAll: () => client.post('/integrations/shopify/staging/approve-all'),
};

export const reportsApi = {
  /** @param {Params} params */
  salesSummary: (params) => client.get('/reports/sales-summary', { params }),
  /** @param {Params} params */
  topProducts: (params) => client.get('/reports/top-products', { params }),
  inventoryValue: () => client.get('/reports/inventory-value'),
  /** @param {Params} params */
  inventoryValuation: (params) => client.get('/reports/inventory-valuation', { params }),
  /** @param {Params} params */
  salesByChannel: (params) => client.get('/reports/sales-by-channel', { params }),
  /** @param {Params} params */
  salesTrend: (params) => client.get('/reports/sales-trend', { params }),
  /** @param {Params} params */
  paymentMethods: (params) => client.get('/reports/payment-methods', { params }),
  /** @param {Params} params */
  topProductsByChannel: (params) => client.get('/reports/top-products-by-channel', { params }),
  /** @param {Params} params */
  pnl: (params) => client.get('/reports/pnl', { params }),
  /** @param {Params} params */
  discounts: (params) => client.get('/reports/discounts', { params }),
  /** @param {Params} params */
  vat: (params) => client.get('/reports/vat', { params }),
  /** @param {Params} params */
  branchComparison: (params) => client.get('/reports/branch-comparison', { params }),
  /** @param {Params} params */
  agentPerformance: (params) => client.get('/reports/agent-performance', { params }),
  /**
   * @param {string} month
   * @param {Payload} data
   */
  setForecast: (month, data) => client.put(`/reports/forecasts/${month}`, data),
  /** @param {Params} params */
  dashboardOverview: (params) => client.get('/reports/dashboard-overview', { params }),
  /** @param {Params} params */
  unpaidParcels: (params) => client.get('/reports/unpaid-parcels', { params }),
  /** @param {Params} params */
  topProductsByProfit: (params) => client.get('/reports/top-products-by-profit', { params }),
  /** @param {Params} params */
  topStaffByProfit: (params) => client.get('/reports/top-staff-by-profit', { params }),
};

export const leadsApi = {
  /** @param {Params} params */
  list: (params) => client.get('/leads', { params }),
  stats: () => client.get('/leads/stats'),
  /** @param {Id} id */
  getById: (id) => client.get(`/leads/${id}`),
  /** @param {Payload} data */
  create: (data) => client.post('/leads', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.patch(`/leads/${id}`, data),
  /**
   * @param {Id} id
   * @param {string} status
   * @param {string} followUpDate
   */
  changeStatus: (id, status, followUpDate) => client.patch(`/leads/${id}/status`, { status, follow_up_date: followUpDate }),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  convert: (id, data) => client.post(`/leads/${id}/convert`, data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  addActivity: (id, data) => client.post(`/leads/${id}/activities`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/leads/${id}`),
};

export const requisitionsApi = {
  /** @param {Params} params */
  list: (params) => client.get('/requisitions', { params }),
  /** @param {Id} id */
  getById: (id) => client.get(`/requisitions/${id}`),
  /** @param {Payload} data */
  create: (data) => client.post('/requisitions', data),
  /**
   * @param {Id} id
   * @param {Payload[]} items
   */
  approve: (id, items) => client.patch(`/requisitions/${id}/approve`, { items }),
  /**
   * @param {Id} id
   * @param {string} rejection_reason
   */
  reject: (id, rejection_reason) => client.patch(`/requisitions/${id}/reject`, { rejection_reason }),
  // The requester signs (typed name) that they received the money or goods. create() takes signed_name too.
  /**
   * @param {Id} id
   * @param {string} signed_name
   */
  acknowledge: (id, signed_name) => client.patch(`/requisitions/${id}/acknowledge`, { signed_name }),
};

export const expensesApi = {
  /** @param {Params} params */
  list: (params) => client.get('/expenses', { params }),
  /** @param {Params} params */
  summary: (params) => client.get('/expenses/summary', { params }),
  /** @param {Id} id */
  getById: (id) => client.get(`/expenses/${id}`),
  /** @param {Payload} data */
  create: (data) => client.post('/expenses', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.patch(`/expenses/${id}`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/expenses/${id}`),
  listCategories: () => client.get('/expenses/categories'),
  /** @param {string} name */
  createCategory: (name) => client.post('/expenses/categories', { name }),
  /** @param {Id} id */
  approve: (id) => client.post(`/expenses/${id}/approve`),
  /**
   * @param {Id} id
   * @param {string} note
   */
  reject: (id, note) => client.post(`/expenses/${id}/reject`, { note }),
};

export const pettyCashApi = {
  overview: () => client.get('/petty-cash'),
  /** @param {Payload} data */
  createTopup: (data) => client.post('/petty-cash/topups', data),
  /** @param {Id} id */
  approveTopup: (id) => client.post(`/petty-cash/topups/${id}/approve`),
  /**
   * @param {Id} id
   * @param {string} note
   */
  rejectTopup: (id, note) => client.post(`/petty-cash/topups/${id}/reject`, { note }),
};

export const storesApi = {
  list: () => client.get('/stores'),
  /** @param {Payload} data */
  create: (data) => client.post('/stores', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.put(`/stores/${id}`, data),
};

export const suppliersApi = {
  /** @param {Params} params */
  list: (params) => client.get('/suppliers', { params }),
  /** @param {Payload} data */
  create: (data) => client.post('/suppliers', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.put(`/suppliers/${id}`, data),
};

// Main-store inventory control: receiving, issuing, transfers, outlet counts, and who-did-what.
export const stockApi = {
  /** @param {Params} params */
  receipts: (params) => client.get('/stock/receipts', { params }),
  /** @param {Payload} data */
  receive: (data) => client.post('/stock/receipts', data),
  /** @param {Params} params */
  issues: (params) => client.get('/stock/issues', { params }),
  /** @param {Payload} data */
  issue: (data) => client.post('/stock/issues', data),
  /** @param {Params} params */
  transfers: (params) => client.get('/stock/transfers', { params }),
  /** @param {Payload} data */
  requestTransfer: (data) => client.post('/stock/transfers', data),
  /** @param {Id} id */
  approveTransfer: (id) => client.post(`/stock/transfers/${id}/approve`),
  /**
   * @param {Id} id
   * @param {string} note
   */
  rejectTransfer: (id, note) => client.post(`/stock/transfers/${id}/reject`, { note }),
  /** @param {Id} id */
  cancelTransfer: (id) => client.post(`/stock/transfers/${id}/cancel`),
  /** @param {Params} params */
  counts: (params) => client.get('/stock/counts', { params }),
  /** @param {Id} id */
  count: (id) => client.get(`/stock/counts/${id}`),
  /** @param {Payload} data */
  submitCount: (data) => client.post('/stock/counts', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  approveCount: (id, data) => client.post(`/stock/counts/${id}/approve`, data || {}),
  /**
   * @param {Id} id
   * @param {string} note
   */
  rejectCount: (id, note) => client.post(`/stock/counts/${id}/reject`, { note }),
  /** @param {Params} params */
  daySummary: (params) => client.get('/stock/counts/day-summary', { params }),
  /** @param {Params} params */
  activity: (params) => client.get('/stock/activity', { params }),
  // Batches: expiry, recall, buying price per batch, and the stock alerts
  /** @param {Params} params */
  batches: (params) => client.get('/stock/batches', { params }),
  /**
   * @param {Id} id
   * @param {string} note
   */
  recallBatch: (id, note) => client.post(`/stock/batches/${id}/recall`, { note }),
  /** @param {Params} params */
  alerts: (params) => client.get('/stock/alerts', { params }),
  /** @param {Params} params */
  damaged: (params) => client.get('/stock/damaged', { params }),
  /** @param {Params} params */
  awaitingCost: (params) => client.get('/stock/receipts/awaiting-cost', { params }),
  /**
   * @param {Id} receiptId
   * @param {Payload} data
   */
  setCosts: (receiptId, data) => client.put(`/stock/receipts/${receiptId}/costs`, data),
};

export const paymentsApi = {
  /** @param {Params} params */
  list: (params) => client.get('/payments', { params }),
  /** @param {Params} params */
  summary: (params) => client.get('/payments/summary', { params }),
  /** @param {Payload} data */
  create: (data) => client.post('/payments', data),
  /** @param {Id} id */
  refund: (id) => client.post(`/payments/${id}/refund`),
};

// Void / refund requests: a cashier asks, a manager approves or rejects (approving runs the void / refund).
export const approvalsApi = {
  /** @param {Params} params */
  list: (params) => client.get('/approvals', { params }),
  /** @param {Payload} data */
  create: (data) => client.post('/approvals', data),          // { kind: 'void_sale', sale_id, reason } | { kind: 'refund_payment', payment_id, reason }
  /** @param {Id} id */
  approve: (id) => client.post(`/approvals/${id}/approve`),
  /**
   * @param {Id} id
   * @param {string} note
   */
  reject: (id, note) => client.post(`/approvals/${id}/reject`, { note }),
  /** @param {Id} id */
  cancel: (id) => client.post(`/approvals/${id}/cancel`),
};

export const cashSessionsApi = {
  current: () => client.get('/cash-sessions/current'),
  /** @param {number | string} openingAmount */
  open: (openingAmount) => client.post('/cash-sessions/open', { openingAmount }),
  /**
   * @param {Id} id
   * @param {number | string} closingAmount
   * @param {string} handoverNotes
   */
  close: (id, closingAmount, handoverNotes) => client.post(`/cash-sessions/${id}/close`, { closingAmount, ...(handoverNotes ? { handover_notes: handoverNotes } : {}) }),
  /** @param {Params} params */
  list: (params) => client.get('/cash-sessions', { params }),
  /** @param {Id} id */
  getById: (id) => client.get(`/cash-sessions/${id}`),
};

export const staffApi = {
  /** @param {Params} params */
  list: (params) => client.get('/staff', { params }),
  /** @param {Id} id */
  getById: (id) => client.get(`/staff/${id}`),
  /** @param {Payload} data */
  create: (data) => client.post('/staff', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.patch(`/staff/${id}`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/staff/${id}`),
  /** @param {Id} id */
  resetPassword: (id) => client.post(`/staff/${id}/reset-password`),
  /** @param {Id} id */
  removalCheck: (id) => client.get(`/staff/${id}/removal-check`),
  /** @param {Id} id */
  reactivate: (id) => client.post(`/staff/${id}/reactivate`, {}),
  /**
   * @param {Id} id
   * @param {string} confirmName
   */
  permanentDelete: (id, confirmName) => client.post(`/staff/${id}/permanent-delete`, { confirmName }),
  /**
   * @param {Id} id
   * @param {string} confirmName
   */
  erasePersonalData: (id, confirmName) => client.post(`/staff/${id}/erase-personal-data`, { confirmName }),
  /** @param {Id} id */
  signOutEverywhere: (id) => client.post(`/staff/${id}/sign-out-everywhere`, {}),
  /** @param {Id} id */
  sessions: (id) => client.get(`/staff/${id}/sessions`),
  /** @param {Id} id */
  unlockAccount: (id) => client.post(`/staff/${id}/unlock-account`, {}),
};

export const securityApi = {
  policy: () => client.get('/security/policy'),
  /** @param {Payload} data */
  updatePolicy: (data) => client.put('/security/policy', data),
  /** @param {Params} params */
  events: (params) => client.get('/security/events', { params }),
};

export const staffLogsApi = {
  /** @param {Params} params */
  list: (params) => client.get('/staff-logs', { params }),
  /** @param {Params} params */
  stats: (params) => client.get('/staff-logs/stats', { params }),
};

// --- Phase 5 modules: shipped backends that previously had no UI ---

export const customersApi = {
  // Every order one customer has placed at this shop, newest first, with totals. By id, or by phone in any format.
  /**
   * @param {Id} id
   * @param {Params} params
   */
  orders: (id, params) => client.get(`/customers/${id}/orders`, { params }),
  /**
   * @param {string} phone
   * @param {Params} params
   */
  ordersByPhone: (phone, params) => client.get('/customers/orders', { params: { phone, ...params } }),
};

export const ordersApi = {
  /** @param {Params} params */
  list: (params) => client.get('/orders', { params }),
  /** @param {Params} params */
  atRisk: (params) => client.get('/orders/at-risk', { params }),
  /** @param {Id} id */
  get: (id) => client.get(`/orders/${id}`),
  /** @param {Payload} data */
  create: (data) => client.post('/orders', data),
  /**
   * @param {Id} id
   * @param {Payload[]} items
   */
  mergeItems: (id, items) => client.post(`/orders/${id}/merge-items`, { items }),
  // The full list the order should end up with (add, change quantity, remove). Only while awaiting dispatch.
  /**
   * @param {Id} id
   * @param {Payload[]} items
   */
  replaceItems: (id, items) => client.put(`/orders/${id}/items`, { items }),
  // Customers with more than one order awaiting dispatch (optionally just the one a given order belongs to).
  /** @param {Id} orderId */
  mergeGroups: (orderId) => client.get('/orders/merge-groups', { params: orderId ? { order_id: orderId } : {} }),
  // Needs confirm: true, which the screen sends only after the person has agreed.
  /**
   * @param {Id} keepOrderId
   * @param {Id[]} mergeOrderIds
   */
  mergeOrders: (keepOrderId, mergeOrderIds) => client.post('/orders/merge', { keep_order_id: keepOrderId, merge_order_ids: mergeOrderIds, confirm: true }),
  /** @param {Id} id */
  confirmCod: (id) => client.post(`/orders/${id}/confirm-cod`),
  /**
   * @param {Id} id
   * @param {string} courierType
   */
  setCourier: (id, courierType) => client.post(`/orders/${id}/courier`, { courier_type: courierType }),
  /**
   * @param {Id} id
   * @param {Id} courierId
   */
  assignCourier: (id, courierId) => client.post(`/orders/${id}/courier`, { courier_id: courierId }),
  onlineSources: () => client.get('/orders/online-sources'),
  /**
   * @param {Id} incomeSourceId
   * @param {number | string} days
   */
  pullOnline: (incomeSourceId, days) => client.post('/orders/pull-online', { income_source_id: incomeSourceId, ...(days ? { days } : {}) }),
  // body: { delivery_fee_paid, delivery_fee_collected (cents), delivery_fee_method, delivery_fee_reference, package_fee (cents), package_fee_zero_reason }
  /**
   * @param {Id} id
   * @param {Payload} [body]
   */
  dispatch: (id, body = {}) => client.post(`/orders/${id}/dispatch`, body),
  /** @param {Id} id */
  delivery: (id) => client.get(`/orders/${id}/delivery`),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  addFeeReceipt: (id, data) => client.post(`/orders/${id}/delivery/fee-receipts`, data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  addDeliveryCost: (id, data) => client.post(`/orders/${id}/delivery/costs`, data),
  /**
   * @param {Id} id
   * @param {string} note
   * @param {string} writeOffReason
   */
  closeDelivery: (id, note, writeOffReason) => client.post(`/orders/${id}/delivery/close`, { note, ...(writeOffReason ? { write_off_reason: writeOffReason } : {}) }),
  // Correct a wrong package fee ({ target_type: 'package_fee', delta, reason }) or a rider cost ({ target_type: 'courier_cost', cost_id, delta, reason }).
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  addAdjustment: (id, data) => client.post(`/orders/${id}/delivery/adjustments`, data),
  /**
   * @param {Id} id
   * @param {string} reason
   */
  reopenDelivery: (id, reason) => client.post(`/orders/${id}/delivery/reopen`, { reason }),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  recordPayment: (id, data) => client.post(`/orders/${id}/payments`, data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  returnedInTransit: (id, data) => client.post(`/orders/${id}/returned-in-transit`, data),
  /** @param {Id} id */
  returnedAwaitingInspection: (id) => client.post(`/orders/${id}/returned-awaiting-inspection`),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  inspect: (id, data) => client.post(`/orders/${id}/inspect`, data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  ownerDecision: (id, data) => client.post(`/orders/${id}/owner-decision`, data),
  /** @param {Params} params */
  pendingOwnerDecision: (params) => client.get('/orders/pending-owner-decision', { params }),
  integrity: () => client.get('/orders/integrity'),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  shopCash: (id, data) => client.post(`/orders/${id}/shop-cash`, data),
  /**
   * @param {Id} id
   * @param {string} reason
   */
  openDispute: (id, reason) => client.post(`/orders/${id}/dispute`, { reason }),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  resolveDispute: (id, data) => client.post(`/orders/${id}/dispute/resolve`, data),
  /**
   * @param {Id} id
   * @param {string} notes
   */
  cancel: (id, notes) => client.post(`/orders/${id}/cancel`, { notes }),
};

export const paymentReconciliationApi = {
  /** @param {Params} params */
  unmatched: (params) => client.get('/payment-reconciliation/unmatched', { params }),
  /**
   * @param {Id} id
   * @param {Id} orderId
   */
  match: (id, orderId) => client.post(`/payment-reconciliation/${id}/match`, { order_id: orderId }),
  /**
   * @param {Id} id
   * @param {string} notes
   */
  ignore: (id, notes) => client.post(`/payment-reconciliation/${id}/ignore`, { notes }),
};

export const attendanceApi = {
  clockIn: () => client.post('/attendance/clock-in'),
  // { notes, dispatched, nairobi }: the handover note and the two clock-out confirmations (all assigned orders
  // dispatched, all Nairobi payments reconciled). The server checks both against the data.
  /** @param {{ notes?: string, dispatched?: boolean, nairobi?: boolean }} [opts] */
  clockOut: ({ notes, dispatched, nairobi } = {}) => client.post('/attendance/clock-out', {
    ...(notes ? { handover_notes: notes } : {}),
    confirm_all_dispatched: dispatched === true,
    confirm_nairobi_reconciled: nairobi === true,
  }),
  /** @param {string} date */
  today: (date) => client.get('/attendance/today', { params: date ? { date } : {} }),
  absencesToday: () => client.get('/attendance/absences-today'),
  /** @param {string} date */
  endOfDay: (date) => client.get('/end-of-day', { params: date ? { date } : {} }),
  /** @param {{ date: string, note?: string, acknowledged?: boolean }} opts */
  approveEndOfDay: ({ date, note, acknowledged }) => client.post('/end-of-day/approve', { date, note, acknowledged }),
};

export const payrollApi = {
  /**
   * @param {Id} staffId
   * @param {string} from
   * @param {string} to
   */
  summary: (staffId, from, to) => client.get('/payroll/summary', { params: { staff_id: staffId, from, to } }),
  /** @param {Payload} data */
  lossDeduction: (data) => client.post('/payroll/loss-deduction', data),
  // Locked payroll runs: draft -> approved (locked) -> paid. Approve and pay are admin-only on the server.
  runs: () => client.get('/payroll/runs'),
  /** @param {Id} id */
  run: (id) => client.get(`/payroll/runs/${id}`),
  /** @param {Id} id */
  verifyRun: (id) => client.get(`/payroll/runs/${id}/verify`),
  // generateRun({ month: '2026-10' }) for a whole calendar month, or generateRun(from, to) for part of one.
  /**
   * @param {string | { month: string }} fromOrOpts
   * @param {string} [to]
   */
  generateRun: (fromOrOpts, to) => client.post('/payroll/runs', typeof fromOrOpts === 'object' ? fromOrOpts : { from: fromOrOpts, to }),
  /** @param {Id} id */
  approveRun: (id) => client.post(`/payroll/runs/${id}/approve`),
  // Paying is signed off: the payer's own typed name plus the run's checksum (what they are signing for).
  /**
   * @param {Id} id
   * @param {string} method
   * @param {string} paymentRef
   * @param {string} signedName
   * @param {string} checksum
   */
  payRun: (id, method, paymentRef, signedName, checksum) => client.post(`/payroll/runs/${id}/pay`, {
    method, payment_ref: paymentRef || undefined, signed_name: signedName, checksum,
  }),
  cycle: () => client.get('/payroll/cycle'),
  payTerms: () => client.get('/payroll/pay-terms'),
  /**
   * @param {Id} staffId
   * @param {Payload} data
   */
  setPayTerms: (staffId, data) => client.put(`/payroll/pay-terms/${staffId}`, data),
};

export const employeesApi = {
  /** @param {Payload} data */
  onboard: (data) => client.post('/employees/onboard', data),
  /** @param {Id} id */
  onboardingStatus: (id) => client.get(`/employees/${id}/onboarding-status`),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  uploadDocument: (id, data) => client.post(`/employees/${id}/documents`, data),
  /**
   * @param {Id} id
   * @param {string} signedName
   */
  signAgreement: (id, signedName) => client.post(`/employees/${id}/sign-agreement`, { signed_name: signedName }),
};

export const telesalesApi = {
  rebalance: () => client.post('/telesales/rebalance'),
};

export const deliveryApi = {
  /** @param {Params} params */
  settlements: (params) => client.get('/delivery/settlements', { params }),
  pendingCosts: () => client.get('/delivery/costs/pending'),
  /** @param {Id} id */
  approveCost: (id) => client.post(`/delivery/costs/${id}/approve`),
  /**
   * @param {Id} id
   * @param {string} reason
   */
  rejectCost: (id, reason) => client.post(`/delivery/costs/${id}/reject`, { reason }),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  reverseCost: (id, data) => client.post(`/delivery/costs/${id}/reverse`, data),
  /** @param {Id} id */
  approveAdjustment: (id) => client.post(`/delivery/adjustments/${id}/approve`),
  /**
   * @param {Id} id
   * @param {string} reason
   */
  rejectAdjustment: (id, reason) => client.post(`/delivery/adjustments/${id}/reject`, { reason }),
  unverifiedReceipts: () => client.get('/delivery/fee-receipts/unverified'),
  /**
   * @param {Id} id
   * @param {string} note
   */
  verifyReceipt: (id, note) => client.post(`/delivery/fee-receipts/${id}/verify`, { note }),
};

export const couriersApi = {
  /** @param {Params} params */
  list: (params) => client.get('/couriers', { params }),
  /** @param {Payload} data */
  create: (data) => client.post('/couriers', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.patch(`/couriers/${id}`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/couriers/${id}`),
  // Riders: what is owed, costs awaiting approval, payouts (couriers.pay / couriers.costs.*)
  payables: () => client.get('/couriers/payables'),
  /** @param {Id} id */
  balance: (id) => client.get(`/couriers/${id}/payables`),
  /** @param {Params} params */
  costs: (params) => client.get('/couriers/costs', { params }),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  recordCost: (id, data) => client.post(`/couriers/${id}/costs`, data),
  /** @param {Id} costId */
  approveCost: (costId) => client.post(`/couriers/costs/${costId}/approve`),
  /**
   * @param {Id} costId
   * @param {Payload} data
   */
  rejectCost: (costId, data) => client.post(`/couriers/costs/${costId}/reject`, data),
  /** @param {Params} params */
  payouts: (params) => client.get('/couriers/payouts', { params }),
  /** @param {Id} payoutId */
  payout: (payoutId) => client.get(`/couriers/payouts/${payoutId}`),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  createPayout: (id, data) => client.post(`/couriers/${id}/payouts`, data),
  // Courier organizations: standing, collections, statements (couriers.settle)
  /** @param {Id} id */
  standing: (id) => client.get(`/couriers/${id}/standing`),
  /** @param {Id} id */
  collections: (id) => client.get(`/couriers/${id}/collections`),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  recordCollection: (id, data) => client.post(`/couriers/${id}/collections`, data),
  /** @param {Id} id */
  statements: (id) => client.get(`/couriers/${id}/statements`),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  createStatement: (id, data) => client.post(`/couriers/${id}/statements`, data),
};

// Shop cash held by staff until it is deposited (custody.manage). A deposit takes no body: it closes the whole record.
export const custodyApi = {
  list: () => client.get('/custody'),
  /** @param {Id} id */
  deposit: (id) => client.post(`/custody/${id}/deposit`),
};

export const shiftApi = {
  handover: () => client.get('/shift/handover'),
};

export const deliveryAreasApi = {
  /** @param {Params} params */
  list: (params) => client.get('/delivery-areas', { params }),
  /** @param {Payload} data */
  create: (data) => client.post('/delivery-areas', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.patch(`/delivery-areas/${id}`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/delivery-areas/${id}`),
  /** @param {Payload[]} rows */
  importRows: (rows) => client.post('/delivery-areas/import', { rows }),
};

export const receiptsApi = {
  /** @param {Id} id */
  order: (id) => client.get(`/orders/${id}/receipt`),
  /** @param {Id} id */
  sale: (id) => client.get(`/sales/${id}/receipt`),
};

export const leadRoutesApi = {
  secret: () => client.get('/integrations/leads/secret'),
  list: () => client.get('/integrations/leads/routes'),
  /** @param {Payload} data */
  create: (data) => client.post('/integrations/leads/routes', data),
  /**
   * @param {Id} id
   * @param {Payload} data
   */
  update: (id, data) => client.patch(`/integrations/leads/routes/${id}`, data),
  /** @param {Id} id */
  remove: (id) => client.delete(`/integrations/leads/routes/${id}`),
};

export const accessApi = {
  /** @param {Id} staffId */
  getPermissions: (staffId) => client.get(`/staff/${staffId}/permissions`),
  /**
   * @param {Id} staffId
   * @param {Payload} overrides
   */
  setPermissions: (staffId, overrides) => client.put(`/staff/${staffId}/permissions`, { overrides }),
  /**
   * @param {Id} staffId
   * @param {boolean} enabled
   */
  setTwoFactor: (staffId, enabled) => client.patch(`/staff/${staffId}/two-factor`, { enabled }),
};

export const systemApi = {
  getConfig: () => client.get('/system/config'),
  /** @param {Payload} data */
  saveConfig: (data) => client.put('/system/config', data),
  /** @param {string} to */
  testEmail: (to) => client.post('/system/test-email', { to }),
  /** @param {string} url */
  checkPublicUrl: (url) => client.post('/system/check-public-url', url ? { url } : {}),
};
