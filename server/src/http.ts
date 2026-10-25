import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { HttpError } from './errors.js';

/** Express 4 does not catch a rejected promise in a handler; this forwards it to the error handler. */
export const handler = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Validates a request body or params. A bad request is a 422 that names the fields, never a 500. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new HttpError(422, 'VALIDATION', 'Some fields are missing or not valid.',
    r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
}

export const idParam = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(422, 'VALIDATION', 'That id is not valid.');
  return n;
};

/** ?limit= (default 50, at most 100) and ?offset=. Every list endpoint pages the same way, so none can return an unbounded result. */
export function paging(query: Record<string, unknown>): { limit: number; offset: number } {
  const num = (v: unknown, dflt: number) => { if (v === undefined || v === '') return dflt; const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(422, 'VALIDATION', 'limit and offset must be whole numbers, zero or more.'); return n; };
  return { limit: Math.min(Math.max(num(query.limit, 50), 1), 100), offset: num(query.offset, 0) };
}

export const flag = (v: unknown): boolean | undefined => (v === undefined || v === '' ? undefined : v === 'true' || v === '1');

/** The logged-in person, in the shape the services expect. The role is never read from the request. */
export const who = (req: Request) => ({ actor: req.user!.username, role: req.user!.role });
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
