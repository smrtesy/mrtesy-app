/**
 * smrtStudio — the VLM judge (stage E of docs/studio-build-plan.md).
 *
 * A frontier vision model scores one finished artifact against a BROKEN-DOWN
 * rubric — per-criterion score + reason, never a single opaque grade (the
 * video-lab qc-models.json rubric rule: one overall score from a VLM is the
 * CLIP-I mixing error in words). It is a FILTER, not an arbiter: a human can
 * always override the verdict from the run card.
 *
 * Guard rails, per the approved decision (2026-07-30):
 *   * behind an explicit flag — STUDIO_VLM_JUDGE=1 on the backend; off = 503,
 *     and the UI hides the button entirely;
 *   * paid, so the route requires cost approval (rule 2) — token-priced, so
 *     the estimate is an honest null, never a fake $0;
 *   * the REAL billed cost comes back in the response (`usage.cost`, a
 *     required field of the verified schema) and is recorded per check in
 *     experiment_runs.qc_cost_usd;
 *   * never runs on an already-rejected artifact — no paying to judge a
 *     known non-starter.
 *
 * Submit and poll are SPLIT on purpose: once queueSubmit succeeds the money
 * is committed on fal's side, so the caller must persist the request id
 * BEFORE polling — a timeout then leaves a reconcilable pending record
 * instead of a paid check that vanished from the books.
 *
 * Contract verified against fal's machine-readable OpenAPI (2026-07-30):
 *   openrouter/router/vision — required: prompt, image_urls, model;
 *   openrouter/router/video  — required: prompt, model (+ video_urls);
 *   output: { output: string, usage: { cost: number, ... } }.
 */

import { queueSubmit, queueResult } from "./runner";

export function vlmJudgeEnabled(): boolean {
  return process.env.STUDIO_VLM_JUDGE === "1";
}

export function vlmJudgeModel(): string {
  // The recommended-stack default (video-lab qc-models.json tier 1). The env
  // var lets the judge be swapped without a deploy-cycle code change.
  return process.env.STUDIO_VLM_JUDGE_MODEL || "anthropic/claude-sonnet-5";
}

/** Per-criterion rubric keys, by artifact kind. `identity` joins only when a
 *  reference image exists to compare against — a score against nothing is
 *  noise dressed as data. */
const IMAGE_CRITERIA = ["anatomy_hands", "anatomy_eyes", "prompt_match", "style_consistency", "artifacts"];
const VIDEO_CRITERIA = ["motion_naturalness", "temporal_consistency", "prompt_match", "artifacts"];

export type VlmJudgeSpec = {
  kind: "image" | "video";
  outputUrl: string;
  prompt: string | null;
  referenceUrl: string | null;
};

export type VlmJudgeHandle = {
  request_id: string;
  endpoint_id: string;
  model: string;
  criteria: string[];
};

export type VlmVerdict = {
  ok: true;
  criteria: Record<string, { score: number; reason: string }>;
  verdict: "pass" | "borderline" | "fail";
  summary: string;
  /** mean of the expected criterion scores, normalized 0..1 — qc_score */
  overall: number;
  cost: number | null;
  model: string;
  raw_output: string;
};

/** The judge answered (so the tokens were BILLED) but the answer was not a
 *  usable verdict. Split from a throw so the route can still record the
 *  real cost — money spent on a failed check must not vanish from the books. */
export type VlmJudgeFailure = {
  ok: false;
  error: string;
  cost: number | null;
  model: string;
  raw_output: string;
};

/** fal hasn't finished within the caller's deadline — the request stays
 *  alive (and billed) on fal's side; poll again later with the same handle. */
export type VlmInProgress = { ok: "in_progress" };

const SYSTEM_PROMPT = `You are a strict visual QC judge for AI-generated media (stylized 3D children's animation).
Score each rubric criterion independently from 0 (broken) to 10 (flawless) with a one-sentence reason.
You MUST score every criterion listed in the prompt — a skipped criterion invalidates the whole answer.
Write every reason and the summary in HEBREW.
Answer with STRICT JSON only, no markdown fences, exactly this shape:
{"criteria":{"<key>":{"score":<0-10>,"reason":"..."}},"verdict":"pass"|"borderline"|"fail","summary":"..."}
Rules: judge only what is visible; a missing/unclear aspect scores what you can see, never an invented fact.
"fail" only for defects a viewer would notice (broken hands, morphing face, heavy artifacts, wrong content).`;

