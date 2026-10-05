import { Request, Response, NextFunction } from 'express';

// Conservative first step for every hosted site. HSTS starts with a short lifetime and
// no includeSubDomains/preload, because these are client domains and a long-lived HSTS
// policy cannot be withdrawn from browsers that cached it. The CSP covers only framing,
// plugins and the base URI: pages depend on inline scripts and many third-party origins
// (fonts, maps, analytics, video), so a script-source policy needs per-request nonces first.
const HSTS_MAX_AGE_SECONDS = 300;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': `max-age=${HSTS_MAX_AGE_SECONDS}`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
};

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  next();
}
