import type { Page, Project, Section } from '../types';
import { GenerationRenderModel, type GenerationCandidateArtifact } from '../models/GenerationRenderModel';
import { createHash } from 'node:crypto';
import { generationArtifactHash, inspectGenerationStyle } from '../utils/generation-style';
import { generationReadinessMarker } from '../utils/generation-readiness';

interface RenderArtifact {
  runId: string; wrapper: string; header: string; footer: string; styleHash: string; planHash: string;
  singlePostLayouts?: Array<{ postTypeId: string; sections: Array<{ name: string; content: string }> }>;
}

interface CandidatePageReference { pageKey: string; path: string; title: string; artifactId: string; contentHash: string }
export interface PrivateGenerationCandidate {
  id: string; project: Project; runId: string; attempt: number; planHash: string;
  render: RenderArtifact; pageRefs: CandidatePageReference[];
}
export class GenerationCandidateError extends Error {
  constructor(public readonly status: 404 | 409, message = 'This saved generated draft is unavailable or no longer matches its revision.') { super(message); }
}
const HASH = /^[a-f0-9]{64}$/;
const CANDIDATE_PATH = /^\/(?!\/)[^?#\\]*$/;
// Mirror the saved candidate contract, not the mutable/native page schema.
const MAX_CANDIDATE_PAGES = 80;
const MAX_CANDIDATE_SECTIONS = 24;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, maximum = 160): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum; }
function sections(value: unknown): value is Section[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_CANDIDATE_SECTIONS
    && value.every(section => text(record(section).name) && text(record(section).content, Number.MAX_SAFE_INTEGER));
}
function artifactPayload(row: GenerationCandidateArtifact, project: Project, runId: string): Record<string, unknown> {
  let value: unknown;
  try { value = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch { throw new GenerationCandidateError(409); }
  if (row.project_id !== project.id || Number(row.organization_id) !== Number(project.organization_id) || row.run_id !== runId
    || row.object_key !== null || row.schema_version !== 1 || generationArtifactHash(value) !== row.content_hash) throw new GenerationCandidateError(409);
  return record(value);
}
function candidateRender(value: unknown, runId: string, planHash: string): RenderArtifact {
  const render = record(value);
  if (render.runId !== runId || render.planHash !== planHash || typeof render.wrapper !== 'string' || !render.wrapper.includes('{{slot}}')
    || typeof render.header !== 'string' || typeof render.footer !== 'string' || typeof render.styleHash !== 'string' || !HASH.test(render.styleHash)) throw new GenerationCandidateError(409);
  const style = inspectGenerationStyle(render.wrapper);
  if (!style.present || !style.valid || style.cssHash !== render.styleHash) throw new GenerationCandidateError(409);
  if (render.singlePostLayouts !== undefined && (!Array.isArray(render.singlePostLayouts)
    || render.singlePostLayouts.some(item => !text(record(item).postTypeId) || !sections(record(item).sections))
    || new Set(render.singlePostLayouts.map(item => record(item).postTypeId)).size !== render.singlePostLayouts.length)) throw new GenerationCandidateError(409);
  return render as unknown as RenderArtifact;
}

/** Only called by the gated worktree route. A candidate is never a canonical published render. */
export async function resolvePrivateGenerationCandidate(projectId: string, runId: string, candidateId: string): Promise<PrivateGenerationCandidate> {
  const project = await GenerationRenderModel.findPrivateRun(projectId, runId);
  if (!project?.organization_id) throw new GenerationCandidateError(404);
  const row = await GenerationRenderModel.findCandidateArtifact(projectId, project.organization_id, runId, candidateId);
  if (!row) throw new GenerationCandidateError(404);
  const value = artifactPayload(row, project, runId);
  if (row.id !== candidateId || row.kind !== 'publication_snapshot' || value.schemaVersion !== 1
    || value.projectId !== projectId || value.organizationId !== Number(project.organization_id) || value.runId !== runId
    || !Number.isInteger(value.attempt) || Number(value.attempt) < 0 || Number(value.attempt) > 2
    || row.artifact_key !== `review-candidate:${value.attempt}` || typeof value.planHash !== 'string' || !HASH.test(value.planHash)
    || !Array.isArray(value.pageRefs) || !value.pageRefs.length || value.pageRefs.length > MAX_CANDIDATE_PAGES) throw new GenerationCandidateError(409);
  const refs = value.pageRefs;
  if (refs.some(item => { const ref = record(item); return !text(ref.pageKey) || !text(ref.path, 500) || !CANDIDATE_PATH.test(ref.path)
    || typeof ref.title !== 'string' || ref.title.length > 500 || !text(ref.artifactId) || typeof ref.contentHash !== 'string' || !HASH.test(ref.contentHash); })
    || new Set(refs.map(item => record(item).path)).size !== refs.length || new Set(refs.map(item => record(item).pageKey)).size !== refs.length) throw new GenerationCandidateError(409);
  const render = candidateRender(value.render, runId, value.planHash);
  return { id: candidateId, project: { ...project, wrapper: render.wrapper, header: render.header, footer: render.footer },
    runId, attempt: Number(value.attempt), planHash: value.planHash, render, pageRefs: refs as CandidatePageReference[] };
}

export async function resolveGenerationCandidatePage(candidate: PrivateGenerationCandidate, path: string): Promise<Pick<Page, 'id' | 'path' | 'sections' | 'status' | 'seo_data'> | null> {
  const ref = candidate.pageRefs.find(page => page.path === path);
  if (!ref) return null;
  const row = await GenerationRenderModel.findCandidateArtifact(candidate.project.id, candidate.project.organization_id!, candidate.runId, ref.artifactId);
  if (!row) throw new GenerationCandidateError(409);
  const value = artifactPayload(row, candidate.project, candidate.runId); const page = record(value.page); const seo = record(page.seo);
  if (row.id !== ref.artifactId || row.kind !== 'page' || row.artifact_key !== `review-candidate:${candidate.attempt}:page:${ref.pageKey}`
    || row.content_hash !== ref.contentHash || value.runId !== candidate.runId || value.planHash !== candidate.planHash
    || page.pageKey !== ref.pageKey || page.path !== ref.path || page.title !== ref.title || !sections(page.sections)
    || typeof seo.meta_title !== 'string' || typeof seo.meta_description !== 'string') throw new GenerationCandidateError(409);
  return { id: row.id, path: ref.path, sections: page.sections, status: 'draft', seo_data: { meta_title: seo.meta_title, meta_description: seo.meta_description } };
}

export function resolveGenerationCandidatePostLayout(candidate: PrivateGenerationCandidate, postTypeId: string): Section[] {
  const layout = candidate.render.singlePostLayouts?.find(item => item.postTypeId === postTypeId);
  if (!layout) throw new GenerationCandidateError(404, 'This post type has no layout in the selected generated draft.');
  return layout.sections;
}

async function pinnedArtifact(project: Project, runId: string): Promise<RenderArtifact> {
  if (!project.organization_id) throw new Error('GENERATION_RENDER_OWNER_MISSING');
  const rows = await GenerationRenderModel.findPinned(project.id, project.organization_id, runId);
  if (rows.length !== 1) throw new Error('GENERATION_RENDER_REVISION_MISSING_OR_AMBIGUOUS');
  const payload: unknown = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('GENERATION_RENDER_INVALID');
  const artifact = payload as Record<string, unknown>;
  if (artifact.runId !== runId || typeof artifact.wrapper !== 'string' || typeof artifact.header !== 'string'
    || typeof artifact.footer !== 'string' || typeof artifact.styleHash !== 'string' || typeof artifact.planHash !== 'string'
    || generationArtifactHash(artifact) !== rows[0].content_hash) throw new Error('GENERATION_RENDER_HASH_MISMATCH');
  const style = inspectGenerationStyle(artifact.wrapper);
  if (!style.present || !style.valid || style.cssHash !== artifact.styleHash) throw new Error('GENERATION_RENDER_STYLE_MISMATCH');
  if (artifact.singlePostLayouts !== undefined && (!Array.isArray(artifact.singlePostLayouts)
    || artifact.singlePostLayouts.some(item => !item || typeof item.postTypeId !== 'string' || !Array.isArray(item.sections)
      || !item.sections.length || item.sections.some((section: { name?: unknown; content?: unknown }) => typeof section.name !== 'string' || typeof section.content !== 'string')))) {
    throw new Error('GENERATION_SINGLE_POST_LAYOUT_INVALID');
  }
  return artifact as unknown as RenderArtifact;
}

/**
 * The run's operator-pinned site script as an inline tag, or an empty string. Alloro pins it with `site-generator save-script`
 * (never from the agent); the payload carries the script's own sha256, and the row's content hash covers the payload, so a
 * script that was altered in the table is refused rather than served. Two rows are ambiguous and refused too.
 */
async function pinnedScriptTag(project: Project, runId: string): Promise<string> {
  if (!project.organization_id) return '';
  const rows = await GenerationRenderModel.findPinnedScript(project.id, project.organization_id, runId);
  if (!rows.length) return '';
  if (rows.length !== 1) throw new Error('GENERATION_SCRIPT_AMBIGUOUS');
  const payload: unknown = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('GENERATION_SCRIPT_INVALID');
  const artifact = payload as Record<string, unknown>;
  if (artifact.runId !== runId || typeof artifact.script !== 'string' || typeof artifact.scriptHash !== 'string'
    || generationArtifactHash(artifact) !== rows[0].content_hash
    || createHash('sha256').update(artifact.script).digest('hex') !== artifact.scriptHash
    || /<\/script|<!--/i.test(artifact.script)) throw new Error('GENERATION_SCRIPT_HASH_MISMATCH');
  return `<script data-alloro-generation-script="1" data-content-hash="${artifact.scriptHash}">${artifact.script}</script>`;
}

export async function resolveGenerationRender(project: Project, page: Pick<Page, 'generation_run_id'>): Promise<Project> {
  if (!page.generation_run_id) return project;
  const artifact = await pinnedArtifact(project, page.generation_run_id);
  const script = await pinnedScriptTag(project, page.generation_run_id);
  return { ...project, wrapper: artifact.wrapper, header: artifact.header, footer: artifact.footer + script };
}

/** Only the exact published native page receives a readiness marker; candidates/legacy never do. */
export async function generationPublishedReadinessMarker(project: Project, page: Page): Promise<string | null> {
  if (!page.generation_run_id || page.status !== 'published') return null;
  if (!project.organization_id) throw new Error('GENERATION_READINESS_SCOPE_MISSING');
  const artifact = await pinnedArtifact(project, page.generation_run_id);
  const dependencies = await GenerationRenderModel.readinessDependencies(project.id, project.organization_id);
  return generationReadinessMarker({ projectId: project.id, organizationId: Number(project.organization_id),
    runId: page.generation_run_id, pageId: page.id, path: page.path, sections: page.sections,
    renderHash: generationArtifactHash(artifact), dependencies });
}

export async function generationPostReadinessMarker(project: Project, postTypeId: string, postId: string, path: string): Promise<string | null> {
  if (!project.organization_id) return null;
  const runs = await GenerationRenderModel.publishedRunIds(project.id);
  const matches = [];
  for (const runId of runs) {
    const render = await pinnedArtifact(project, runId); const layout = render.singlePostLayouts?.find(item => item.postTypeId === postTypeId);
    if (layout) matches.push({ runId, render, layout });
  }
  if (matches.length !== 1) return null; // No guessed run when multiple published layouts claim this route.
  const { runId, render, layout } = matches[0];
  return generationReadinessMarker({ projectId: project.id, organizationId: Number(project.organization_id), runId,
    pageId: `post:${postId}`, path, sections: layout.sections, renderHash: generationArtifactHash(render),
    dependencies: await GenerationRenderModel.readinessDependencies(project.id, project.organization_id) });
}

/** Detail URLs bind only to reviewed runs referenced by published pages, never the newest draft run. */
export async function resolveGenerationSinglePost(project: Project, postTypeId: string, privateRunId?: string): Promise<{
  project: Project; sections: Array<{ name: string; content: string }> | null;
}> {
  const runIds = privateRunId ? [privateRunId] : await GenerationRenderModel.publishedRunIds(project.id);
  const artifacts = await Promise.all(runIds.map(runId => pinnedArtifact(project, runId)));
  const candidates = artifacts.flatMap(artifact => (artifact.singlePostLayouts ?? []).filter(layout => layout.postTypeId === postTypeId)
    .map(layout => ({ project: { ...project, wrapper: artifact.wrapper, header: artifact.header, footer: artifact.footer }, sections: layout.sections })));
  if (!candidates.length) return { project, sections: null };
  const hashes = new Set(candidates.map(candidate => generationArtifactHash({ wrapper: candidate.project.wrapper,
    header: candidate.project.header, footer: candidate.project.footer, sections: candidate.sections })));
  if (hashes.size !== 1) throw new Error('GENERATION_SINGLE_POST_LAYOUT_AMBIGUOUS');
  return candidates[0];
}
