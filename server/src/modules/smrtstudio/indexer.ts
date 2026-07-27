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

/** Fields that carry audio INTO a model. Output-only toggles (generate_audio)
 *  are deliberately absent — they mean the model makes its own sound, which is
 *  the opposite of what we need. */
const AUDIO_INPUT_FIELDS = new Set([
  "audio_url",
  "audio_urls",
  "first_audio_url",
  "driven_audio_url",
  "driving_audio_url",
  "audio",
  "reference_audio_url",
  "reference_audio_urls",
]);

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
  licenseType?: string;
  hostingType?: string;
  deprecated?: boolean;
  removed?: boolean;
  modelUrl?: string;
  pricingInfoOverride?: string;
  kind?: string;
};

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
  vendor: string;
  hosting_type: string;
  license_type: string;
  deprecated: boolean;
  price_note: string;
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
  // 9. Present but unexplained. `reference` is the weaker claim, so an
  //    unverified endpoint is never promoted into the category we act on.
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

/** Pass 1 — walk every catalog page. Stops on the page count fal reports rather
 *  than a hardcoded 35, so the sweep still covers the catalog as it grows. */
export async function fetchCatalog(): Promise<{ models: IndexedModel[]; total: number; pages: number }> {
  const first = (await getJson(`${CATALOG_URL}?page=1`)) as {
    items?: FalModel[];
    total?: number;
    pages?: number;
  };
  const pages = Math.max(1, Number(first.pages ?? 1));
  const raw: FalModel[] = [...(first.items ?? [])];

  for (let p = 2; p <= pages; p += 1) {
    const page = (await getJson(`${CATALOG_URL}?page=${p}`)) as { items?: FalModel[] };
    raw.push(...(page.items ?? []));
  }

  const models: IndexedModel[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    // `id`, not `modelId` — see the FalModel doc above.
    const id = String(m.id ?? "").trim();
    // A row with no endpoint id cannot be called or deduplicated — skip it
    // rather than inserting a placeholder that looks like a real model.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const category = String(m.category ?? "unknown");
    const b = bucket(category);
    models.push({
      endpoint_id: id,
      title: String(m.title ?? id),
      fal_category: category,
      kind: b.kind,
      vendor: vendorOf(id),
      hosting_type: String(m.hostingType ?? ""),
      license_type: String(m.licenseType ?? ""),
      deprecated: m.deprecated === true || m.removed === true,
      price_note: String(m.pricingInfoOverride ?? ""),
      // The human-readable model page. `modelUrl` is the fal.run API base, which
      // is not something to send a reader to.
      source_url: `https://fal.ai/models/${id}`,
      stage_slug: b.stage,
      stage_order: b.order,
    });
  }
  return { models, total: Number(first.total ?? models.length), pages };
}

export type AudioProbe = {
  endpoint_id: string;
  audio_input: AudioRole | null;
  audio_field: string | null;
  audio_note: string | null;
};

/** Pass 2 — read one endpoint's official schema and report its audio input. */
export async function probeAudio(endpointId: string, falCategory = ""): Promise<AudioProbe> {
  const empty: AudioProbe = {
    endpoint_id: endpointId,
    audio_input: null,
    audio_field: null,
    audio_note: null,
  };
  let doc: { components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> } };
  try {
    doc = (await getJson(`${SCHEMA_URL}?endpoint_id=${encodeURIComponent(endpointId)}`)) as typeof doc;
  } catch {
    // An endpoint whose schema will not load stays unclassified rather than
    // being guessed at from its name.
    return empty;
  }

  for (const [schemaName, schema] of Object.entries(doc.components?.schemas ?? {})) {
    if (!/input/i.test(schemaName)) continue;
    for (const [field, propRaw] of Object.entries(schema.properties ?? {})) {
      if (!AUDIO_INPUT_FIELDS.has(field)) continue;
      const prop = (propRaw ?? {}) as { description?: string; title?: string; type?: string };
      // A field called `audio` that is a BOOLEAN is an output switch ("generate
      // audio too"), not a way to send ours in. Only a URL string or a list of
      // them can carry our recording.
      const type = String(prop.type ?? "");
      if (type && type !== "string" && type !== "array") continue;
      const note = String(prop.description ?? prop.title ?? "");
      return {
        endpoint_id: endpointId,
        audio_input: classifyAudioRole(field, note, falCategory, endpointId),
        audio_field: field,
        audio_note: note,
      };
    }
  }
  return empty;
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
