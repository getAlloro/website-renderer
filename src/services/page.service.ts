import { getDb } from '../lib/db';
import type { Page } from '../types';

export async function getPublishedPage(
  projectId: string,
  path: string
): Promise<Page | null> {
  const page = await getDb()('pages')
    .where({
      project_id: projectId,
      path,
      status: 'published',
    })
    .first();

  return page || null;
}

export async function getPageToRender(
  projectId: string,
  path: string
): Promise<Page | null> {
  // Public hosts are not draft previews. A published sibling never authorizes
  // rendering a different path's draft.
  return getPublishedPage(projectId, path);
}

export async function hasPublishedPages(projectId: string): Promise<boolean> {
  const row = await getDb()('pages')
    .where({ project_id: projectId, status: 'published' })
    .select(getDb().raw('1'))
    .first();

  return !!row;
}

/**
 * True when the request path is an artifact app's own path or lies inside it, with or
 * without a trailing slash. The trailing-slash redirect uses this to leave artifact
 * apps alone.
 */
export async function isArtifactPath(projectId: string, requestPath: string): Promise<boolean> {
  const rows: Array<{ path: string }> = await getDb()('pages')
    .where({ project_id: projectId, page_type: 'artifact', status: 'published' })
    .select('path');
  const bare = requestPath.replace(/\/+$/, '');
  return rows.some((row) => {
    const base = row.path.replace(/\/+$/, '');
    return bare === base || requestPath.startsWith(base + '/');
  });
}

/**
 * Find an artifact page whose path is a prefix of the requested URL.
 * Used for serving sub-assets (e.g., /calculator/assets/index-abc.js → artifact at /calculator).
 * Returns the artifact page and the relative sub-path within the artifact bundle.
 */
export async function getArtifactPageByPrefix(
  projectId: string,
  requestPath: string
): Promise<{ page: Page; subPath: string } | null> {
  // Query artifact pages for this project, ordered by path length desc (longest prefix wins)
  const artifactPages = await getDb()('pages')
    .where({
      project_id: projectId,
      page_type: 'artifact',
      status: 'published',
    })
    .orderByRaw('LENGTH(path) DESC');

  for (const page of artifactPages) {
    const prefix = page.path.endsWith('/') ? page.path : page.path + '/';
    if (requestPath.startsWith(prefix)) {
      const subPath = requestPath.slice(prefix.length);
      if (subPath.length > 0) {
        return { page, subPath };
      }
    }
  }

  return null;
}
