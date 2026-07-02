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
