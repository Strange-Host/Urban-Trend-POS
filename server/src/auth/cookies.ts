import type { Request, Response } from 'express';

// The refresh token lives in an httpOnly, SameSite=Strict cookie scoped to /api/auth: script on the page can never read it
// and the browser sends it nowhere else. The access token is never a cookie.
export const REFRESH_COOKIE = 'ut_refresh_token';
const PATH = '/api/auth';

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.header('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; } }
  }
  return undefined;
}

/** Remembered sessions get a cookie that outlives the browser (until the session's own maximum); others die with the browser. */
export type SameSite = 'strict' | 'lax' | 'none';
const sameSiteWord = (v: SameSite) => ({ strict: 'Strict', lax: 'Lax', none: 'None' })[v];

// Strict is right when the screens and the API share a site (app.example.com and api.example.com, or localhost on two ports).
// If they sit on unrelated domains the browser would never send a Strict cookie on the API calls, and every page reload would sign
// the person out; only then use 'none' (which browsers accept only on HTTPS, so it always carries Secure).
export function setRefreshCookie(res: Response, token: string, opts: { secure: boolean; remember: boolean; expiresAt: Date; sameSite?: SameSite }): void {
  const sameSite = opts.sameSite ?? 'strict';
  const bits = [`${REFRESH_COOKIE}=${encodeURIComponent(token)}`, `Path=${PATH}`, 'HttpOnly', `SameSite=${sameSiteWord(sameSite)}`];
  if (opts.secure || sameSite === 'none') bits.push('Secure');
  if (opts.remember) bits.push(`Max-Age=${Math.max(0, Math.floor((opts.expiresAt.getTime() - Date.now()) / 1000))}`);
  res.append('Set-Cookie', bits.join('; '));
}

export function clearRefreshCookie(res: Response, secure: boolean, sameSite: SameSite = 'strict'): void {
  res.append('Set-Cookie', [`${REFRESH_COOKIE}=`, `Path=${PATH}`, 'HttpOnly', `SameSite=${sameSiteWord(sameSite)}`, ...(secure || sameSite === 'none' ? ['Secure'] : []), 'Max-Age=0'].join('; '));
}
