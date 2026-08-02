/** Shared shapes for the smrtStudio screens. Mirrors the payloads returned by
 *  server/src/modules/smrtstudio/routes.ts — keep the two in step. */

export type Bilingual = { he: string; en: string };

/* ── Operator console — GET /api/studio/overview ─────────────────────────── */

export type StudioStatus = "done" | "now" | "todo";

/** One task row. For a research stage `group_key` is the phase it belongs to
 *  (`Research` / `Tests` / `Decisions`); for a build stage it is the tool the
 *  row builds, and `group_order` / `group_note` describe that tool's group. */
export type StudioItem = {
  id: string;
  group_key: string;
  group_order: number;
  group_note: string;
  title: string;
  status: StudioStatus;
  desc: string;
  link_url: string;
  link_label: string;
};

export type StudioChallenge = {
  id: string;
  kind: "expected" | "hit";
  problem: string;
  solved: boolean;
  solution: string | null;
  /** Raw detail text regardless of `solved` — the editor edits this; the
   *  read-only view keeps using `solution` (which is null when unsolved). */
  detail: string;
};

export type StudioOutput = {
  id: string;
  kind: "image" | "video" | "audio" | "text" | "tool";
  label: string;
  meta: string;
  link_url: string;
};

/** The stage's charter — a plain description plus a three-step readiness meter
 *  (general draft → detail → verify) and a deep link into smrtPlan. */
export type StudioPlan = {
  desc: string;
  general: StudioStatus;
  detail: StudioStatus;
  verify: StudioStatus;
  smrtplan_url: string;
};

export type StudioStage = {
  slug: string;
  name: string;
  blurb: string;
  hue: number;
  kind: "research" | "build";
  plan: StudioPlan;
  items: StudioItem[];
  challenges: StudioChallenge[];
  outputs: StudioOutput[];
  done: number;
  total: number;
  pct: number;
};

export type StudioOverview = { stages: StudioStage[]; models_total: number };

/* ── Research centre — GET /api/studio/research ──────────────────────────── */

export type ResearchItem = {
  id: string;
  stage_slug: string;
  position: number;
  title_he: string;
  title_en: string;
  decides_he: string;
  decides_en: string;
  sources: string;
  repo: string;
  verified_at: string | null;
  status: "draft" | "locked" | "applied" | "living" | "superseded";
};

export type ResearchResponse = {
  items: ResearchItem[];
  counts: Record<string, number>;
  total: number;
};

/* ── Models catalog ──────────────────────────────────────────────────────── */

export type StudioModel = {
  id: string;
  endpoint_id: string;
  title: string;
  category: string;
  kind: string;
  vendor: string;
  hosting_type: string;
  license_type: string;
  deprecated: boolean;
  price_note: string;
  price_usd: number | null;
  price_unit: string;
  verified_schema: boolean;
  verified_at: string | null;
  shortlist_rank: number | null;
  recipe_path: string;
  flags: string[];
  source_url: string;
  /** null = no audio input at all. Otherwise the ROLE our audio plays:
   *  driving = drives lips/motion (what the series needs) · reference = guides
   *  generation, sync unproven · mux = pasted onto the output, lips do NOT sync. */
  audio_input: "driving" | "reference" | "mux" | null;
  audio_field: string | null;
  /** fal's own wording for that field — the evidence behind the role. */
  audio_note: string | null;
  audio_probed: boolean;
  /** Which tier of evidence decided `audio_input`. `field_description` = fal's
   *  own wording for that field said so. `model_purpose` = the field was
   *  described as nothing more than "URL of the input audio", and the class came
   *  from what the endpoint exists to do. Shown, so a reader can tell the two
   *  apart instead of assuming fal spelled it out. */
  audio_classified_from: "field_description" | "model_purpose" | null;
  /** The second axis, and only for a driving model: what it BUILDS. Two models
   *  can both be driven by our audio and still be different tools — one composes
   *  a whole shot, the other repaints the mouth of a clip you already have. */
  audio_build: "full_scene" | "full_body" | "avatar" | "mouth_fix" | null;
  fal_category: string;
  /** One of the seven navigation groups. Coarser than `kind`, which stays a
   *  pipeline-stage bucket. */
  group_key: string;
  family: string;
  summary: string;
  about: string;
  published_at: string | null;
  /** true when fal prices this endpoint by tier and gives no single figure. The
   *  screen shows the prose instead of a number that would be wrong. */
  price_ambiguous: boolean;
  /** What one 8s/720p shot costs — the only way a per-megapixel price and a
   *  per-second price can be compared. Video endpoints only. */
  shot_estimate_usd: number | null;
  shot_estimate_basis: string;
  cap_prompt: boolean;
  cap_negative_prompt: boolean;
  cap_start_image: boolean;
  cap_end_image: boolean;
  cap_video_input: boolean;
  cap_lora: boolean;
  cap_seed: boolean;
  cap_audio_channels: number;
  input_field_count: number;
  schema_available: boolean;
  is_pipeline_tool: boolean;
  research_notes: Record<string, unknown>[];
  stage_slug: string | null;
  stage_order: number;
  indexed_at: string | null;
};

export type ModelsResponse = {
  items: StudioModel[];
  matched: number;
  returned: number;
  limit: number;
  counts: Record<string, number>;
  /** Tab sizes — unfiltered, because a tab must show the size of the tab and
   *  not of the slice you are already inside. */
  group_counts: Record<string, number>;
  /** Everything below the tabs is faceted: counted with every OTHER filter
   *  applied, so a chip reading 0 truly means "clicking this returns nothing". */
  category_counts: Record<string, number>;
  build_counts: Record<string, number>;
  cap_counts: Record<string, number>;
  /** Exact catalog size for the org. */
  total: number;
  verified_total: number;
  audio_counts: Record<string, number>;
  audio_probed_total: number;
  audio_video_total: number;
  pipeline_tool_total: number;
};

/** Pick the caller's language off a bilingual pair. Every studio row carries
 *  both, so no screen ever has to fall back to the wrong language. */
export function pick(locale: string, he: string, en: string): string {
  return locale === "he" ? he : en;
}
