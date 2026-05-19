"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface TrailResponse {
  source: {
    serial_display: string | null;
    source_type: string | null;
    source_url: string | null;
    sender: string | null;
    sender_email: string | null;
    subject: string | null;
    received_at: string | null;
    ai_classification: string | null;
  } | null;
  log: {
    classification_reason: string | null;
    ai_classification: string | null;
    ai_model_used: string | null;
    ai_input_tokens: number | null;
    ai_output_tokens: number | null;
    ai_cost_usd: number | null;
    status: string | null;
    error_message: string | null;
  } | null;
}

interface AITrailProps {
  taskId: string;
  /** Show the cost-token row (admin-only on /log; same gate here) */
  showCost?: boolean;
  className?: string;
}

/**
 * Collapsible block that lazily fetches the AI decision trail for a task.
 * Closed by default — first click triggers the fetch. Used in TaskDetail
 * and inside each MessageSuggestions card.
 */
export function AITrail({ taskId, showCost, className }: AITrailProps) {
  const t = useTranslations("aiTrail");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TrailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTrail = useCallback(async () => {
    if (data || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<TrailResponse>(`/api/tasks/${taskId}/trail`);
      setData(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;  // auth flicker — sidebar handles refresh
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [taskId, data, loading]);

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next) fetchTrail();
  }

  const source = data?.source ?? null;
  const log    = data?.log ?? null;

  return (
    <div className={cn("rounded-md border bg-muted/30", className)}>
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          {t("title")}
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 text-xs" dir="auto">
          {loading && <p className="text-muted-foreground">{t("loading")}</p>}
          {error && <p className="text-red-500">{error}</p>}

          {!loading && !error && !source && (
            <p className="text-muted-foreground">{t("noSource")}</p>
          )}

          {source && (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                {source.serial_display && (
                  <span className="font-mono">{source.serial_display}</span>
                )}
                {source.source_type && (
                  <span>· {source.source_type}</span>
                )}
                {source.received_at && (
                  <span>· {new Date(source.received_at).toLocaleString()}</span>
                )}
              </div>

              {source.subject && (
                <div>
                  <span className="text-muted-foreground/70">{t("subject")}: </span>
                  <span>{source.subject}</span>
                </div>
              )}
              {(source.sender || source.sender_email) && (
                <div>
                  <span className="text-muted-foreground/70">{t("from")}: </span>
                  <span>{source.sender || source.sender_email}</span>
                  {source.sender && source.sender_email && source.sender_email !== source.sender && (
                    <span className="text-muted-foreground/60"> ({source.sender_email})</span>
                  )}
                </div>
              )}

              {log?.ai_classification && (
                <div>
                  <span className="text-muted-foreground/70">{t("classification")}: </span>
                  <span className="font-medium">{log.ai_classification}</span>
                </div>
              )}

              {log?.classification_reason && (
                <div>
                  <span className="text-muted-foreground/70">{t("reason")}: </span>
                  <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{log.classification_reason}</p>
                </div>
              )}

              {log?.error_message && (
                <div className="rounded bg-red-50 dark:bg-red-950/30 p-2 text-red-700 dark:text-red-300">
                  {log.error_message}
                </div>
              )}

              {showCost && (log?.ai_model_used || log?.ai_cost_usd) && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/70 pt-1 border-t border-border/40">
                  {log.ai_model_used && <span>{log.ai_model_used}</span>}
                  {(log.ai_input_tokens || log.ai_output_tokens) && (
                    <span>{log.ai_input_tokens ?? 0}+{log.ai_output_tokens ?? 0} tok</span>
                  )}
                  {log.ai_cost_usd != null && <span>${Number(log.ai_cost_usd).toFixed(5)}</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
