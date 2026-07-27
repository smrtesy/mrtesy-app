/** Shared shapes for the smrtStudio screens. Mirrors the payloads returned by
 *  server/src/modules/smrtstudio/routes.ts — keep the two in step. */

export type Bilingual = { he: string; en: string };

export type Gate = {
  id: string;
  stage_slug: string;
  position: number;
  label_he: string;
  label_en: string;
  done: boolean;
};

export type Challenge = {
  id: string;
  stage_slug: string;
  position: number;
  kind: "expected" | "hit";
  title_he: string;
  title_en: string;
  solved: boolean;
  detail_he: string;
  detail_en: string;
};

export type Stage = {
  id: string;
  slug: string;
  position: number;
  name_he: string;
  name_en: string;
  blurb_he: string;
  blurb_en: string;
  hue: number;
  activity: "idle" | "research" | "running" | "scoring" | "blocked";
  decision_state: "none" | "testing" | "decided" | "locked";
  note_he: string;
  note_en: string;
  gates: Gate[];
  gates_done: number;
  gates_total: number;
  progress_pct: number;
  challenges_expected: Challenge[];
  challenges_hit: Challenge[];
  outputs: number;
  scored: number;
  cost_usd: number;
  runs_missing_cost: number;
  models_run: string[];
};

export type OverviewTotals = {
  runs: number;
  runs_missing_cost: number;
  voice_missing_cost: number;
  recorded_cost_usd: number;
  scores: number;
  voice_takes: number;
  voice_approved: number;
  voice_cost_partial: boolean;
  stages_locked: number;
  stages_total: number;
};

export type Overview = { stages: Stage[]; totals: OverviewTotals };

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
  fal_category: string;
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
  /** Exact catalog size for the org. `tallied` is how many rows the count
   *  breakdown below was computed from — smaller than `total` only if the page
   *  was capped, which is why both are reported rather than one. */
  total: number;
  tallied: number;
  verified_total: number;
  audio_counts: Record<string, number>;
  audio_probed_total: number;
};

export type InvestmentRow = {
  id: string;
  position: number;
  label_he: string;
  label_en: string;
  hours: number | null;
  value_usd: number;
  detail_he: string;
  detail_en: string;
  kind: "work" | "direct" | "ask" | "ask_total";
};

export type InvestmentResponse = {
  items: InvestmentRow[];
  total_hours: number;
  total_work_usd: number;
  total_direct_usd: number;
};

/** Pick the caller's language off a bilingual pair. Every studio row carries
 *  both, so no screen ever has to fall back to the wrong language. */
export function pick(locale: string, he: string, en: string): string {
  return locale === "he" ? he : en;
}
