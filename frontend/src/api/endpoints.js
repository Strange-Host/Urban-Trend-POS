import client from './client';

export const authApi = {
  login: (email, password, remember = false) => client.post('/auth/login', { email, password, remember }),
  verifyOtp: (challengeToken, code, remember = false) => client.post('/auth/verify-otp', { challengeToken, code, remember }),
  unlock: (secret) => client.post('/auth/unlock', secret),          // { password } or { pin }
  activity: () => client.post('/auth/activity', {}),
  sessions: () => client.get('/auth/sessions'),
  endSession: (id) => client.delete(`/auth/sessions/${id}`),
  endOtherSessions: () => client.post('/auth/sessions/revoke-others', {}),
  resendOtp: (challengeToken) => client.post('/auth/resend-otp', { challengeToken }),
  refresh: () => client.post('/auth/refresh'),
  logout: () => client.post('/auth/logout'),
  me: () => client.get('/auth/me'),
  changePassword: (currentPassword, newPassword) => client.post('/auth/change-password', { currentPassword, newPassword }),
};

export const productsApi = {
  list: (params) => client.get('/products', { params }),
  getByBarcode: (code) => client.get(`/products/barcode/${code}`),
  create: (data) => client.post('/products', data),
  update: (id, data) => client.put(`/products/${id}`, data),
  remove: (id) => client.delete(`/products/${id}`),
  listPending: () => client.get('/products/pending/list'),
  approve: (id, data) => client.post(`/products/${id}/approve`, data || {}),
  reject: (id, note) => client.post(`/products/${id}/reject`, { note }),
};

export const categoriesApi = {
  list: (params) => client.get('/categories', { params }),
  create: (data) => client.post('/categories', data),
  update: (id, data) => client.put(`/categories/${id}`, data),
  usage: (id) => client.get(`/categories/${id}/usage`),
  remove: (id, moveTo) => client.delete(`/categories/${id}`, { params: moveTo ? { move_to: moveTo } : undefined }),
  archive: (id) => client.post(`/categories/${id}/archive`, {}),
  restore: (id) => client.post(`/categories/${id}/restore`, {}),
};

export const inventoryApi = {
  list: () => client.get('/inventory'),
  lowStock: () => client.get('/inventory/low-stock'),
  adjust: (data) => client.post('/inventory/adjust', data),
};

export const salesApi = {
  checkout: (data) => client.post('/sales', data),
  list: (params) => client.get('/sales', { params }),
  getById: (id) => client.get(`/sales/${id}`),
  void: (id) => client.post(`/sales/${id}/void`),
};

export const modulesApi = {
  get: () => client.get('/modules'),
  update: (data) => client.put('/modules', data),
};

export const settingsApi = {
  get: () => client.get('/settings'),
  update: (data) => client.put('/settings', data),
};

export const backupsApi = {
  list: () => client.get('/backups'),
  run: () => client.post('/backups/run'),
  emailNow: () => client.post('/backups/email-now'),
};

export const paymentGatewaysApi = {
  list: () => client.get('/settings/payment-gateways'),
  get: (provider) => client.get(`/settings/payment-gateways/${provider}`),
  upsert: (provider, data) => client.put(`/settings/payment-gateways/${provider}`, data),
  deactivate: (provider) => client.delete(`/settings/payment-gateways/${provider}`),
  test: (provider) => client.post(`/settings/payment-gateways/${provider}/test`),
  registerMpesaUrls: () => client.post('/settings/payment-gateways/mpesa/register-urls'),
  simulateMpesaPayment: (data) => client.post('/settings/payment-gateways/mpesa/simulate', data),
};

export const smsApi = {
  status: () => client.get('/sms/status'),
  getCredentials: () => client.get('/sms/credentials'),
  saveCredentials: (data) => client.put('/sms/credentials', data),
  removeCredentials: () => client.delete('/sms/credentials'),
  sendTest: (to) => client.post('/sms/test', { to }),
  outbox: (params) => client.get('/sms/outbox', { params }),
  retry: (id) => client.post(`/sms/outbox/${id}/retry`),
};

