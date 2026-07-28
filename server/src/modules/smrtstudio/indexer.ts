/**
 * The fal catalog indexer.
 *
 * Two passes, both FREE — they read fal's catalog and schema endpoints, never
 * its inference endpoints, so no run is ever billed. That is why this can be
 * re-run whenever we want to know what changed.
 *
 * Pass 1 — CATALOG (35 pages, ~1,394 models). Gives us every model fal offers
 *   with its category, vendor group, hosting type, licence and deprecation flag.
 *   Cheap and complete, so it always runs.
 *
 * Pass 2 — AUDIO PROBE (the ~513 video endpoints). Fetches each endpoint's
 *   official OpenAPI schema and looks for an audio INPUT field. This is the only
 *   way to answer the question the program actually cares about: can this model
 *   take OUR recording and drive the clip from it? fal's category cannot say —
 *   `image-to-video` holds both silent animators and audio-driven ones.
 *
 *   Crucially, an audio field's NAME is not enough. The same `audio_url` means
 *   three different things depending on its description, so the description is
 *   what gets classified — and stored verbatim as evidence:
 *     driving   → our audio drives lips/motion. What we want.
 *     reference → guides generation; sync to our track is unproven.
 *     mux       → pasted onto the output as background audio. Lips do NOT sync.
 *   Picking by field name alone lands you in `mux` and looks like it worked.
 *
 * Pass 2 is bounded per call (`probeLimit`) and skips endpoints already probed,
 * so a large sweep is driven to completion over a few calls instead of one
 * request that outlives its own timeout.
 */

const CATALOG_URL = "https://fal.ai/api/models";
const SCHEMA_URL = "https://fal.ai/api/openapi/queue/openapi.json";

/**
 * Whether a field carries an audio FILE WE UPLOAD.
 *
 * Matched by shape rather than by an allowlist: a fixed list missed
 * `second_audio_url`, which is the one field in the whole catalog that lets two
 * characters speak in a single shot.
 *
 * The exclusions matter as much as the matches. `voice_id` / `voice_ids` pick a
 * voice from the vendor's own library, `audio_format` is an output format,
 * `audio_setting` is a behaviour switch and `audio_negative_prompt` is text.
 * All contain "audio" or "voice" and none of them accept our recording —
 * counting them inflates the audio-capable set from 70 endpoints to 84.
 *
 * Output-only toggles (`generate_audio`) are excluded by the type check: they
 * are booleans, and mean the model makes its own sound.
 */
const AUDIO_NAME = /audio/i;
const NOT_OUR_AUDIO = /_format$|_setting$|_prompt$|^voice(_id|_ids|\d*)?$|_description$|^num_speakers$/i;
const AUDIO_URL_NAME = /_urls?$/i;

function isOurAudioField(name: string, description: string, type: string): boolean {
  if (!AUDIO_NAME.test(name) || NOT_OUR_AUDIO.test(name)) return false;
  if (type && type !== "string" && type !== "array") return false;
  return AUDIO_URL_NAME.test(name) || /\burl\b|https?:\/\//i.test(description);
}

/** Axis 2 — what a DRIVING model actually builds. Independent of what the audio
 *  does: LTX audio-to-video and sync-lipsync are both driving, but one composes
 *  a whole shot from the recording and the other only repaints the mouth of a
 *  clip you already have.
 *
 *  `mouth_fix` is a rule (a video goes in, the same video comes out).
 *  `full_scene` and `full_body` are judgement calls and are therefore listed
 *  explicitly rather than guessed, so they can be audited and argued with. */
