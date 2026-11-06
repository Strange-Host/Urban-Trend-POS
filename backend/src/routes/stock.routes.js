const router = require('express').Router();
const receiving = require('../controllers/stockReceiving.controller');
const drafts = require('../controllers/stockReceiptDrafts.controller');
const transfers = require('../controllers/stockTransfers.controller');
const counts = require('../controllers/stockCounts.controller');
const batches = require('../controllers/stockBatches.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// Receiving and issuing (main store)
// Buying price per received batch. 'awaiting-cost' is declared before '/receipts/:id' so it is not read as an id.
router.get('/receipts/awaiting-cost', requirePermission('products.view_cost'), batches.listAwaitingCost);
router.put('/receipts/:id/costs', requirePermission('products.view_cost'), batches.setCosts);
// Draft receipts: a delivery saved half-entered. Declared before '/receipts/:id' so "drafts" is not read as an id.
router.get('/receipts/drafts', requirePermission('stock.receive'), drafts.list);
router.post('/receipts/drafts', requirePermission('stock.receive'), drafts.create);
router.get('/receipts/drafts/:id', requirePermission('stock.receive'), drafts.getOne);
router.put('/receipts/drafts/:id', requirePermission('stock.receive'), drafts.update);
router.delete('/receipts/drafts/:id', requirePermission('stock.receive'), drafts.remove);
router.post('/receipts/drafts/:id/submit', requirePermission('stock.receive'), drafts.submit);
router.get('/receipts', requirePermission('stock.receive'), receiving.listReceipts);
router.get('/receipts/:id', requirePermission('stock.receive'), receiving.getReceipt);
router.post('/receipts', requirePermission('stock.receive'), receiving.createReceipt);
router.get('/issues', requirePermission('stock.receive'), receiving.listIssues);
router.post('/issues', requirePermission('stock.receive'), receiving.createIssue);

// Batches: expiry, recall, and the stock alerts (low, expiring, expired, recalled, damaged)
router.get('/batches', requirePermission('stock.receive'), batches.listBatches);
router.post('/batches/:id/recall', requirePermission('stock.review'), batches.recallBatch);
router.get('/alerts', requirePermission('stock.receive'), batches.getAlerts);
router.get('/damaged', requirePermission('stock.receive'), batches.listDamaged);

// Inter-branch transfers
router.get('/transfers', requirePermission('stock.transfer'), transfers.list);
router.get('/transfers/:id', requirePermission('stock.transfer'), transfers.getOne);
router.post('/transfers', requirePermission('stock.transfer'), transfers.create);
router.post('/transfers/:id/approve', requirePermission('stock.review'), transfers.approve);
router.post('/transfers/:id/reject', requirePermission('stock.review'), transfers.reject);
router.post('/transfers/:id/cancel', requirePermission('stock.transfer'), transfers.cancel);

// Outlet opening / closing counts. 'day-summary' is declared before '/:id' so it is not read as an id.
router.get('/counts/day-summary', requirePermission('stock.count'), counts.daySummary);
router.get('/counts', requirePermission('stock.count'), counts.list);
router.post('/counts', requirePermission('stock.count'), counts.submit);
router.get('/counts/:id', requirePermission('stock.count'), counts.getOne);
router.post('/counts/:id/approve', requirePermission('stock.review'), counts.approve);
router.post('/counts/:id/reject', requirePermission('stock.review'), counts.reject);

// Who did what with stock
router.get('/activity', requirePermission('stock.review'), counts.activity);

module.exports = router;