export const notificationsApi = {
  list: (params) => client.get('/notifications', { params }),
  unreadCount: () => client.get('/notifications/unread-count'),
  markRead: (id) => client.post(`/notifications/${id}/read`),
  markAllRead: () => client.post('/notifications/read-all'),
};

export const incomeSourcesApi = {
  list: () => client.get('/income-sources'),
  getById: (id) => client.get(`/income-sources/${id}`),
  create: (data) => client.post('/income-sources', data),
  update: (id, data) => client.patch(`/income-sources/${id}`, data),
  remove: (id) => client.delete(`/income-sources/${id}`),
  connect: (id) => client.post(`/income-sources/${id}/connect`),
  test: (id) => client.post(`/income-sources/${id}/test`),
  syncProducts: (id) => client.post(`/income-sources/${id}/sync-products`),
  // opts: {} = since the last sync | { days: 365 } = backfill N days | { all: true } = everything the platform allows
  syncSales: (id, opts = {}) => client.post(`/income-sources/${id}/sync-sales`, opts),
  liveSyncStatus: (id) => client.get(`/income-sources/${id}/live-sync`),
  liveSyncEnable: (id) => client.post(`/income-sources/${id}/live-sync/enable`),
  liveSyncDisable: (id) => client.post(`/income-sources/${id}/live-sync/disable`),
};

export const shopifyApi = {
  connections: () => client.get('/integrations/shopify/connections'),
  // incomeSourceId omitted = every connected store
  sync: (incomeSourceId) => client.post('/integrations/shopify/sync', incomeSourceId ? { income_source_id: incomeSourceId } : {}),
  listStaging: (status = 'pending') => client.get('/integrations/shopify/staging', { params: { status } }),
  updateStaging: (id, data) => client.patch(`/integrations/shopify/staging/${id}`, data),
  approve: (id) => client.post(`/integrations/shopify/staging/${id}/approve`),
  reject: (id) => client.post(`/integrations/shopify/staging/${id}/reject`),
  approveAll: () => client.post('/integrations/shopify/staging/approve-all'),
};

export const reportsApi = {
  salesSummary: (params) => client.get('/reports/sales-summary', { params }),
  topProducts: (params) => client.get('/reports/top-products', { params }),
  inventoryValue: () => client.get('/reports/inventory-value'),
  salesByChannel: (params) => client.get('/reports/sales-by-channel', { params }),
  salesTrend: (params) => client.get('/reports/sales-trend', { params }),
  paymentMethods: (params) => client.get('/reports/payment-methods', { params }),
  topProductsByChannel: (params) => client.get('/reports/top-products-by-channel', { params }),
};

export const leadsApi = {
  list: (params) => client.get('/leads', { params }),
  stats: () => client.get('/leads/stats'),
  getById: (id) => client.get(`/leads/${id}`),
  create: (data) => client.post('/leads', data),
  update: (id, data) => client.patch(`/leads/${id}`, data),
  changeStatus: (id, status, followUpDate) => client.patch(`/leads/${id}/status`, { status, follow_up_date: followUpDate }),
  convert: (id, data) => client.post(`/leads/${id}/convert`, data),
  addActivity: (id, data) => client.post(`/leads/${id}/activities`, data),
  remove: (id) => client.delete(`/leads/${id}`),
};

export const requisitionsApi = {
  list: (params) => client.get('/requisitions', { params }),
  getById: (id) => client.get(`/requisitions/${id}`),
  create: (data) => client.post('/requisitions', data),
  approve: (id, items) => client.patch(`/requisitions/${id}/approve`, { items }),
  reject: (id, rejection_reason) => client.patch(`/requisitions/${id}/reject`, { rejection_reason }),
};

export const expensesApi = {
  list: (params) => client.get('/expenses', { params }),
  summary: (params) => client.get('/expenses/summary', { params }),
  getById: (id) => client.get(`/expenses/${id}`),
  create: (data) => client.post('/expenses', data),
  update: (id, data) => client.patch(`/expenses/${id}`, data),
  remove: (id) => client.delete(`/expenses/${id}`),
  listCategories: () => client.get('/expenses/categories'),
  createCategory: (name) => client.post('/expenses/categories', { name }),
  approve: (id) => client.post(`/expenses/${id}/approve`),
  reject: (id, note) => client.post(`/expenses/${id}/reject`, { note }),
};