const FULL_SCENE = new Set([
  "fal-ai/wan/v2.7/image-to-video",
  "fal-ai/wan/v2.7/text-to-video",
  "fal-ai/ltx-2-19b/audio-to-video",
  "fal-ai/ltx-2-19b/audio-to-video/lora",
  "fal-ai/ltx-2-19b/distilled/audio-to-video",
  "fal-ai/ltx-2-19b/distilled/audio-to-video/lora",
  "fal-ai/ltx-2.3-22b/audio-to-video",
  "fal-ai/ltx-2.3-22b/audio-to-video/lora",
  "fal-ai/ltx-2.3-22b/distilled/audio-to-video",
  "fal-ai/ltx-2.3-22b/distilled/audio-to-video/lora",
  "fal-ai/ltx-2.3-quality/audio-to-video",
  "fal-ai/ltx-2.3-quality/audio-to-video/lora",
  "fal-ai/ltx-2.3/audio-to-video",
]);
const FULL_BODY = new Set([
  "fal-ai/wan/v2.2-14b/speech-to-video",
  "fal-ai/bytedance/omnihuman",
  "fal-ai/bytedance/omnihuman/v1.5",
  "fal-ai/davinci-magihuman",
  "fal-ai/longcat-single-avatar/audio-to-video",
  "fal-ai/longcat-single-avatar/image-audio-to-video",
]);

export type AudioBuild = "full_scene" | "full_body" | "avatar" | "mouth_fix";

export function classifyAudioBuild(endpointId: string, falCategory: string): AudioBuild {
  if (FULL_SCENE.has(endpointId)) return "full_scene";
  if (FULL_BODY.has(endpointId)) return "full_body";
  if (falCategory === "video-to-video") return "mouth_fix";
  return "avatar";
}

/** Capability flags read off the schema. Stored on the row because filtering
 *  1,394 models cannot mean fetching 1,394 schemas. */
const START_IMAGE = /^(image_url|image_urls|first_frame|start_image|input_image)/i;
const END_IMAGE = /end_image|last_frame|end_frame|tail_image/i;

/** fal categories that produce video. Their count is what the research reported
 *  as "513 video endpoints" — kept as a set so the number is derived, not typed. */
const VIDEO_CATEGORIES = new Set([
  "image-to-video",
  "video-to-video",
  "text-to-video",
  "audio-to-video",
]);

/**
 * A catalog row as fal actually returns it. Two of these fields are named the
 * opposite of what they hold, which is exactly why they are documented here
 * rather than inferred:
 *
 *   `id`       IS the callable endpoint id — "fal-ai/nano-banana-2/edit".
 *   `modelId`  is an opaque internal handle — "d6g75ecregja8ueb69k0". Using it
 *              as the endpoint id matches nothing (verified: 0 of our 32
 *              curated endpoints resolve through modelId, 30 resolve through id).
 *   `group`    is a UI grouping label ("Text to Image") and is absent on 304
 *              rows — it is NOT the vendor. The owner is the first path segment
 *              of `id` ("fal-ai", "bytedance", "resemble-ai", …).
 *   `modelUrl` is the API base ("https://fal.run/<id>"), not the docs page.
 */
type FalModel = {
  id?: string;
  modelId?: string;
  title?: string;
  category?: string;
  group?: { key?: string; label?: string } | string | null;
  modelFamily?: string;
  shortDescription?: string;
  licenseType?: string;
  hostingType?: string;
  deprecated?: boolean;
  removed?: boolean;
  modelUrl?: string;
  pricingInfoOverride?: string;
  publishedAt?: string;
  date?: string;
  kind?: string;
};

/** The seven groups the catalog screen navigates by — coarser than `kind`,
 *  which stays a pipeline-stage bucket. fal's 26 raw categories are too many
 *  to be tabs and too few to be self-explaining. */
const GROUP_BY_CATEGORY: Record<string, string> = {
  "text-to-image": "image",
  "image-to-image": "image",
  "text-to-video": "video",
  "image-to-video": "video",
  "video-to-video": "video",
  "audio-to-video": "video",
  "text-to-speech": "audio",
  "text-to-audio": "audio",
  "audio-to-audio": "audio",
  "speech-to-speech": "audio",
  "video-to-audio": "audio",
  vision: "understanding",
  "speech-to-text": "understanding",
  "image-to-text": "understanding",
  "video-to-text": "understanding",
  "audio-to-text": "understanding",
  "image-to-json": "understanding",
  "image-to-3d": "3d",
  "text-to-3d": "3d",
  "3d-to-3d": "3d",
  training: "training",
};

