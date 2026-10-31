const router = require('express').Router();
const receiving = require('../controllers/stockReceiving.controller');
const transfers = require('../controllers/stockTransfers.controller');
const counts = require('../controllers/stockCounts.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// Receiving and issuing (main store)
router.get('/receipts', requirePermission('stock.receive'), receiving.listReceipts);
router.get('/receipts/:id', requirePermission('stock.receive'), receiving.getReceipt);
router.post('/receipts', requirePermission('stock.receive'), receiving.createReceipt);
router.get('/issues', requirePermission('stock.receive'), receiving.listIssues);
router.post('/issues', requirePermission('stock.receive'), receiving.createIssue);

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
