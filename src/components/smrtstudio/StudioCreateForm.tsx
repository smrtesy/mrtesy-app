"use client";

/**
 * smrtStudio — the creation form (stage B of docs/studio-build-plan.md).
 *
 * Deterministic recommendation, zero LLM: GET /studio/recommendation returns
 * ranked catalog candidates, the recommended model's written recipe (synced
 * from video-lab) and its LIVE fal schema fields. The form arrives pre-filled
 * and everything is editable. The run button ships DISABLED by design — it
 * turns on in stage C behind the cost gate (rule 2), and the label says so
 * instead of pretending.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
  // The cost gate (rule 2 in the screen): first click fetches the estimate
  // and shows it; only the second, explicit confirmation actually submits.
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);

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
    };
  }, [fields, values, projectId, prompt, rec]);

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
    setSubmitting(true);
    setError(null);
    try {
      const { run } = await api<{ run: { code: string } }>("/api/studio/runs", {
        method: "POST",
        body: { ...buildPayload(), cost_approved: true },
      });
      setSubmittedCode(run.code);
      setEstimate(null);
      onSubmitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [buildPayload, onSubmitted]);

  const renderField = (f: SchemaField) => {
    const value = values[f.name] ?? f.default ?? "";
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
            onChange={(e) => setValue(f.name, e.target.value)}
          >
            {!f.default && <option value="" />}
            {f.enum.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        ) : (
          <Input
            className="h-8"
            value={value}
            placeholder={f.type}
            onChange={(e) => setValue(f.name, e.target.value)}
          />
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
            <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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