function groupOf(category: string): string {
  return GROUP_BY_CATEGORY[category] ?? "tools";
}

/**
 * fal's canonical price sentence: "Your request will cost **$0.15** per image."
 * ONLY this shape yields a number.
 *
 * Taking the first dollar figure in the prose instead is actively wrong on
 * tiered pricing. Seedream 5 Pro Edit opens with "$0.0045" — the surcharge for
 * each EXTRA input image — and only later states the real "$0.0675 per output
 * image". A first-match parse understates it 15x and that number would flow
 * straight into the cost ledger. 245 endpoints price by tier and honestly have
 * no single figure; they return `ambiguous` and keep their prose.
 */
const PRICE_STRONG =
  /(?:will cost|costs?|charged|priced at|price is)\s*(?:\*\*)?\$?\s*(?:\*\*)?([0-9]*\.?[0-9]+)(?:\*\*)?\s*(?:\*\*)?(?:per|\/|each)\s+([a-z0-9 -]{2,40})/i;
const PRICE_AMOUNT = /\$\s*\*{0,2}\(?\s*([0-9]*\.?[0-9]+)/g;
const PRICE_UNIT = /per\s+([a-z0-9 -]{2,40})/i;

export function parsePrice(text: string): {
  usd: number | null;
  unit: string;
  ambiguous: boolean;
} {
  if (!text.trim()) return { usd: null, unit: "", ambiguous: false };

  const strong = PRICE_STRONG.exec(text);
  if (strong) {
    return {
      usd: Number(strong[1]),
      unit: strong[2].trim().replace(/[.,\s]+$/, ""),
      ambiguous: false,
    };
  }

  // No canonical sentence. A single amount in the whole string is still safe to
  // read; several means tiers or surcharges, and picking one would be a guess.
  const amounts = new Set<number>();
  for (const m of text.matchAll(PRICE_AMOUNT)) amounts.add(Number(m[1]));
  const unit = PRICE_UNIT.exec(text)?.[1]?.trim().replace(/[.,\s]+$/, "") ?? "";
  if (amounts.size === 1) return { usd: [...amounts][0], unit, ambiguous: false };
  return { usd: null, unit, ambiguous: true };
}

/** The reference shot: 8s, 720p, 24fps. Its only job is to make prices
 *  comparable — inside the LTX family alone fal bills some endpoints per
 *  megapixel and others per second, so the raw figures invite the wrong
 *  comparison. Resolution-tiered prices are deliberately NOT converted: a trial
 *  extractor got 2 of 5 spot-checks wrong (it read xAI's 480p rate as its 720p
 *  one, and dropped a "/second" suffix, understating a shot 8x). */
const SHOT_SECONDS = 8;
const SHOT_MEGAPIXELS = (SHOT_SECONDS * 24 * 1280 * 720) / 1_000_000;

export function shotEstimate(
  usd: number | null,
  unit: string,
  category: string,
): { usd: number; basis: string } | null {
  if (usd == null || !unit || !VIDEO_CATEGORIES.has(category)) return null;
  const u = unit.toLowerCase();
  if (u.includes("megapixel")) {
    return { usd: Number((usd * SHOT_MEGAPIXELS).toFixed(3)), basis: "shot_8s_720p" };
  }
  if (u.includes("compute second")) return null; // depends on GPU runtime, unknowable
  if (u.includes("second")) {
    return { usd: Number((usd * SHOT_SECONDS).toFixed(3)), basis: "shot_8s_720p" };
  }
  if (/\b(video|generation|request|clip)\b/.test(u)) {
    return { usd: Number(usd.toFixed(3)), basis: "flat_per_run" };
  }
  return null;
}

/** The owner segment of an endpoint id — the real vendor signal. */
function vendorOf(endpointId: string): string {
  const owner = endpointId.split("/")[0] ?? "";
  return owner === "fal-ai" ? "fal" : owner;
}

export type AudioRole = "driving" | "reference" | "mux";

export type IndexedModel = {
  endpoint_id: string;
  title: string;
  fal_category: string;
  kind: string;
  group_key: string;
  family: string;
  summary: string;
  vendor: string;
  hosting_type: string;
  license_type: string;
  deprecated: boolean;
  price_note: string;
  price_usd: number | null;
  price_unit: string;
  price_ambiguous: boolean;
  published_at: string | null;
  is_pipeline_tool: boolean;
  shot_estimate_usd: number | null;
  shot_estimate_basis: string;
  source_url: string;
  stage_slug: string | null;
  stage_order: number;
};

/** Our coarse bucket, and the pipeline stage that consumes it. The order is the
 *  order the work happens in — characters, voices, sets, frames, motion,
 *  lip-sync — so the catalog reads like the process rather than like fal's
 *  taxonomy. `video_audio` is assigned by the audio probe, not here: the
 *  catalog alone cannot tell an audio-driven model from a silent one. */
const KIND_BY_CATEGORY: Record<string, { kind: string; stage: string | null; order: number }> = {
  "text-to-image": { kind: "image", stage: "chars", order: 3 },
  "image-to-image": { kind: "image", stage: "chars", order: 3 },
  "text-to-speech": { kind: "voice", stage: "voice", order: 4 },
  "text-to-audio": { kind: "voice", stage: "voice", order: 4 },
  "audio-to-audio": { kind: "voice", stage: "voice", order: 4 },
  "speech-to-speech": { kind: "voice", stage: "voice", order: 4 },
  "speech-to-text": { kind: "qc", stage: null, order: 98 },
  "audio-to-text": { kind: "qc", stage: null, order: 98 },
  "image-to-video": { kind: "video", stage: "motion", order: 7 },
  "text-to-video": { kind: "video", stage: "motion", order: 7 },
  "video-to-video": { kind: "video", stage: "motion", order: 7 },
  "audio-to-video": { kind: "video_audio", stage: "motion", order: 7 },
  "video-to-audio": { kind: "other", stage: null, order: 99 },
  "video-to-text": { kind: "qc", stage: null, order: 98 },
  vision: { kind: "qc", stage: null, order: 98 },
  "image-to-text": { kind: "qc", stage: null, order: 98 },
};

function bucket(category: string): { kind: string; stage: string | null; order: number } {
  return KIND_BY_CATEGORY[category] ?? { kind: "other", stage: null, order: 99 };
}

/**
 * Classify what an audio input field is FOR, from fal's own description.
 * Ordered most-specific first: the mux wording is checked before the generic
 * driving hints, because "use as the audio for the video" also contains the
 * word audio and would otherwise read as driving.
 */
export function classifyAudioRole(
  field: string,
  description: string,
  falCategory = "",
  endpointId = "",
  /** The endpoint's own summary/about. Tier 2 evidence: used only when the
   *  field description says nothing, and only ever to conclude `driving`. */
  purpose = "",
): AudioRole {
  const d = description.toLowerCase();

  // 1. A field that names lip-sync only to DENY it is decisive, and beats every
  //    positive signal below: "Audio track to attach to the output. No lip-sync
  //    is performed."
  if (/\bno lip[- ]?sync|\bnot? sync|without lip[- ]?sync|does not sync/.test(d)) return "mux";

  // 2. An explicit statement that THIS field drives generation. Checked before
  //    the mux wording because a driving field often also mentions background
  //    music while describing what happens when it is OMITTED — e.g. Wan 2.7:
  //    "URL of driving audio … If not provided, the model auto-generates
  //    matching background music." That is a fallback, not this field's role,
  //    and reading it as mux hid a genuinely audio-driven model.
  if (
    /driving audio|drives? (the )?(generation|video|avatar|animation)|to drive|articulate|lip[- ]?sync(ing)? (the|to|from|audio)|for the avatar to lip/.test(
      d,
    )
  ) {
    return "driving";
  }

  // 3. Pasted onto the output. Lips do not move to it — the trap that catches
  //    anyone selecting by field name.
  if (
    /background music|background audio|use (it )?as the audio|will be muxed|added to the (output|video)|soundtrack|attach to the output|as the audio track/.test(
      d,
    )
  ) {
    return "mux";
  }

  // 4. Explicitly a reference/guide rather than a driver.
  if (/reference audio|to guide|guidance|style of the audio|as a reference/.test(d)) return "reference";

  // 5. Weaker driving phrasings.
  if (/driving|drive[sn]?\b|lip[- ]?sync|talking|speech to animate|animate.*audio/.test(d)) {
    return "driving";
  }
  if (/driv/.test(field)) return "driving";
  if (/generate the video from|generate a video from|from the audio|audio to video|to dub/.test(d)) {
    return "driving";
  }

  // 6. An `audio-to-video` endpoint takes audio as its PREMISE — the category
  //    means "make a video from this audio". Many such schemas describe the field
  //    as flatly as "The URL of the audio file.", with no verb to match on.
  if (falCategory === "audio-to-video") return "driving";

  // 7. Avatar and lip-sync FAMILIES are audio-driven by construction, and fal
  //    files them under plain image-to-video / video-to-video. The signal lives
  //    in the endpoint id, which is why the id is matched and not just the
  //    category. Measured: without rules 6-7, 14 of 24 such endpoints fell
  //    through — including the program's own first-choice lip-sync model.
  if (
    /avatar|lipsync|lip-sync|talking|omnihuman|infinitalk|echomimic|latentsync|musetalk|flashtalk|sadtalker|dubbing/.test(
      `${endpointId} ${field}`.toLowerCase(),
    )
  ) {
    return "driving";
  }

  // 8. A bare `reference_audio_*` name with no wording either way.
  if (/^reference_audio/.test(field)) return "reference";

  // 9. TIER 2 — the field said nothing, so fall back to what the ENDPOINT is
  //    for. Plenty of schemas describe the field as no more than "The URL of
  //    the audio file" while the model exists for nothing but lip-sync, and
  //    reading only the field left Creatify Aurora ("videos of your avatar
  //    speaking or singing") and VEED Fabric ("turns any image into a talking
  //    video", with an EMPTY field description) filed as `reference` — the
  //    weaker class, which hides them from the category we act on.
  //
  //    Tier 2 can only ever conclude `driving`: "this is a talking-avatar
  //    model" is evidence that the audio drives it and evidence of nothing
  //    else. `mux` and `reference` remain claims that only the field docs can
  //    establish.
  if (
    /lip[- ]?sync|talking|talks|avatar|dubbing|dubbed|speech.?to.?video|audio.?to.?video|multitalk|speaking|singing|audio.?driven/i.test(
      purpose,
    )
  ) {
    return "driving";
  }

  // 10. Present but unexplained anywhere. `reference` is the weaker claim, so an
  //     unverified endpoint is never promoted into the category we act on.
  return "reference";
}

async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pass 1 — every model in the catalog, swept until a pass adds nothing new.
 *
 * fal's pages OVERLAP. Walking page 1..N once and deduplicating returns ~1,057
 * unique ids out of the 1,394 fal itself reports — the sort is unstable, so the
 * same model appears on two pages while another appears on none. That is what
 * this function used to do, which meant the shelf was 76% of fal and looked
 * complete. (`size` is ignored by the API; 40 per page is fixed.)
 *
 * Two mechanisms close the gap. Repeated sweeps re-roll the unstable ordering,
 * and a per-category pass works over result sets small enough that the corners
 * stop hiding. Together they reach 1,394/1,394; either alone does not.
 */
export async function fetchCatalog(): Promise<{
  models: IndexedModel[];
  total: number;
  pages: number;
  sweeps: number;
  /** Set when the sweep still could not reach fal's own reported total, so an
   *  incomplete shelf is visible instead of being mistaken for the catalog. */
  incomplete: boolean;
}> {
  const seen = new Map<string, FalModel>();
  let total = 0;
  let pages = 1;
  let sweeps = 0;

  const absorb = (page: { items?: FalModel[]; total?: number; pages?: number }) => {
    if (page.total) total = Number(page.total);
    if (page.pages) pages = Math.max(pages, Number(page.pages));
    for (const m of page.items ?? []) {
      const id = String(m.id ?? "").trim();
      // A row with no endpoint id cannot be called or deduplicated — skip it
      // rather than inserting a placeholder that looks like a real model.
      if (id) seen.set(id, m);
    }
  };

  absorb((await getJson(`${CATALOG_URL}?page=1`)) as Parameters<typeof absorb>[0]);

  const MAX_SWEEPS = 5;
  for (let s = 0; s < MAX_SWEEPS; s += 1) {
    const before = seen.size;
    sweeps += 1;
    for (let p = 1; p <= pages; p += 1) {
      try {
        absorb((await getJson(`${CATALOG_URL}?page=${p}`)) as Parameters<typeof absorb>[0]);
      } catch {
        // One flaky page must not abort a sweep that is otherwise working; the
        // next sweep covers it, and `incomplete` reports if it never did.
      }
    }
    if (total && seen.size >= total) break;
    if (s > 0 && seen.size === before) break; // converged short of total
  }

  // Per-category pass. Smaller result sets, so the unstable ordering has fewer
  // places to hide a model from every page of the flat sweep.
  const categories = [...new Set([...seen.values()].map((m) => String(m.category ?? "")))].filter(Boolean);
  for (const cat of categories) {
    for (let p = 1; p <= 10; p += 1) {
      let page: { items?: FalModel[]; pages?: number };
      try {
        page = (await getJson(
          `${CATALOG_URL}?page=${p}&categories=${encodeURIComponent(cat)}`,
        )) as typeof page;
      } catch {
        break;
      }
      absorb(page);
      if (p >= Number(page.pages ?? 1)) break;
    }
  }

  const models: IndexedModel[] = [];
  for (const [id, m] of seen) {
    const category = String(m.category ?? "unknown");
    const b = bucket(category);
    const price = parsePrice(String(m.pricingInfoOverride ?? ""));
    const shot = shotEstimate(price.usd, price.unit, category);
    models.push({
      endpoint_id: id,
      title: String(m.title ?? id),
      fal_category: category,
      kind: b.kind,
      group_key: groupOf(category),
      family: String(m.modelFamily ?? (typeof m.group === "object" ? m.group?.key : "") ?? ""),
      summary: String(m.shortDescription ?? ""),
      vendor: vendorOf(id),
      hosting_type: String(m.hostingType ?? ""),
      license_type: String(m.licenseType ?? ""),
      deprecated: m.deprecated === true || m.removed === true,
      price_note: String(m.pricingInfoOverride ?? ""),
      price_usd: price.usd,
      price_unit: price.unit,
      price_ambiguous: price.ambiguous,
      published_at: String(m.publishedAt ?? m.date ?? "").slice(0, 10) || null,
      is_pipeline_tool: /ffmpeg-api|workflow-utilities/.test(id),
      shot_estimate_usd: shot?.usd ?? null,
      shot_estimate_basis: shot?.basis ?? "",
      // The human-readable model page. `modelUrl` is the fal.run API base, which
      // is not something to send a reader to.
      source_url: `https://fal.ai/models/${id}`,
      stage_slug: b.stage,
      stage_order: b.order,
    });
  }
  return {
    models,
    total: total || models.length,
    pages,
    sweeps,
    incomplete: Boolean(total) && models.length < total,
  };
}

export type AudioProbe = {
  endpoint_id: string;
  audio_input: AudioRole | null;
  audio_field: string | null;
  audio_note: string | null;
  audio_build: AudioBuild | null;
  /** Which tier of evidence decided the role. `field_description` means fal's
   *  own wording for that field said so; `model_purpose` means the field was
   *  described as nothing more than "URL of the input audio" and the class came
   *  from what the endpoint exists to do. Reading only the field description
   *  leaves 22 obvious lip-sync endpoints unclassified — every sync-lipsync
   *  version, the Kling avatars, MuseTalk, InfiniTalk — so the second tier is
   *  needed, and saying which one answered keeps it honest. */
  audio_classified_from: "field_description" | "model_purpose" | null;
  schema_available: boolean;
  input_field_count: number;
  cap_prompt: boolean;
  cap_negative_prompt: boolean;
  cap_start_image: boolean;
  cap_end_image: boolean;
  cap_video_input: boolean;
  cap_lora: boolean;
  cap_seed: boolean;
  cap_audio_channels: number;
};

/** Wording in a field description that settles the role on its own. */
const FIELD_SAYS =
  /\bno lip[- ]?sync|driving audio|drives? (the )?(generation|video|avatar|animation)|to drive|articulate|background music|use (it )?as the audio|attach to the output|as the audio track|reference audio|to guide|@Audio|generate the video from|matches its duration/i;

/** Pass 2 — read one endpoint's official schema: what it does with our audio,
 *  and what it can be fed. */
export async function probeAudio(
  endpointId: string,
  falCategory = "",
  purposeText = "",
): Promise<AudioProbe> {
  const empty: AudioProbe = {
    endpoint_id: endpointId,
    audio_input: null,
    audio_field: null,
    audio_note: null,
    audio_build: null,
    audio_classified_from: null,
    schema_available: false,
    input_field_count: 0,
    cap_prompt: false,
    cap_negative_prompt: false,
    cap_start_image: false,
    cap_end_image: false,
    cap_video_input: false,
    cap_lora: false,
    cap_seed: false,
    cap_audio_channels: 0,
  };
  let doc: {
    components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
  };
  try {
    doc = (await getJson(`${SCHEMA_URL}?endpoint_id=${encodeURIComponent(endpointId)}`)) as typeof doc;
  } catch {
    // An endpoint whose schema will not load stays unclassified rather than
    // being guessed at from its name.
    return empty;
  }

  const entry = Object.entries(doc.components?.schemas ?? {}).find(([name]) => /input/i.test(name));
  if (!entry) return empty;
  const props = entry[1].properties ?? {};
  const names = Object.keys(props);

  const audioFields: { field: string; note: string }[] = [];
  for (const [field, propRaw] of Object.entries(props)) {
    const prop = (propRaw ?? {}) as { description?: string; title?: string; type?: string };
    const note = String(prop.description ?? prop.title ?? "");
    if (isOurAudioField(field, note, String(prop.type ?? ""))) audioFields.push({ field, note });
  }

  const caps = {
    schema_available: true,
    input_field_count: names.length,
    cap_prompt: names.includes("prompt"),
    cap_negative_prompt: names.includes("negative_prompt"),
    cap_start_image: names.some((n) => START_IMAGE.test(n)),
    cap_end_image: names.some((n) => END_IMAGE.test(n)),
    cap_video_input: names.includes("video_url") || names.includes("video_urls"),
    // `loras` only. `camera_lora` is a preset LTX ships with and
    // `distill_lora_*` is internal acceleration — neither takes a LoRA we
    // trained, and counting them inflates the total by half.
    cap_lora: names.includes("loras"),
    cap_seed: names.includes("seed"),
    cap_audio_channels: audioFields.length,
  };

  if (audioFields.length === 0) return { ...empty, ...caps };

  // Tier 1: the field's own description. It is the only evidence that can
  // establish `mux` or `reference` — those are claims about what this endpoint
  // does with the file, and nothing but the field docs can settle them.
  const blob = audioFields.map((a) => `${a.field}: ${a.note}`).join(" || ");
  const primary = audioFields[0];
  const role = classifyAudioRole(primary.field, blob, falCategory, endpointId, purposeText);
  const fromField = FIELD_SAYS.test(blob);

  return {
    ...empty,
    ...caps,
    audio_input: role,
    audio_field: primary.field,
    audio_note: primary.note,
    // Tier 2 only ever concludes `driving`: "this is a lip-sync model" is
    // evidence the audio drives it and evidence of nothing else.
    audio_classified_from: fromField
      ? "field_description"
      : role === "driving" || purposeText
        ? "model_purpose"
        : null,
    audio_build: role === "driving" ? classifyAudioBuild(endpointId, falCategory) : null,
  };
}

export function isVideoCategory(category: string): boolean {
  return VIDEO_CATEGORIES.has(category);
}

/** One input field of a model, as its official schema declares it. */
export type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  /** The closed set of accepted values, when the schema constrains it. This is
   *  the field that matters most for duration: it is an ENUM per model, not a
   *  free number, which is why the pipeline plans an intent and derives the cut
   *  per tool rather than assuming one length everywhere. */
  enum: string[] | null;
  default: string | null;
};

