const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

// Standardized error contract across the whole app: { error: { code, message } }.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
      details: err.details || undefined,
    });
  }

  // Errors raised by body-parser itself - a body over the limit (413) or malformed JSON (400) - are the CALLER's
  // mistake, not a server fault. They used to fall through to the 500 below, which both misreported them and wrote a
  // stack trace to the log for every oversized or garbled request.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' } });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The request body could not be read.' } });
  }

  // SQLite constraint violations (e.g. duplicate SKU, duplicate phone)
  if (err.code && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'Conflict: record violates a uniqueness or reference constraint.' },
    });
  }

  // "no such table" / "no such column" / "has no column named" — the code
  // expects a table/column that isn't in this database yet. This is what a
  // schema update looks like when `npm run migrate` hasn't been re-run
  // against an existing data/*.db after pulling newer code — surfacing it
  // clearly here saves a confusing round of "why is this a 500?" debugging.
  if (err.code === 'SQLITE_ERROR' && /no such (table|column)|has no column named/i.test(err.message || '')) {
    logger.error('Schema mismatch — did you run `npm run migrate` after updating the code?', { error: err.message, path: req.originalUrl });
    return res.status(500).json({
      error: {
        code: 'SCHEMA_OUT_OF_DATE',
        message: `Database schema is out of date (${err.message}). Run "npm run migrate" in the backend folder, then restart the server.`,
      },
    });
  }

  logger.error('Unhandled error', { error: err.message, stack: err.stack, method: req.method, path: req.originalUrl, userId: req.user?.id });
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
}

module.exports = errorHandler;
