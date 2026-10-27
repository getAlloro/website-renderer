import type { Request, Response } from 'express';
import { GenerationRenderModel } from '../models/GenerationRenderModel';
import { assembleHtml, assembleSinglePostHtml, assembleResolvedHtml, assembleResolvedSinglePostHtml } from './site';
import { getSinglePostData } from '../services/singlepost.service';
import { GenerationCandidateError, resolvePrivateGenerationCandidate, resolveGenerationCandidatePage, resolveGenerationCandidatePostLayout } from '../services/generation-render.service';
import { bindWorktreePreviewNavigation } from '../utils/worktree-preview-navigation';

/** Disposable worktree-only review; deployed/public routing never exposes drafts. */
export async function worktreeGenerationPreviewRoute(req: Request, res: Response): Promise<void> {
  if (process.env.ALLORO_WORKTREE_TEST_MODE !== 'true'
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
    res.status(404).end(); return;
  }
  const { projectId, runId } = req.params;
  const path = typeof req.query.path === 'string' ? req.query.path : '/';
  const candidateId = req.query.candidateId;
  if (typeof projectId !== 'string' || typeof runId !== 'string' || !/^[a-f0-9-]{36}$/i.test(projectId) || !/^[a-f0-9-]{36}$/i.test(runId)
    || !path.startsWith('/') || path.startsWith('//') || path.length > 500 || /[?#\\]/.test(path)
    || (req.query.path !== undefined && typeof req.query.path !== 'string')
    || (candidateId !== undefined && (typeof candidateId !== 'string' || !/^[a-f0-9-]{36}$/i.test(candidateId)))) {
    res.status(400).end(); return;
  }
  let original: string;
  const host = req.get('host') || 'localhost';
  if (typeof candidateId === 'string') {
    try {
      const candidate = await resolvePrivateGenerationCandidate(projectId, runId, candidateId);
      const page = await resolveGenerationCandidatePage(candidate, path);
      if (page) original = await assembleResolvedHtml(candidate.project, page, host);
      else {
        const parts = path.split('/').filter(Boolean);
        const single = candidate.project.template_id && parts.length === 2
          ? await getSinglePostData(projectId, candidate.project.template_id, parts[0], parts[1]) : null;
        if (!single) { res.status(404).end(); return; }
        const sections = resolveGenerationCandidatePostLayout(candidate, single.postType.id);
        original = await assembleResolvedSinglePostHtml(candidate.project, single.postType, single.post, host, sections);
      }
    } catch (error) {
      if (!(error instanceof GenerationCandidateError)) throw error;
      res.status(error.status).type('text').send(error.message); return;
    }
  } else {
    const selected = await GenerationRenderModel.findPrivatePage(projectId, runId, path);
    if (selected) original = await assembleHtml(selected.project, selected.page, host);
    else {
      const project = await GenerationRenderModel.findPrivateRun(projectId, runId);
      const parts = path.split('/').filter(Boolean);
      const single = project?.template_id && parts.length === 2 ? await getSinglePostData(project.id, project.template_id, parts[0], parts[1]) : null;
      if (!project || !single) { res.status(404).end(); return; }
      original = await assembleSinglePostHtml(project, single.postType, single.post, host, runId);
    }
  }
  const html = bindWorktreePreviewNavigation(original, { projectId, runId, candidateId: typeof candidateId === 'string' ? candidateId : undefined, path });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(html);
}
