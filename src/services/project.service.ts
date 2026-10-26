import { getDb } from '../lib/db';
import type { Project } from '../types';

export async function getProjectById(id: string): Promise<Project | null> {
  const project = await getDb()('projects').where({ id }).first();
  return project || null;
}

// Archived projects must never resolve for public rendering — an archived
// row kept serving a full duplicate site for weeks (garrison-orthodontics-3307)
// because these lookups only matched on hostname/domain. Callers that need to
// know a host WAS a site (to serve 410 Gone instead of 404 Not Found) use the
// dedicated archived lookups below.

export async function getProjectByHostname(hostname: string): Promise<Project | null> {
  const project = await getDb()('projects')
    .where({ generated_hostname: hostname })
    .whereNull('archived_at')
    .first();
  return project || null;
}

export async function getProjectByCustomDomain(domain: string): Promise<Project | null> {
  const project = await getDb()('projects')
    .where(function () {
      this.where('custom_domain', domain).orWhere('custom_domain_alt', domain);
    })
    .whereNotNull('domain_verified_at')
    .whereNull('archived_at')
    .first();
  return project || null;
}

// Domain switch fallbacks. A live site moving to a new domain keeps serving on
// its verified custom_domain while the new one is PENDING (the host is served
// as soon as DNS reaches us), and after promotion the old domain is kept in
// project_domain_redirects so it can 301 to the new host. Both lookups run only
// after getProjectByCustomDomain misses, so they can never change how a
// verified domain resolves.
//
// The columns and table come from an Alloro-side migration. If the renderer is
// deployed before that migration has run, the queries fail with undefined
// table (42P01) or undefined column (42703); that is treated as "no match" so a
// deploy-order slip degrades to today's behavior instead of a 500 on every
// unknown host. Logged once per process, not per request.
const MISSING_SCHEMA_CODES = new Set(['42P01', '42703']);
let missingSchemaWarned = false;

function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && MISSING_SCHEMA_CODES.has(code);
}

async function withMissingSchemaAsNoMatch<T>(lookup: string, run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    if (!missingSchemaWarned) {
      missingSchemaWarned = true;
      console.warn(
        `[project] ${lookup}: domain-switch schema not present yet (${(err as { code: string }).code}); treating as no match`
      );
    }
    return null;
  }
}

/**
 * A live project whose PENDING domain (or its alt) is this host. Only projects
 * that still hold a verified current domain qualify — a pending switch exists
 * only on a site that is already live.
 */
export async function getProjectByPendingDomain(domain: string): Promise<Project | null> {
  return withMissingSchemaAsNoMatch('getProjectByPendingDomain', async () => {
    const project = await getDb()('projects')
      .where(function () {
        this.where('pending_custom_domain', domain).orWhere('pending_custom_domain_alt', domain);
      })
      .whereNotNull('custom_domain')
      .whereNotNull('domain_verified_at')
      .whereNull('archived_at')
      .first();
    return project || null;
  });
}

/**
 * The live project an OLD domain now redirects to, if any. The caller derives
 * the destination host from the returned project (primaryPublicHost), so the
 * redirect always follows the project's current domain. A redirect row whose
 * project is archived or no longer has a verified domain is not honored.
 */
export async function getDomainRedirectTarget(domain: string): Promise<Project | null> {
  return withMissingSchemaAsNoMatch('getDomainRedirectTarget', async () => {
    const redirect = await getDb()('project_domain_redirects')
      .where({ from_domain: domain })
      .select('project_id')
      .first();
    if (!redirect) return null;

    const project = await getDb()('projects')
      .where({ id: redirect.project_id })
      .whereNotNull('custom_domain')
      .whereNotNull('domain_verified_at')
      .whereNull('archived_at')
      .first();
    return project || null;
  });
}

/**
 * Existence-only check for the Caddy on-demand TLS ask: true when this domain
 * is some project's pending domain (or alt) or a redirect from_domain. Mirrors
 * the existing custom_domain check in verify-domain.ts, which also ignores
 * verification and archive state.
 */
export async function isPendingOrRedirectDomain(domain: string): Promise<boolean> {
  const found = await withMissingSchemaAsNoMatch('isPendingOrRedirectDomain', async () => {
    const pending = await getDb()('projects')
      .where(function () {
        this.where('pending_custom_domain', domain).orWhere('pending_custom_domain_alt', domain);
      })
      .select('id')
      .first();
    if (pending) return true;

    const redirect = await getDb()('project_domain_redirects')
      .where({ from_domain: domain })
      .select('id')
      .first();
    return redirect ? true : null;
  });
  return found === true;
}

/** An archived project matching this generated hostname, if any (for 410 Gone). */
export async function getArchivedProjectByHostname(hostname: string): Promise<Project | null> {
  const project = await getDb()('projects')
    .where({ generated_hostname: hostname })
    .whereNotNull('archived_at')
    .first();
  return project || null;
}

/** An archived project matching this custom domain, if any (for 410 Gone). */
export async function getArchivedProjectByCustomDomain(domain: string): Promise<Project | null> {
  const project = await getDb()('projects')
    .where(function () {
      this.where('custom_domain', domain).orWhere('custom_domain_alt', domain);
    })
    .whereNotNull('archived_at')
    .first();
  return project || null;
}
