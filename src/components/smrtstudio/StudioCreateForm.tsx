"use client";

/**
 * smrtStudio — the creation form (stages B+C of docs/studio-build-plan.md).
 *
 * Deterministic recommendation, zero LLM: GET /studio/recommendation returns
 * ranked catalog candidates, the recommended model's written recipe (synced
 * from video-lab) and its LIVE fal schema fields. Running is a two-click cost
 * gate (rule 2): the first click POSTs without approval and the server's 402
 * carries the estimate; the inputs then LOCK, and only the explicit
 * "approve & run" — echoing the displayed number back as approved_usd —
 * actually submits. Any drift between the two clicks re-gates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enum: string[] | null;
  default: string | null;
};

type Candidate = {
  endpoint_id: string;
  title: string;
  price_usd: number | string | null;
  price_unit: string;
  has_recipe: boolean;
};

type Recommendation = {
  kind: string;
  basis: string;
  candidates: Candidate[];
  recommended: {
    endpoint_id: string;
    recipe: { title: string; note: string; sections: { heading: string; body: string }[] } | null;
    schema: { available: boolean; fields: SchemaField[] } | null;
    schema_error: string | null;
  } | null;
};

/** prompt/seed render as dedicated controls; everything else is schema-driven. */
const DEDICATED = new Set(["prompt", "seed"]);

type Estimate = { usd: number | null; basis: string };

type Artifact = {
  id: string;
  type: string;
  output_url: string | null;
  audio_url: string | null;
  model: string | null;
  script_id: string | null;
  shot_seq: number | null;
  experiment_run_id: string | null;
  voice_line_id: string | null;
  meta: { code?: string; voice_label?: string } | null;
};

/** Classify a live schema field as a media input the picker can fill, by its
 *  name/description. fal media inputs are almost always `*_url`/`*_urls`; we
 *  only treat string fields whose name signals media, so text fields stay text.
 *  Order matters — audio and video are checked before the broad "image". */
function mediaKindOf(f: SchemaField): "image" | "video" | "audio" | null {
  if (f.type.includes("integer") || f.type.includes("number") || f.type.includes("boolean")) return null;
  // Classify on the field NAME only — a description that merely mentions "image"
  // (e.g. a style/negative_prompt field) must not turn a text box into a picker.
  // fal media inputs are `*_url`/`*_urls`, so the name carries the signal.
  const name = f.name.toLowerCase();
  if (!/url|image|img|audio|voice|video/.test(name)) return null;
  if (/audio|voice|speech|music|sound/.test(name)) return "audio";
  if (/video/.test(name)) return "video";
  if (/image|img|frame|reference|photo|portrait|face/.test(name)) return "image";
  return null;
}

/** Which spine artifacts can fill a media field of the given kind. */
function artifactsForKind(all: Artifact[], kind: "image" | "video" | "audio"): Artifact[] {
  if (kind === "audio") return all.filter((a) => a.type === "voice" && a.audio_url);
  if (kind === "video") return all.filter((a) => a.type === "video" && a.output_url);
  // image: any visual artifact with a URL
  return all.filter((a) =>
    a.output_url &&
    ["image", "storyboard", "character", "character_angle", "background", "prop"].includes(a.type));
}

