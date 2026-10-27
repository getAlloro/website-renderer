import { getDb } from '../lib/db';
import type { Section } from '../types';
import { generationArtifactHash } from '../utils/generation-style';

export class ProjectPostBlockModel {
  /** projectId comes from the resolved public hostname. No tenant ID is accepted from a shortcode. */
  static async findPinned(projectId: string, id: string): Promise<{ slug: string; sections: Section[] | string; post_type_slug: string } | null> {
    const pin = /^project:([a-z0-9][a-z0-9-]{0,159}):([1-9][0-9]*)$/.exec(id);
    if (!pin || !Number.isSafeInteger(Number(pin[2]))) throw new Error('PROJECT_BLOCK_REVISION_INVALID');
    const row = await getDb()('project_post_blocks as block')
      .join('projects as project', function () { this.on('project.id', 'block.project_id').andOn('project.organization_id', 'block.organization_id'); })
      .join('post_types as type', function () { this.on('type.id', 'block.post_type_id').andOn('type.template_id', 'project.template_id'); })
      .where({ 'block.project_id': projectId, 'block.slug': pin[1], 'block.version': Number(pin[2]) })
      .whereNull('project.archived_at')
      .select('block.slug', 'block.sections', 'block.content_hash', 'type.slug as post_type_slug').first();
    if (!row) return null;
    const sections: unknown = typeof row.sections === 'string' ? JSON.parse(row.sections) : row.sections;
    if (!Array.isArray(sections) || generationArtifactHash(sections) !== row.content_hash) throw new Error('PROJECT_BLOCK_REVISION_CORRUPTED');
    return { ...row, sections, slug: id };
  }
}