export type ModelSchema = {
  endpoint_id: string;
  /** null when fal has no schema for this endpoint — reported rather than
   *  rendered as "no fields", which would read as "takes no input". */
  available: boolean;
  fields: SchemaField[];
};

function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Read a model's INPUT contract live from fal's official OpenAPI schema.
 *
 * Deliberately not cached in our own tables: a stored copy of someone else's
 * contract is a contract that can go stale without anyone noticing, and this
 * program has already been bitten by acting on an inferred field. Free — the
 * schema endpoint is not a billed inference call.
 */
export async function fetchModelSchema(endpointId: string): Promise<ModelSchema> {
  let doc: {
    components?: {
      schemas?: Record<
        string,
        { properties?: Record<string, unknown>; required?: string[] }
      >;
    };
  };
  try {
    doc = (await getJson(
      `${SCHEMA_URL}?endpoint_id=${encodeURIComponent(endpointId)}`,
    )) as typeof doc;
  } catch {
    return { endpoint_id: endpointId, available: false, fields: [] };
  }

  // The input schema is the one named *Input; a model can expose several, and
  // the first is the one the queue endpoint accepts.
  const entry = Object.entries(doc.components?.schemas ?? {}).find(([name]) =>
    /input/i.test(name),
  );
  if (!entry) return { endpoint_id: endpointId, available: false, fields: [] };

  const [, schema] = entry;
  const required = new Set(schema.required ?? []);
  const fields: SchemaField[] = Object.entries(schema.properties ?? {}).map(
    ([name, propRaw]) => {
      const p = (propRaw ?? {}) as {
        type?: string;
        description?: string;
        title?: string;
        enum?: unknown[];
        default?: unknown;
        anyOf?: { type?: string }[];
      };
      const type =
        p.type ?? p.anyOf?.map((a) => a.type).filter(Boolean).join(" | ") ?? "";
      return {
        name,
        type: String(type),
        required: required.has(name),
        description: String(p.description ?? p.title ?? ""),
        enum: Array.isArray(p.enum) ? p.enum.map((v) => String(v)) : null,
        default: asText(p.default),
      };
    },
  );

  // Required fields first, then alphabetical: what you must send before what you
  // may tune.
  fields.sort((a, b) =>
    a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1,
  );
  return { endpoint_id: endpointId, available: true, fields };
}
