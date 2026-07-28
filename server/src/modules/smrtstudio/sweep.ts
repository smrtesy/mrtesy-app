/**
 * The catalog sweep, as a function rather than a request handler.
 *
 * Two callers need the exact same work and must not drift apart:
 *   - the operator pressing "Run sweep" on the catalog screen, and
 *   - the weekly cron in jobs.ts, which has no request, no session and no
 *     super-admin to check.
 *
 * It stayed inline in the route until the sweep grew from ~513 video endpoints
 * to all ~1394, at which point one press stopped being enough and "press it
 * about seven more times" became the interface. That is not something a person
 * should have to do, and it is not something a cron can do at all.
 *
 * FREE: reads fal's catalog and OpenAPI schema endpoints only, never an
 * inference endpoint, so no run is ever billed no matter how often it runs.
 */

import { db } from "../../db";
import { fetchCatalog, probeAudio, isVideoCategory } from "./indexer";

type Row = Record<string, unknown>;

/** Carries the HTTP status the route should surface, so moving the logic out
 *  of the handler does not flatten a 502 "fal is unreachable" into a 500. */
export class SweepError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
  ) {
    super(message);
    this.name = "SweepError";
  }
}

export type SweepOptions = {
  /** Skip pass 2 entirely. The catalog pass alone is cheap and always runs. */
  probeAudio?: boolean;
  /** How many schemas to read this round. Probes run through a concurrency
   *  pool, so 150 is ~19 sequential rounds and stays inside a proxy timeout. */
  probeLimit?: number;
};

