// Project status enum (simplified — 3 states)
export type ProjectStatus = 'CREATED' | 'IN_PROGRESS' | 'LIVE';

// Page content lifecycle status
export type PageStatus = 'draft' | 'published' | 'inactive';

// Page generation pipeline status
export type PageGenerationStatus = 'queued' | 'generating' | 'ready' | 'failed' | null;

// Section structure (JSONB array items)
export interface Section {
  name: string;
  content: string;
}

// SEO data stored on pages and posts
export interface SeoData {
  location_context?: string | null; // location_id or "organization"
  meta_title?: string | null;
  meta_description?: string | null;
  canonical_url?: string | null;
  robots?: string | null;
  og_title?: string | null;
  og_description?: string | null;
  og_image?: string | null;
  og_type?: string | null;
  max_image_preview?: string | null;
  schema_json?: Record<string, unknown>[] | null;
}

// Project model
export interface Project {
  id: string;
  user_id: string;
  organization_id: number | null;
  generated_hostname: string;
  custom_domain: string | null;
  custom_domain_alt: string | null;
  status: ProjectStatus;
  selected_place_id: string | null;
  selected_place_ids: string[] | string | null;
  primary_place_id: string | null;
  selected_website_url: string | null;
  wrapper: string;
  header: string;
  footer: string;
  step_gbp_scrape: Record<string, unknown> | null;
  step_website_scrape: Record<string, unknown> | null;
  step_image_analysis: Array<{ s3Url: string; description: string }> | null;
  primary_color: string | null;
  template_id: string | null;
  archived_at: Date | string | null;
  created_at: Date;
  updated_at: Date;
}

// Page type discriminator
export type PageType = 'sections' | 'artifact';

// Page model
export interface Page {
  id: string;
  project_id: string;
  path: string;
  version: number;
  status: PageStatus;
  generation_status: PageGenerationStatus;
  template_page_id: string | null;
  page_type: PageType;
  artifact_s3_prefix: string | null;
  sections: Section[];
  seo_data: SeoData | null;
  created_at: Date;
  updated_at: Date;
}
