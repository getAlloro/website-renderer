import { generationArtifactHash } from './generation-style';

export const GENERATION_READY_HEADER = 'X-Alloro-Generation-Revision';
/** Mirrors the app readiness wire contract, without changing delivered HTML. */
export function generationReadinessMarker(input: { projectId: string; organizationId: number; runId: string;
  pageId: string; path: string; sections: unknown; renderHash: string; dependencies: unknown }): string {
  return generationArtifactHash(JSON.parse(JSON.stringify({ version: 1, ...input })));
}
