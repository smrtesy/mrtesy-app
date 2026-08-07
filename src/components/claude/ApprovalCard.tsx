"use client";

/**
 * Shared building blocks for the destructive-migration approval gate
 * (docs/claude-console/autonomy-safety-gate.md), used by BOTH surfaces of the
 * hybrid display:
 *
 *   - ThreadApprovals (rendered inside ClaudeChat) — the FULL decision card,
 *     shown in the conversation that raised it, so the human sees what Claude
 *     did and why before approving.
 *   - ApprovalsPanel — the org-wide pointer list, so a destructive migration
 *     is never invisible to another admin or a background session; it points
 *     at the thread rather than repeating the whole card out of context.
 *
 * The card itself and the polling hook live here so the two surfaces stay a
 * single source of truth (one decide flow, one shape).
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Loader2, Database } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api/client";

export interface Approval {
  id: string;
  kind: string;
  status: string;
  title: string;
  payload: {
    sql?: string;
    migration_path?: string | null;
    repo?: string | null;
    classification?: { reasons?: string[] } | null;
    affected_count?: number | null;
    sample_rows?: unknown[] | null;
  } | null;
  /** The conversation that raised this — links the card to its thread. */
  thread_id?: string | null;
  created_at: string;
}

export const APPROVALS_POLL_MS = 15_000;

/** One org-wide poll of the pending queue, plus an optimistic local drop so the
 *  count is right the instant a decision is made (before the next poll). */
export function usePendingApprovals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await api<{ approvals: Approval[] }>("/api/claude/approvals?status=pending");
      setApprovals(res.approvals ?? []);
    } catch {
      // A failed poll is silent: this is an addition to the screen, and a
      // transient backend hiccup must not throw an error toast every 15 seconds.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), APPROVALS_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const remove = useCallback((id: string) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return { approvals, reload: load, remove };
}

/**
 * The full decision card: the plain-Hebrew consequence, the exact SQL and a
 * row preview (both collapsed until opened), and Approve / Reject. Self-contained
 * — it owns its expand + busy state and does the decide call itself, then tells
 * the parent to drop it (`onDecided`) so the surrounding count stays right.
 */
export function ApprovalCard({
  approval,
  t,
  onDecided,
  onError,
}: {
  approval: Approval;
  t: ReturnType<typeof useTranslations>;
  onDecided: (id: string) => void;
  /** Re-sync source of truth after a failed decide (e.g. a 409 already-decided). */
  onError?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const count = approval.payload?.affected_count ?? null;
  const sample = Array.isArray(approval.payload?.sample_rows) ? approval.payload!.sample_rows! : [];

  const decide = useCallback(
    async (decision: "approve" | "reject") => {
      setBusy(true);
      try {
        await api(`/api/claude/approvals/${approval.id}/${decision}`, { method: "POST" });
        toast.success(t(decision === "approve" ? "approvals.approved" : "approvals.rejected"));
        onDecided(approval.id);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : t("approvals.decideFailed");
        toast.error(msg);
        onError?.();
      } finally {
        setBusy(false);
      }
    },
    [approval.id, t, onDecided, onError],
  );

  return (
    <div className="rounded-lg border bg-background p-2.5">
      <div className="flex items-start gap-2">
        <Database className="mt-0.5 size-3.5 shrink-0 text-status-warn" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium leading-snug" dir="auto">
            {approval.title}
          </p>
          {approval.payload?.migration_path && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" dir="ltr">
              {approval.payload.repo ? `${approval.payload.repo} · ` : ""}
              {approval.payload.migration_path}
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t("approvals.showDetails")}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {approval.payload?.sql && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">SQL</p>
              <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed" dir="ltr">
                {approval.payload.sql}
              </pre>
            </div>
          )}
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
              {t("approvals.affected", { count: count ?? 0 })}
            </p>
            {sample.length > 0 ? (
              <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed" dir="ltr">
                {sample.map((r) => JSON.stringify(r)).join("\n")}
              </pre>
            ) : (
              <p className="text-[11px] text-muted-foreground">{t("approvals.noPreview")}</p>
            )}
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          className="h-7 flex-1 text-xs"
          disabled={busy}
          onClick={() => void decide("approve")}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : t("approvals.approve")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 text-xs"
          disabled={busy}
          onClick={() => void decide("reject")}
        >
          {t("approvals.reject")}
        </Button>
      </div>
    </div>
  );
}