/** One round: the whole catalog, then up to `probeLimit` unread schemas. */
export async function runSweep(orgId: string, opts: SweepOptions = {}) {
  const probeAudioFlag = opts.probeAudio !== false;
  const probeLimit = Math.min(Math.max(Number(opts.probeLimit ?? 150), 0), 400);

  // ── pass 1: the catalog ──
  let catalog;
  try {
    catalog = await fetchCatalog();
  } catch (e) {
    throw new SweepError(`fal catalog unreachable: ${e instanceof Error ? e.message : String(e)}`, 502);
  }

  const indexedAt = new Date().toISOString();
  // Rows already carrying a hand-written recipe keep their curated fields: the
  // catalog knows the model exists, but only we know it was schema-verified and
  // where it ranks. The upsert below therefore never touches verified_schema,
  // shortlist_rank, recipe_path, price_usd or the audio classification.
  const { data: curatedRows, error: curatedErr } = await db
    .from("studio_models")
    .select("endpoint_id")
    .eq("org_id", orgId)
    .eq("verified_schema", true);
  if (curatedErr) throw new SweepError(curatedErr.message, 500);
  const curated = new Set((curatedRows ?? []).map((r) => String((r as Row).endpoint_id)));

  const catalogIds = new Set(catalog.models.map((m) => m.endpoint_id));
  // A curated row fal no longer lists is either renamed or withdrawn. It is
  // skipped by both write paths, so it would silently stop being refreshed —
  // reported instead of left to rot.
  const curatedMissing = [...curated].filter((id) => !catalogIds.has(id));
  const fresh = catalog.models.filter((m) => !curated.has(m.endpoint_id));
  let written = 0;
  // Chunked so one oversized statement cannot fail the whole sweep.
  for (let i = 0; i < fresh.length; i += 250) {
    const chunk = fresh
      .slice(i, i + 250)
      // `category` is the column the table shipped with; `fal_category` is the
      // one the new code reads. Both are written so neither is a dead field.
      .map((m) => ({ ...m, category: m.fal_category, org_id: orgId, indexed_at: indexedAt }));
    const { error } = await db
      .from("studio_models")
      .upsert(chunk, { onConflict: "org_id,endpoint_id" });
    if (error) throw new SweepError(`upsert failed: ${error.message}`, 500);
    written += chunk.length;
  }
  // Curated rows still get their catalog-owned facts refreshed — deprecation and
  // hosting type change on fal's side and we want to know — without losing the
  // curation. Done one row at a time because the column set differs.
  for (const m of catalog.models.filter((x) => curated.has(x.endpoint_id))) {
    const { error } = await db
      .from("studio_models")
      // ONLY catalog-owned facts. `kind`, `stage_slug` and `stage_order` are
      // curation: six curated rows are classified `lipsync` / stage 8, and fal
      // files those same endpoints under image-to-video / video-to-video, so
      // refreshing them from the category would demote every one to motion.
      .update({
        category: m.fal_category,
        fal_category: m.fal_category,
        deprecated: m.deprecated,
        hosting_type: m.hosting_type,
        license_type: m.license_type,
        indexed_at: indexedAt,
      })
      .eq("org_id", orgId)
      .eq("endpoint_id", m.endpoint_id);
    if (error) throw new SweepError(`refresh failed: ${error.message}`, 500);
  }

  // Pass 1 rebuilt `kind` from fal's category, which UNDOES what pass 2 decided
  // on an earlier sweep: an endpoint filed by fal as `image-to-video` but probed
  // as audio-driven goes back to plain `video`, and pass 2 then skips it because
  // it is already probed. The result was a `video_audio` count that shrank every
  // time the sweep ran. Re-assert the probe's verdict for shelf rows before pass
  // 2 begins — the probe is the stronger evidence, and this is self-healing.
  const { error: reassertErr } = await db
    .from("studio_models")
    .update({ kind: "video_audio", stage_slug: "motion", stage_order: 7 })
    .eq("org_id", orgId)
    .eq("verified_schema", false)
    .eq("audio_input", "driving")
    .neq("kind", "video_audio");
  if (reassertErr) throw new SweepError(`re-assert failed: ${reassertErr.message}`, 500);

  // ── pass 2: the audio probe ──
  // Every model, not only the video ones. The probe used to cover the ~513
  // video endpoints because it was looking for audio inputs alone. It now also
  // reads the capability flags — takes a start image, an end image, a prompt, a
  // trained LoRA — and those are the filters the catalog screen is built on, so
  // an unprobed row is a row that silently disappears from every filter.
  const videoModels = catalog.models.filter((m) => isVideoCategory(m.fal_category));
  const probeIds = catalog.models.map((m) => m.endpoint_id);
  const categoryOf = new Map(catalog.models.map((m) => [m.endpoint_id, m.fal_category]));
  const purposeOf = new Map(catalog.models.map((m) => [m.endpoint_id, m.summary]));

  let probed = 0;
  let driving = 0;
  let remaining = 0;
  if (probeAudioFlag && probeLimit > 0) {
    // Paged in 1000-row chunks, NOT one `.range(0, 4999)`. PostgREST's
    // db-max-rows is 1000 and it clamps a wider range silently. That was
    // harmless while only the ~513 video endpoints were ever probed, but the
    // probe now covers all ~1394: from roughly the seventh press onward the
    // "already done" set would hold only 1000 of them, so `todo` floored at
    // ~394, `remaining` froze at ~244 and never reached 0, and every further
    // press re-probed 150 endpoints that were already done — a sweep that
    // could never finish and kept telling the operator to press again.
    const alreadyProbed = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: pageErr } = await db
        .from("studio_models")
        .select("endpoint_id")
        .eq("org_id", orgId)
        .eq("audio_probed", true)
        .order("endpoint_id")
        .range(from, from + PAGE - 1);
      if (pageErr) throw new SweepError(pageErr.message, 500);
      for (const r of page ?? []) alreadyProbed.add(String((r as Row).endpoint_id));
      if (!page || page.length < PAGE) break;
    }

    const todo = probeIds.filter((id) => !alreadyProbed.has(id));
    remaining = Math.max(0, todo.length - probeLimit);

    const batch = todo.slice(0, probeLimit);
    // A pool rather than a serial loop: each probe is an independent HTTPS round
    // trip, and 8 in flight turns ~150 sequential waits into ~19. Each row is
    // written as it lands, so a failure part-way leaves the rows already probed
    // marked probed — the next press continues instead of redoing them.
    const POOL = 8;
    let cursor = 0;
    let writeError: string | null = null;
    await Promise.all(
      Array.from({ length: Math.min(POOL, batch.length) }, async () => {
        while (writeError === null) {
          const i = cursor;
          cursor += 1;
          if (i >= batch.length) return;
          const id = batch[i];
          const probe = await probeAudio(id, categoryOf.get(id) ?? "", purposeOf.get(id) ?? "");
          // A model that takes our audio as a DRIVING input is its own category:
          // it can carry the motion stage and the lip-sync stage in one call,
          // which no silent image-to-video model can do.
          const patch: Record<string, unknown> = {
            audio_probed: true,
            audio_input: probe.audio_input,
            audio_field: probe.audio_field,
            audio_note: probe.audio_note,
            audio_build: probe.audio_build,
            audio_classified_from: probe.audio_classified_from,
            schema_available: probe.schema_available,
            input_field_count: probe.input_field_count,
            cap_prompt: probe.cap_prompt,
            cap_negative_prompt: probe.cap_negative_prompt,
            cap_start_image: probe.cap_start_image,
            cap_end_image: probe.cap_end_image,
            cap_video_input: probe.cap_video_input,
            cap_lora: probe.cap_lora,
            cap_seed: probe.cap_seed,
            cap_audio_channels: probe.cap_audio_channels,
          };
          if (probe.audio_input === "driving") {
            driving += 1;
            // Re-file only SHELF rows. A curated row keeps the category a human
            // gave it: the six lip-sync models are audio-driven by nature, and
            // moving them to `video_audio`/motion emptied the lip-sync category
            // and lost the stage they actually belong to. Being audio-driven is
            // recorded in `audio_input` either way — that is the fact; `kind` is
            // the judgement, and the judgement stays human.
            if (!curated.has(id)) {
              patch.kind = "video_audio";
              patch.stage_slug = "motion";
              patch.stage_order = 7;
            }
          }
          const { error } = await db
            .from("studio_models")
            .update(patch)
            .eq("org_id", orgId)
            .eq("endpoint_id", id);
          if (error) {
            writeError = error.message;
            return;
          }
          probed += 1;
        }
      }),
    );
    if (writeError) throw new SweepError(`probe write failed: ${writeError}`, 500);
  }

  return {
    ok: true as const,
    indexed_at: indexedAt,
    catalog_total: catalog.total,
    catalog_pages: catalog.pages,
    catalog_sweeps: catalog.sweeps,
    // True when the convergent sweep still could not reach fal's own reported
    // total. Surfaced rather than swallowed: the previous single-pass sweep
    // indexed 76% of the catalog and reported success.
    catalog_incomplete: catalog.incomplete,
    models_seen: catalog.models.length,
    models_written: written,
    curated_preserved: curated.size,
    curated_missing_from_catalog: curatedMissing,
    video_endpoints: videoModels.length,
    audio_probed_this_call: probed,
    audio_driving_found_this_call: driving,
    audio_probe_remaining: remaining,
  };
}