export const pettyCashApi = {
  overview: () => client.get('/petty-cash'),
  createTopup: (data) => client.post('/petty-cash/topups', data),
  approveTopup: (id) => client.post(`/petty-cash/topups/${id}/approve`),
  rejectTopup: (id, note) => client.post(`/petty-cash/topups/${id}/reject`, { note }),
};

export const paymentsApi = {
  list: (params) => client.get('/payments', { params }),
  summary: (params) => client.get('/payments/summary', { params }),
  create: (data) => client.post('/payments', data),
  refund: (id) => client.post(`/payments/${id}/refund`),
};

export const cashSessionsApi = {
  current: () => client.get('/cash-sessions/current'),
  open: (openingAmount) => client.post('/cash-sessions/open', { openingAmount }),
  close: (id, closingAmount, handoverNotes) => client.post(`/cash-sessions/${id}/close`, { closingAmount, ...(handoverNotes ? { handover_notes: handoverNotes } : {}) }),
  list: (params) => client.get('/cash-sessions', { params }),
  getById: (id) => client.get(`/cash-sessions/${id}`),
};

export const staffApi = {
  list: (params) => client.get('/staff', { params }),
  getById: (id) => client.get(`/staff/${id}`),
  create: (data) => client.post('/staff', data),
  update: (id, data) => client.patch(`/staff/${id}`, data),
  remove: (id) => client.delete(`/staff/${id}`),
  resetPassword: (id) => client.post(`/staff/${id}/reset-password`),
  removalCheck: (id) => client.get(`/staff/${id}/removal-check`),
  reactivate: (id) => client.post(`/staff/${id}/reactivate`, {}),
  permanentDelete: (id, confirmName) => client.post(`/staff/${id}/permanent-delete`, { confirmName }),
  erasePersonalData: (id, confirmName) => client.post(`/staff/${id}/erase-personal-data`, { confirmName }),
  signOutEverywhere: (id) => client.post(`/staff/${id}/sign-out-everywhere`, {}),
  sessions: (id) => client.get(`/staff/${id}/sessions`),
  unlockAccount: (id) => client.post(`/staff/${id}/unlock-account`, {}),
};

export const securityApi = {
  policy: () => client.get('/security/policy'),
  updatePolicy: (data) => client.put('/security/policy', data),
  events: (params) => client.get('/security/events', { params }),
};

export const staffLogsApi = {  list: (params) => client.get('/staff-logs', { params }),
  stats: (params) => client.get('/staff-logs/stats', { params }),
};

// --- Phase 5 modules: shipped backends that previously had no UI ---

export const ordersApi = {
  list: (params) => client.get('/orders', { params }),
  atRisk: (params) => client.get('/orders/at-risk', { params }),
  get: (id) => client.get(`/orders/${id}`),
  create: (data) => client.post('/orders', data),
  mergeItems: (id, items) => client.post(`/orders/${id}/merge-items`, { items }),
  confirmCod: (id) => client.post(`/orders/${id}/confirm-cod`),
  setCourier: (id, courierType) => client.post(`/orders/${id}/courier`, { courier_type: courierType }),
  assignCourier: (id, courierId) => client.post(`/orders/${id}/courier`, { courier_id: courierId }),
  onlineSources: () => client.get('/orders/online-sources'),
  pullOnline: (incomeSourceId, days) => client.post('/orders/pull-online', { income_source_id: incomeSourceId, ...(days ? { days } : {}) }),
  dispatch: (id) => client.post(`/orders/${id}/dispatch`),
  recordPayment: (id, data) => client.post(`/orders/${id}/payments`, data),
  returnedInTransit: (id, data) => client.post(`/orders/${id}/returned-in-transit`, data),
  returnedAwaitingInspection: (id) => client.post(`/orders/${id}/returned-awaiting-inspection`),
  inspect: (id, data) => client.post(`/orders/${id}/inspect`, data),
  ownerDecision: (id, data) => client.post(`/orders/${id}/owner-decision`, data),
  pendingOwnerDecision: (params) => client.get('/orders/pending-owner-decision', { params }),
  openDispute: (id, reason) => client.post(`/orders/${id}/dispute`, { reason }),
  resolveDispute: (id, data) => client.post(`/orders/${id}/dispute/resolve`, data),
  cancel: (id, notes) => client.post(`/orders/${id}/cancel`, { notes }),
};

