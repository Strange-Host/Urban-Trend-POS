const db = require('../config/db');
const { dateOf } = require('../utils/storeTime');

// RULE 8: commission is earned only on SECURE money. Ported from the update branch's payroll/commission.ts.
//
// An order counts for commission only when its whole total is secure and it is dispatched and fully paid
// (not cancelled, returned or part paid). Money is secure when:
//   - a payment other than shop cash was recorded against the order (M-Pesa/paybill matched to its code,
//     card, bank transfer): secure on receipt;
//   - shop cash has been DEPOSITED or handed to the till (cash in someone's pocket, i.e. open custody, is not secure);
//   - a courier organization has REMITTED: the part of its collection that a statement settled (cash received
//     plus the fees netted). Merely collecting the money does not count.
// Refunded or failed payments never count.
// The day an order becomes fully secure (and dispatched) is the day it counts: the LATER of its dispatch and its
// last piece of secure money, so a parcel is commissioned in the pay period in which its money was actually
// safe, not when it was ordered or dispatched. All amounts are integer cents; timestamps are UTC, periods are
// shop calendar dates.

/**
 * Orders whose money is fully secure.
 * @param {object} f
 * @param {number} f.storeId
 * @param {string} [f.from]   shop date (inclusive): only orders that became secure on or after it
 * @param {string} [f.to]     shop date (inclusive): only orders that became secure on or before it
 * @param {number} [f.staffId]
 * @param {boolean} [f.excludeCommissioned=true] leave out orders already commissioned in a locked run
 * @returns {{orderId:number, orderRef:string, staffId:number, total:number, units:number, securedAt:string, securedDate:string}[]}
 */
function securedOrders({ storeId, from = null, to = null, staffId = null, excludeCommissioned = true }) {
  const rows = db.prepare(`
    WITH paid AS (   -- non-cash money recorded against the order: secure on receipt
      SELECT p.order_id, SUM(p.amount) AS cents, MAX(p.created_at) AS at
        FROM payment_records p
       WHERE p.direction = 'incoming' AND p.status = 'completed' AND p.deleted_at IS NULL AND p.method <> 'cash' AND p.order_id IS NOT NULL
       GROUP BY p.order_id
    ), cash AS (     -- shop cash: secure only once its custody record is deposited
      SELECT p.order_id, SUM(p.amount) AS cents, MAX(c.deposited_at) AS at
        FROM payment_records p JOIN custody_records c ON c.payment_record_id = p.id
       WHERE p.direction = 'incoming' AND p.status = 'completed' AND p.deleted_at IS NULL AND p.method = 'cash'
         AND c.status = 'deposited'
       GROUP BY p.order_id
    ), org AS (      -- organization money: only the part a statement settled
      SELECT k.order_id, SUM(l.secured) AS cents, MAX(s.created_at) AS at
        FROM org_statement_lines l
        JOIN org_collections k ON k.id = l.collection_id
        JOIN org_statements s ON s.id = l.statement_id
       GROUP BY k.order_id
    ), units AS (
      SELECT order_id, SUM(quantity) AS n FROM order_items GROUP BY order_id
    ), secured AS (
      SELECT o.id AS order_id, o.product_code, o.assigned_staff_id AS staff_id, o.total, COALESCE(u.n, 0) AS units,
             MAX(o.dispatched_at, COALESCE(paid.at, ''), COALESCE(cash.at, ''), COALESCE(org.at, '')) AS secured_at
        FROM orders o
        LEFT JOIN paid ON paid.order_id = o.id
        LEFT JOIN cash ON cash.order_id = o.id
        LEFT JOIN org  ON org.order_id  = o.id
        LEFT JOIN units u ON u.order_id = o.id
       WHERE o.store_id = @storeId
         AND o.deleted_at IS NULL
         AND o.assigned_staff_id IS NOT NULL
         AND o.status = 'dispatched_paid'
         AND o.dispatched_at IS NOT NULL
         AND o.total > 0
         AND COALESCE(paid.cents, 0) + COALESCE(cash.cents, 0) + COALESCE(org.cents, 0) = o.total
         AND (@staffId IS NULL OR o.assigned_staff_id = @staffId)
         AND (@excludeCommissioned = 0 OR NOT EXISTS (SELECT 1 FROM commissioned_orders co WHERE co.order_id = o.id))
    )
    SELECT order_id, product_code, staff_id, total, units, secured_at, ${dateOf('secured_at')} AS secured_date
      FROM secured
     WHERE (@from IS NULL OR ${dateOf('secured_at')} >= @from)
       AND (@to IS NULL OR ${dateOf('secured_at')} <= @to)
     ORDER BY secured_at, order_id
  `).all({ storeId, from, to, staffId, excludeCommissioned: excludeCommissioned ? 1 : 0 });

  return rows.map((r) => ({
    orderId: r.order_id, orderRef: r.product_code || `#${r.order_id}`, staffId: r.staff_id,
    total: r.total, units: r.units, securedAt: r.secured_at, securedDate: r.secured_date,
  }));
}

module.exports = { securedOrders };