/**
 * One probe round, sourcing its work list from OUR table rather than from fal.
 *
 * This exists so `sweepToCompletion` does not re-crawl the catalog on every
 * round. A catalog pass is ~400 requests to fal (up to 5 convergence sweeps
 * over 35 pages, plus a per-category pass), so looping the FULL sweep fifteen
 * times would have fired roughly six thousand requests at someone else's API
 * to read the same 1394 rows over and over. The catalog changes weekly; the
 * unprobed list changes every round. Only the second one needs re-reading.
 */
export async function runProbeRound(
  orgId: string,
  opts: { probeLimit?: number } = {},
): Promise<{ probed: number; driving: number; remaining: number }> {
  const probeLimit = Math.min(Math.max(Number(opts.probeLimit ?? 150), 0), 400);
  if (probeLimit <= 0) return { probed: 0, driving: 0, remaining: 0 };

  // Only what still needs probing, and only the columns the probe reads.
  // `limit` is deliberately larger than probeLimit so `remaining` is real.
  const { data: todoRows, error: todoErr } = await db
    .from("studio_models")
    .select("endpoint_id,fal_category,summary,verified_schema")
    .eq("org_id", orgId)
    .eq("audio_probed", false)
    .order("endpoint_id")
    .limit(1000);
  if (todoErr) throw new SweepError(todoErr.message, 500);

  const todoAll = todoRows ?? [];
  const batch = todoAll.slice(0, probeLimit);
  const remaining = Math.max(0, todoAll.length - batch.length);

  let probed = 0;
  let driving = 0;
  let writeError: string | null = null;
  const POOL = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, batch.length) }, async () => {
      while (writeError === null) {
        const i = cursor;
        cursor += 1;
        if (i >= batch.length) return;
        const row = batch[i] as Row;
        const id = String(row.endpoint_id);
        const probe = await probeAudio(
          id,
          String(row.fal_category ?? ""),
          String(row.summary ?? ""),
        );
        const patch: Record<string, unknown> = {
          audio_probed: true,
          audio_input: probe.audio_input,
          audio_field: probe.audio_field,
          audio_note: probe.audio_note,
          audio_build: probe.audio_build,
          audio_classified_from: probe.audio_classified_from,
          schema_available: probe.schema_available,
          input_field_count: probe.input_field_count,
          cap_prompt: probe.cap_prompt,
          cap_negative_prompt: probe.cap_negative_prompt,
          cap_start_image: probe.cap_start_image,
          cap_end_image: probe.cap_end_image,
          cap_video_input: probe.cap_video_input,
          cap_lora: probe.cap_lora,
          cap_seed: probe.cap_seed,
          cap_audio_channels: probe.cap_audio_channels,
        };
        if (probe.audio_input === "driving") {
          driving += 1;
          // Re-file only SHELF rows. A curated row keeps the category a human
          // gave it — the lip-sync models are audio-driven by nature, and
          // moving them to video_audio empties the lip-sync category.
          if (row.verified_schema !== true) {
            patch.kind = "video_audio";
            patch.stage_slug = "motion";
            patch.stage_order = 7;
          }
        }
        const { error } = await db
          .from("studio_models")
          .update(patch)
          .eq("org_id", orgId)
          .eq("endpoint_id", id);
        if (error) {
          writeError = error.message;
          return;
        }
        probed += 1;
      }
    }),
  );
  if (writeError) throw new SweepError(`probe write failed: ${writeError}`, 500);
  return { probed, driving, remaining };
}

