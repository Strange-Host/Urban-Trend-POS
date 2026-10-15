const asyncHandler = require('../utils/asyncHandler');
const notificationsService = require('../services/notifications.service');
const { parsePagination, paginatedResponse } = require('../utils/paginate');

// GET /api/notifications?unread=1&page=&limit= — the caller's own, always.
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total } = notificationsService.listForUser({
    userId: req.user.id, unreadOnly: req.query.unread === '1' || req.query.unread === 'true', limit, offset,
  });
  res.json({ ...paginatedResponse({ rows, total, page, limit }), unreadCount: notificationsService.unreadCount(req.user.id) });
});

// GET /api/notifications/unread-count — polled by the bell
const unreadCount = asyncHandler(async (req, res) => {
  res.json({ data: { unreadCount: notificationsService.unreadCount(req.user.id) } });
});

// POST /api/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  res.json({ data: notificationsService.markAllRead(req.user.id) });
});

// POST /api/notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  res.json({ data: notificationsService.markRead({ userId: req.user.id, id: Number(req.params.id) }) });
});

module.exports = { list, unreadCount, markAllRead, markRead };