export function StudioCreateForm({
  kind, projectId, onClose, onSubmitted,
}: {
  kind: "image" | "video";
  projectId: string;
  onClose: () => void;
  onSubmitted?: () => void;
}) {
  const t = useTranslations("studioProjects");
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  // The project's artifacts (the unified spine) — the pool the model-input
  // pickers draw from (docs/studio-production-pipeline.md). A schema field that
  // is a media input (image/video/audio) offers these instead of a bare URL box.
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  // Derivation links recorded when the user picks an existing artifact as input,
  // so a composed run remembers the voice/image it was built from.
  const [sources, setSources] = useState<{
    voice_line_id?: string | null; image_run_id?: string | null;
    script_id?: string | null; shot_seq?: number | null;
  }>({});
  // The cost gate (rule 2 in the screen): first click fetches the estimate
  // and shows it; only the second, explicit confirmation actually submits.
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);
  // Synchronous double-click guard: state updates are async, a second click
  // can land before the re-render disables the button — and this button
  // spends money.
  const inFlight = useRef(false);
  // Once the estimate is on screen the inputs LOCK: the number the user
  // approves must be the number that runs (review finding, 30/07).
  const locked = estimate != null || submitting || submittedCode != null;

  useEffect(() => {
    let cancelled = false;
    setRec(null);
    setError(null);
    (async () => {
      try {
        const data = await api<Recommendation>(`/api/studio/recommendation?kind=${kind}`);
        if (!cancelled) setRec(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [kind]);

  // Load the project's artifacts once — the pool for the media pickers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ artifacts: Artifact[] }>(`/api/studio/projects/${projectId}/artifacts`);
        if (!cancelled) setArtifacts(data.artifacts ?? []);
      } catch {
        /* pickers are additive — a failure just falls back to the URL box */
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const fields = useMemo(
    () => (rec?.recommended?.schema?.fields ?? []).filter((f) => !DEDICATED.has(f.name)),
    [rec],
  );
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);

  const setValue = useCallback((name: string, v: string) => {
    setValues((prev) => ({ ...prev, [name]: v }));
  }, []);

  // The submit payload: field values typed per the live schema (fal validates
  // types — a "5" where an integer is due is a 422). Empty values are omitted
  // so fal's own defaults apply, exactly like the harness.
  const buildPayload = useCallback(() => {
    const args: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name] ?? f.default ?? "";
      if (raw === "") continue;
      if (f.type.includes("integer") || f.type.includes("number")) {
        const n = Number(raw);
        if (!Number.isNaN(n)) args[f.name] = n;
      } else if (f.type.includes("boolean")) {
        args[f.name] = raw === "true";
      } else {
        args[f.name] = raw;
      }
    }
    return {
      studio_project_id: projectId,
      endpoint_id: rec!.recommended!.endpoint_id,
      prompt: prompt.trim(),
      args,
      sources,
    };
  }, [fields, values, projectId, prompt, rec, sources]);

  // Picking an existing artifact fills the field with its URL AND records the
  // derivation link (image → source run, voice → source line) so the run
  // remembers what it was built from. Its shot/script travel with it.
  const pickArtifact = useCallback((f: SchemaField, a: Artifact, kind: "image" | "video" | "audio") => {
    setValue(f.name, (kind === "audio" ? a.audio_url : a.output_url) ?? "");
    setSources((prev) => ({
      ...prev,
      // The picked artifact's own shot/script win (no sticky-prev on re-pick);
      // the other source id (image vs voice) accumulates across fields.
      script_id: a.script_id,
      shot_seq: a.shot_seq,
      ...(kind === "audio"
        ? { voice_line_id: a.voice_line_id ?? null }
        : { image_run_id: a.experiment_run_id ?? null }),
    }));
  }, [setValue]);

  // First click: POST without cost_approved — the server answers 402 with the
  // estimate, which IS the cost dialog. Nothing is spent on this call.
  const requestEstimate = useCallback(async () => {
    setError(null);
    try {
      await api("/api/studio/runs", { method: "POST", body: buildPayload() });
      // A 2xx here would mean the server ran without approval — treat as a bug.
      setError("server accepted a run without cost approval — not submitting further");
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        const est = (e.body as { estimate?: Estimate } | undefined)?.estimate;
        setEstimate(est ?? { usd: null, basis: "unknown" });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [buildPayload]);

  const confirmRun = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const { run } = await api<{ run: { code: string } }>("/api/studio/runs", {
        method: "POST",
        body: { ...buildPayload(), cost_approved: true, approved_usd: estimate?.usd ?? null },
      });
      setSubmittedCode(run.code);
      setEstimate(null);
      onSubmitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [buildPayload, onSubmitted, estimate]);

  const renderField = (f: SchemaField) => {
    const value = values[f.name] ?? f.default ?? "";
    const media = mediaKindOf(f);
    const options = media ? artifactsForKind(artifacts, media) : [];
    return (
      <label key={f.name} className="block text-xs space-y-1">
        <span className="font-medium">
          {f.name}
          {f.required && <span className="text-destructive"> *</span>}
        </span>
        {f.enum ? (
          <select
            className="w-full h-8 rounded-md border bg-background px-2"
            value={value}
            disabled={locked}
            onChange={(e) => setValue(f.name, e.target.value)}
          >
            {!f.default && <option value="" />}
            {f.enum.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        ) : (
          <>
            {/* Media input → pick from the project's artifacts (docs/studio-production-pipeline.md).
                Picking fills the URL box below and records the derivation link. */}
            {media && options.length > 0 && (
              <select
                className="w-full h-8 rounded-md border bg-background px-2 mb-1"
                value=""
                disabled={locked}
                aria-label={t("createPickFrom")}
                onChange={(e) => {
                  const a = options.find((o) => o.id === e.target.value);
                  if (a) pickArtifact(f, a, media);
                }}
              >
                <option value="">{t("createPickFrom")}</option>
                {options.map((a) => (
                  <option key={a.id} value={a.id}>
                    {(a.meta?.code || a.meta?.voice_label || a.model || a.type)} · {a.type}
                  </option>
                ))}
              </select>
            )}
            <Input
              className="h-8"
              value={value}
              placeholder={f.type}
              disabled={locked}
              onChange={(e) => setValue(f.name, e.target.value)}
            />
          </>
        )}
        {f.description && (
          <span className="block text-muted-foreground line-clamp-2" title={f.description}>
            {f.description}
          </span>
        )}
      </label>
    );
  };

  const recipePromptSection = rec?.recommended?.recipe?.sections.find((s) =>
    s.heading.includes("פרומפט"),
  );

  return (
    <div className="rounded-lg border p-3 space-y-3 bg-accent/20">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold flex-1">{t("createTitle")}</h3>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("cancel")} onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!rec && !error && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {rec && (rec.recommended == null ? (
        <p className="text-xs text-muted-foreground">{t("createNoCandidates")}</p>
      ) : (
        <>
          <label className="block text-xs space-y-1">
            <span className="font-medium">{t("createModel")}</span>
            <select
              className="w-full h-8 rounded-md border bg-background px-2"
              value={rec.recommended.endpoint_id}
              // Stage B renders the recommended model's schema; switching model
              // re-fetches in stage C when the form drives a real run.
              disabled
              title={t("createModelLockedWhy")}
            >
              {rec.candidates.map((c) => (
                <option key={c.endpoint_id} value={c.endpoint_id}>
                  {c.title || c.endpoint_id}
                  {c.price_usd != null
                    ? ` — $${c.price_usd}${c.price_unit ? `/${c.price_unit}` : ""}`
                    : ""}
                  {c.has_recipe ? " ★" : ""}
                </option>
              ))}
            </select>
            <span className="block text-muted-foreground">
              {t("createBasis")}: {rec.basis === "shortlist_rank" ? t("createBasisShortlist") : rec.basis}
            </span>
          </label>

          {recipePromptSection && (
            <details className="text-xs rounded-md border p-2">
              <summary className="cursor-pointer font-medium">{t("createRecipeHint")}</summary>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{recipePromptSection.body}</p>
            </details>
          )}

          <label className="block text-xs space-y-1">
            <span className="font-medium">{t("createPrompt")}</span>
            <Textarea rows={4} value={prompt} disabled={locked} onChange={(e) => setPrompt(e.target.value)} />
          </label>

          {rec.recommended.schema_error && (
            <p className="text-xs text-amber-600">{t("createSchemaUnavailable")}</p>
          )}

          {required.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">{required.map(renderField)}</div>
          )}
          {optional.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {t("createMoreSettings")} ({optional.length})
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">{optional.map(renderField)}</div>
            </details>
          )}

          {submittedCode ? (
            <p className="text-xs text-emerald-600 pt-1">
              {t("createSubmitted", { code: submittedCode })}
            </p>
          ) : estimate ? (
            /* Rule 2 embodied: the number is on screen and only the explicit
               second click spends it. */
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2 space-y-2 text-xs">
              <p className="font-medium">
                {estimate.usd != null
                  ? t("createEstimateCost", { usd: `$${estimate.usd.toFixed(3)}` })
                  : t("createEstimateUnknown")}
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void confirmRun()} disabled={submitting}>
                  {t("createConfirmRun")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEstimate(null)} disabled={submitting}>
                  {t("cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={() => void requestEstimate()} disabled={submitting || !prompt.trim()}>
                {t("createRunDisabled")}
              </Button>
              <span className="text-xs text-muted-foreground">{t("createRunGate")}</span>
            </div>
          )}
        </>
      ))}
    </div>
  );
}