/**
 * Rounds until nothing is left to probe.
 *
 * Bounded three ways, because an unbounded loop against someone else's API is
 * a way to get blocked: a wall-clock deadline, a round cap, and a
 * no-progress check that stops if a round probes nothing (fal refusing every
 * schema would otherwise spin until the deadline).
 */
export async function sweepToCompletion(
  orgId: string,
  opts: { probeLimit?: number; maxRounds?: number; deadlineMs?: number } = {},
) {
  const maxRounds = opts.maxRounds ?? 15;
  const deadline = Date.now() + (opts.deadlineMs ?? 9 * 60_000);

  // The catalog pass runs ONCE. It is the expensive half (~400 requests to
  // fal) and its answer does not change between rounds; only the unprobed list
  // does. Rounds after this one read that list from our own table.
  const first = await runSweep(orgId, { probeLimit: opts.probeLimit });
  let probedTotal = first.audio_probed_this_call;
  let drivingTotal = first.audio_driving_found_this_call;
  let remaining = first.audio_probe_remaining;
  let madeProgress = first.audio_probed_this_call > 0;
  let rounds = 1;

  while (remaining > 0 && madeProgress && rounds < maxRounds && Date.now() < deadline) {
    const r = await runProbeRound(orgId, { probeLimit: opts.probeLimit });
    probedTotal += r.probed;
    drivingTotal += r.driving;
    remaining = r.remaining;
    madeProgress = r.probed > 0;
    rounds += 1;
  }

  return {
    ...first,
    rounds,
    audio_probe_remaining: remaining,
    audio_probed_total_this_run: probedTotal,
    audio_driving_found_this_run: drivingTotal,
    // The caller must be able to tell "finished" from "ran out of time", or a
    // run that stopped early looks exactly like a run that succeeded.
    complete: remaining === 0,
    stopped_because:
      remaining === 0
        ? "done"
        : !madeProgress
          ? "no_progress"
          : rounds >= maxRounds
            ? "round_cap"
            : "deadline",
  };
}
