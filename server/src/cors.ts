import type { RequestHandler } from 'express';

// The staff screens may be served from a different origin than the API (a Vite dev server, or a separate Railway service).
// The refresh cookie only travels when the browser is told credentials are allowed, and that can never be done with a wildcard,
// so the allowed origins are listed explicitly (CORS_ORIGINS). An origin that is not listed gets no CORS headers at all.
export function cors(allowed: readonly string[]): RequestHandler {
  const ok = new Set(allowed);
  return (req, res, next) => {
    const origin = req.header('origin');
    if (!origin || !ok.has(origin)) return next();
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
      'Access-Control-Expose-Headers': 'Content-Disposition',
    });
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Background, Idempotency-Key',
        'Access-Control-Max-Age': '600',
      });
      res.status(204).end();
      return;
    }
    next();
  };
}
