const DEFAULT_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

class ApiError extends Error {
  // Backward compatible with every existing call site: new ApiError(status, message).
  // `code` is optional — omit it and a sensible default is derived from statusCode.
  constructor(statusCode, message, details = null, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.code = code || DEFAULT_CODES[statusCode] || 'ERROR';
  }
}

module.exports = ApiError;