function judgePrompt(kind: "image" | "video", criteria: string[], prompt: string | null, hasReference: boolean): string {
  const lines = [
    hasReference
      ? "The FIRST image is the character REFERENCE; the LAST is the generated output to judge."
      : `Judge the attached ${kind}.`,
    prompt ? `It was generated from this prompt: """${prompt.slice(0, 1500)}"""` : "",
    `Rubric criteria (score ALL of them): ${criteria.join(", ")}.`,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Pull the strict-JSON verdict out of the model text, tolerating stray
 * fences/prose around it. Throws when the verdict is unusable — including
 * when any EXPECTED criterion is missing: averaging only the criteria the
 * model happened to return would let one lucky "artifacts: 9" read as a 90%
 * pass. The caller records the failure instead of inventing a score.
 */
export function parseVerdict(
  text: string,
  expected: string[],
): Pick<VlmVerdict, "criteria" | "verdict" | "summary"> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("judge returned no JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    criteria?: Record<string, { score?: unknown; reason?: unknown }>;
    verdict?: unknown;
    summary?: unknown;
  };
  const criteria: VlmVerdict["criteria"] = {};
  for (const [key, val] of Object.entries(parsed.criteria ?? {})) {
    const score = Number(val?.score);
    if (!Number.isFinite(score)) continue;
    criteria[key] = {
      score: Math.min(10, Math.max(0, score)),
      reason: typeof val?.reason === "string" ? val.reason : "",
    };
  }
  const missing = expected.filter((k) => !(k in criteria));
  if (missing.length) throw new Error(`judge skipped criteria: ${missing.join(", ")}`);
  const verdict = parsed.verdict === "pass" || parsed.verdict === "borderline" || parsed.verdict === "fail"
    ? parsed.verdict
    : "borderline";
  return {
    criteria,
    verdict,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

/**
 * Phase 1 — submit the judge request to the fal queue (rule 1: queue only).
 * Throws only BEFORE money is committed; a returned handle means fal owns a
 * billed job, and the caller must persist it before doing anything else.
 */
export async function submitVlmJudge(spec: VlmJudgeSpec): Promise<VlmJudgeHandle> {
  const model = vlmJudgeModel();
  const isVideo = spec.kind === "video";
  // The /video variant takes video_urls only — no reference-image slot in its
  // verified schema, so identity joins the rubric only on the image judge.
  const withReference = !isVideo && Boolean(spec.referenceUrl);
  const criteria = [
    ...(withReference ? ["identity"] : []),
    ...(isVideo ? VIDEO_CRITERIA : IMAGE_CRITERIA),
  ];
  const endpointId = isVideo ? "openrouter/router/video" : "openrouter/router/vision";
  const input: Record<string, unknown> = {
    model,
    system_prompt: SYSTEM_PROMPT,
    prompt: judgePrompt(spec.kind, criteria, spec.prompt, withReference),
    temperature: 0,
    max_tokens: 1200,
  };
  if (isVideo) input.video_urls = [spec.outputUrl];
  else input.image_urls = withReference ? [spec.referenceUrl, spec.outputUrl] : [spec.outputUrl];

  const { request_id } = await queueSubmit(endpointId, input, null);
  return { request_id, endpoint_id: endpointId, model, criteria };
}

/**
 * Phase 2 — poll a submitted judge request to its verdict. Returns
 * in_progress at the deadline instead of throwing: the handle is still
 * valid and a later call picks the same request up without paying again.
 */
export async function pollVlmJudge(
  handle: VlmJudgeHandle,
  deadlineMs = 110_000,
): Promise<VlmVerdict | VlmJudgeFailure | VlmInProgress> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    let r;
    try {
      r = await queueResult(handle.endpoint_id, handle.request_id);
    } catch (e) {
      // Transient status-read failure — the request itself is still alive on
      // fal's side, so report in_progress rather than losing the handle.
      console.error("[studio-qc] judge status read failed:", e);
      r = { status: "in_progress" as const, result: null };
    }
    if (r.status === "failed") {
      return {
        ok: false,
        error: "fal reported the judge request FAILED",
        cost: null,
        model: handle.model,
        raw_output: "",
      };
    }
    if (r.status === "completed") {
      const result = r.result as { output?: unknown; usage?: { cost?: unknown } } | null;
      const text = typeof result?.output === "string" ? result.output : "";
      const rawCost = Number(result?.usage?.cost);
      const cost = Number.isFinite(rawCost) ? rawCost : null;
      let verdict: ReturnType<typeof parseVerdict>;
      try {
        verdict = parseVerdict(text, handle.criteria);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          cost,
          model: handle.model,
          raw_output: text.slice(0, 4000),
        };
      }
      const scores = handle.criteria.map((k) => verdict.criteria[k].score);
      const overall = scores.reduce((a, b) => a + b, 0) / scores.length / 10;
      return {
        ok: true,
        ...verdict,
        overall: Math.round(overall * 1000) / 1000,
        cost,
        model: handle.model,
        raw_output: text.slice(0, 4000),
      };
    }
    if (Date.now() > deadline) return { ok: "in_progress" };
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}
