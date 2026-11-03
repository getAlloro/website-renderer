import { getDb } from '../lib/db';
import type { Page, Project } from '../types';

export interface GenerationCandidateArtifact {
  id: string; project_id: string; organization_id: number; run_id: string;
  kind: string; artifact_key: string; schema_version: number;
  content_hash: string; payload: unknown; object_key: string | null;
}

export class GenerationRenderModel {
  static async readinessDependencies(projectId: string, organizationId: number): Promise<unknown> {
    const project = await getDb()('projects').where({ id: projectId, organization_id: organizationId }).whereNull('archived_at').first('id');
    if (!project) throw new Error('GENERATION_READINESS_SCOPE_MISSING');
    const posts = await getDb()('posts').where({ project_id: projectId, status: 'published' }).orderBy('id');
    const blocks = await getDb()('project_post_blocks').where({ project_id: projectId, organization_id: organizationId }).orderBy('id');
    return JSON.parse(JSON.stringify({ posts, blocks }));
  }
  static async findCandidateArtifact(projectId: string, organizationId: number, runId: string, artifactId: string): Promise<GenerationCandidateArtifact | undefined> {
    return getDb()('generation_artifacts as artifact')
      .join('generation_runs as run', function () {
        this.on('run.id', 'artifact.run_id').andOn('run.project_id', 'artifact.project_id').andOn('run.organization_id', 'artifact.organization_id');
      })
      .where({ 'artifact.id': artifactId, 'artifact.project_id': projectId,
        'artifact.organization_id': organizationId, 'artifact.run_id': runId })
      .select('artifact.id', 'artifact.project_id', 'artifact.organization_id', 'artifact.run_id', 'artifact.kind',
        'artifact.artifact_key', 'artifact.schema_version', 'artifact.content_hash', 'artifact.payload', 'artifact.object_key').first();
  }
  static async publishedRunIds(projectId: string): Promise<string[]> {
    const rows = await getDb()('pages').where({ project_id: projectId, status: 'published' })
      .whereNotNull('generation_run_id').distinct('generation_run_id') as Array<{ generation_run_id: string }>;
    return rows.map(row => row.generation_run_id);
  }

  /** The run that drew the published home page: the site's chrome when a generated project has no wrapper of its own. */
  static async homePageRunId(projectId: string): Promise<string | null> {
    const row = await getDb()('pages').where({ project_id: projectId, status: 'published', path: '/' })
      .whereNotNull('generation_run_id').first('generation_run_id') as { generation_run_id: string } | undefined;
    return row?.generation_run_id ?? null;
  }

  static async findPrivateRun(projectId: string, runId: string): Promise<Project | null> {
    const project = await getDb()('projects').where({ id: projectId }).whereNull('archived_at').first<Project>();
    if (!project?.organization_id) return null;
    const run = await getDb()('generation_runs').where({ id: runId, project_id: projectId, organization_id: project.organization_id }).first('id');
    return run ? project : null;
  }

  static async findPrivatePage(projectId: string, runId: string, path: string): Promise<{ project: Project; page: Page } | null> {
    const project = await this.findPrivateRun(projectId, runId);
    if (!project) return null;
    const pages = await getDb()('pages').where({ project_id: projectId, generation_run_id: runId, path })
      .whereIn('status', ['draft', 'published']).orderBy('version', 'desc').limit(1) as Page[];
    return pages.length ? { project, page: pages[0] } : null;
  }
  /** The run's operator-pinned site script, if any (Alloro `site-generator save-script`). At most one row is valid. */
  static async findPinnedScript(projectId: string, organizationId: number, runId: string): Promise<Array<{ payload: unknown; content_hash: string }>> {
    return getDb()('generation_artifacts as artifact')
      .join('generation_runs as run', function () {
        this.on('run.id', 'artifact.run_id').andOn('run.project_id', 'artifact.project_id').andOn('run.organization_id', 'artifact.organization_id');
      })
      .where({ 'artifact.project_id': projectId, 'artifact.organization_id': organizationId,
        'artifact.run_id': runId, 'artifact.kind': 'publication_snapshot', 'artifact.artifact_key': 'site-script' })
      .select('artifact.payload', 'artifact.content_hash').limit(2);
  }
  /** No fallback to another run or project's mutable chrome. At most one revision can match. */
  static async findPinned(projectId: string, organizationId: number, runId: string): Promise<Array<{ payload: unknown; content_hash: string }>> {
    return getDb()('generation_artifacts as artifact')
      .join('generation_runs as run', function () {
        this.on('run.id', 'artifact.run_id').andOn('run.project_id', 'artifact.project_id').andOn('run.organization_id', 'artifact.organization_id');
      })
      .where({ 'artifact.project_id': projectId, 'artifact.organization_id': organizationId,
        'artifact.run_id': runId, 'artifact.kind': 'publication_snapshot', 'artifact.artifact_key': 'site-render' })
      .select('artifact.payload', 'artifact.content_hash').limit(2);
  }
}
