const { PAGINATION } = require('../config/limits');

// Shared pagination for the new modules (§0 Cross-Cutting Requirements):
// ?page= / ?limit=, default limit 25, max 100, never unbounded.
function parsePagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || PAGINATION.DEFAULT_PAGE_SIZE, 1), PAGINATION.MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function paginatedResponse({ rows, total, page, limit }) {
  return {
    data: rows,
    page,
    limit,
    total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  };
}

module.exports = { parsePagination, paginatedResponse };