export const paymentReconciliationApi = {
  unmatched: (params) => client.get('/payment-reconciliation/unmatched', { params }),
  match: (id, orderId) => client.post(`/payment-reconciliation/${id}/match`, { order_id: orderId }),
  ignore: (id, notes) => client.post(`/payment-reconciliation/${id}/ignore`, { notes }),
};

export const attendanceApi = {
  clockIn: () => client.post('/attendance/clock-in'),
  clockOut: (handoverNotes) => client.post('/attendance/clock-out', handoverNotes ? { handover_notes: handoverNotes } : {}),
  today: (date) => client.get('/attendance/today', { params: date ? { date } : {} }),
  absencesToday: () => client.get('/attendance/absences-today'),
};

export const payrollApi = {
  summary: (staffId, from, to) => client.get('/payroll/summary', { params: { staff_id: staffId, from, to } }),
  lossDeduction: (data) => client.post('/payroll/loss-deduction', data),
  // Locked payroll runs: draft -> approved (locked) -> paid. Approve and pay are admin-only on the server.
  runs: () => client.get('/payroll/runs'),
  run: (id) => client.get(`/payroll/runs/${id}`),
  verifyRun: (id) => client.get(`/payroll/runs/${id}/verify`),
  generateRun: (from, to) => client.post('/payroll/runs', { from, to }),
  approveRun: (id) => client.post(`/payroll/runs/${id}/approve`),
  payRun: (id, method, paymentRef) => client.post(`/payroll/runs/${id}/pay`, { method, payment_ref: paymentRef || undefined }),
};

export const employeesApi = {
  onboard: (data) => client.post('/employees/onboard', data),
  onboardingStatus: (id) => client.get(`/employees/${id}/onboarding-status`),
  uploadDocument: (id, data) => client.post(`/employees/${id}/documents`, data),
  signAgreement: (id, signedName) => client.post(`/employees/${id}/sign-agreement`, { signed_name: signedName }),
};

export const telesalesApi = {
  rebalance: () => client.post('/telesales/rebalance'),
};

export const couriersApi = {
  list: (params) => client.get('/couriers', { params }),
  create: (data) => client.post('/couriers', data),
  update: (id, data) => client.patch(`/couriers/${id}`, data),
  remove: (id) => client.delete(`/couriers/${id}`),
};

export const shiftApi = {
  handover: () => client.get('/shift/handover'),
};

export const receiptsApi = {
  order: (id) => client.get(`/orders/${id}/receipt`),
  sale: (id) => client.get(`/sales/${id}/receipt`),
};

export const leadRoutesApi = {
  secret: () => client.get('/integrations/leads/secret'),
  list: () => client.get('/integrations/leads/routes'),
  create: (data) => client.post('/integrations/leads/routes', data),
  update: (id, data) => client.patch(`/integrations/leads/routes/${id}`, data),
  remove: (id) => client.delete(`/integrations/leads/routes/${id}`),
};

export const accessApi = {
  getPermissions: (staffId) => client.get(`/staff/${staffId}/permissions`),
  setPermissions: (staffId, overrides) => client.put(`/staff/${staffId}/permissions`, { overrides }),
  setTwoFactor: (staffId, enabled) => client.patch(`/staff/${staffId}/two-factor`, { enabled }),
};

export const systemApi = {
  getConfig: () => client.get('/system/config'),
  saveConfig: (data) => client.put('/system/config', data),
  testEmail: (to) => client.post('/system/test-email', { to }),
  checkPublicUrl: (url) => client.post('/system/check-public-url', url ? { url } : {}),
};
