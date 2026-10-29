// Delegable permissions. The older Urban Trends system gave every staff
// member a hand-picked permission set; this system uses three fixed roles. This
// catalogue is the middle path: each key below defaults to EXACTLY the roles
// that were hardcoded in the routes before (so installing this changes nothing
// for anyone), and an admin can then grant or revoke an individual key for one
// person — e.g. let a trusted cashier view reports, or stop one manager voiding sales.
//
// Deliberately NOT here (stay admin-only role checks): settings, backups,
// payment-gateway and SMS credentials, staff create/edit/delete, onboarding,
// income sources, telesales rebalancing, the audit log, owner write-off
// decisions. A permission you can delegate is a permission you can lose
// control of; these are the ones where that costs money or access.
//
// The admin role always passes every check and cannot be restricted — that is
// what guarantees you can never lock yourself out with a bad override.
const PERMISSIONS = {
  'reports.view':          { group: 'Reports',   label: 'View reports and dashboard figures',        roles: ['admin', 'manager'] },
  'payroll.view':          { group: 'Team',      label: 'View payroll and commission',                roles: ['admin', 'manager'] },
  'staff.view':            { group: 'Team',      label: 'View the staff list',                        roles: ['admin', 'manager'] },
  'attendance.view':       { group: 'Team',      label: 'View today\'s attendance and absences',      roles: ['admin', 'manager'] },
  'expenses.manage':       { group: 'Money',     label: 'Record and edit expenses',                   roles: ['admin', 'manager'] },
  'payments.manage':       { group: 'Money',     label: 'Record and refund payments',                 roles: ['admin', 'manager'] },
  'payments.reconcile':    { group: 'Money',     label: 'Match unmatched payments to orders',         roles: ['admin', 'manager'] },
  'requisitions.approve':  { group: 'Money',     label: 'Approve or reject requisitions',             roles: ['admin', 'manager'] },
  'atrisk.view':           { group: 'Money',     label: 'View the money-at-risk page',                roles: ['admin', 'manager'] },
  'cashsessions.view':     { group: 'Money',     label: 'View other staff\'s cash sessions',          roles: ['admin', 'manager'] },
  'sales.void':            { group: 'Sales',     label: 'Void a completed sale',                      roles: ['admin', 'manager'] },
  'orders.pull_online':    { group: 'Orders',    label: 'Pull to-ship orders from Shopify / WooCommerce', roles: ['admin', 'manager'] },
  'orders.inspect':        { group: 'Orders',    label: 'Inspect returned parcels',                   roles: ['admin', 'manager'] },
  'orders.resolve_dispute':{ group: 'Orders',    label: 'Resolve payment disputes',                   roles: ['admin', 'manager'] },
  'products.manage':       { group: 'Stock',     label: 'Create, edit and delete products and categories', roles: ['admin', 'manager'] },
  'inventory.adjust':      { group: 'Stock',     label: 'Adjust stock and view the stock check',      roles: ['admin', 'manager'] },
  'shopify.sync':          { group: 'Stock',     label: 'Use Shopify / WooCommerce sync',             roles: ['admin', 'manager'] },
  'sms.view':              { group: 'Messaging', label: 'View SMS delivery and retry failed messages', roles: ['admin', 'manager'] },
  'couriers.manage':       { group: 'Orders',    label: 'Add and edit couriers',                      roles: ['admin', 'manager'] },
  'couriers.settle':       { group: 'Money',     label: 'Record courier-organization collections and settle their statements', roles: ['admin', 'manager'] },
  'couriers.costs.record': { group: 'Orders',    label: 'Enter courier costs (fuel, return trip, airtime)', roles: ['admin', 'manager', 'cashier'] },
  'couriers.costs.approve':{ group: 'Money',     label: 'Approve or reject courier costs',            roles: ['admin', 'manager'] },
  'couriers.pay':          { group: 'Money',     label: 'View courier payables and pay couriers',     roles: ['admin', 'manager'] },
  'custody.manage':        { group: 'Money',     label: 'See shop cash held by staff and mark it deposited', roles: ['admin', 'manager'] },
  'leads.intake_routes':   { group: 'Sales',     label: 'Manage web-form lead routing',               roles: ['admin', 'manager'] },
};

const ROLES = ['admin', 'manager', 'cashier'];

function defaultAllows(role, key) {
  const p = PERMISSIONS[key];
  return Boolean(p && p.roles.includes(role));
}

module.exports = { PERMISSIONS, ROLES, defaultAllows };
