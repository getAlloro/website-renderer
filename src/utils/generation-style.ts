import { createHash } from 'node:crypto';

/** Mirrored by Alloro's custom-generation/styleContract.ts; pinned bytes are never recompiled. */
export function inspectGenerationStyle(html: string): { present: boolean; valid: boolean; cssHash: string | null } {
  const contract = html.match(/<html\b[^>]*\bdata-generation-contract\s*=\s*["']([^"']*)["']/i)?.[1];
  const markers = [...html.matchAll(/<style\b([^>]*\bdata-alloro-generation-style\s*=\s*["']([^"']+)["'][^>]*)>([\s\S]*?)<\/style>/gi)];
  if (contract === undefined && !markers.length) return { present: false, valid: true, cssHash: null };
  if (contract !== '1' || markers.length !== 1 || markers[0][2] !== '1') return { present: true, valid: false, cssHash: null };
  const recorded = markers[0][1].match(/\bdata-content-hash\s*=\s*["']([a-f0-9]{64})["']/i)?.[1];
  const hash = createHash('sha256').update(markers[0][3]).digest('hex');
  return { present: true, valid: recorded === hash, cssHash: hash };
}

export function generationArtifactHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
