"use client";

/**
 * The human side of the autonomy gate (docs/claude-console/autonomy-safety-gate.md).
 *
 * The in-app Claude does reversible work on its own; the ONE thing it routes to a
 * human is a DESTRUCTIVE migration. Those land as `pending` rows in
 * claude_action_approvals, and this is where the human sees the plain-Hebrew
 * consequence, the exact SQL, and a preview of the rows that would be affected —
 * then approves (which enqueues the apply) or rejects (which runs nothing).
 *
 * COMPACT BY DEFAULT (CLAUDE.md). It renders NOTHING when there is nothing pending —
 * no permanent chrome. When something is waiting it is one quiet banner; the SQL and
 * the row preview stay collapsed behind it until the human opens them.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Database } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api/client";

interface Approval {
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
  created_at: string;
}

const POLL_MS = 15_000;

export function ApprovalsPanel() {
  const t = useTranslations("claude");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ approvals: Approval[] }>("/api/claude/approvals?status=pending");
      setApprovals(res.approvals ?? []);
    } catch {
      // A failed poll is silent: the banner is an addition to the screen, and a
      // transient backend hiccup must not throw an error toast every 15 seconds.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const decide = useCallback(
    async (approval: Approval, decision: "approve" | "reject") => {
      setBusyId(approval.id);
      try {
        await api(`/api/claude/approvals/${approval.id}/${decision}`, { method: "POST" });
        toast.success(t(decision === "approve" ? "approvals.approved" : "approvals.rejected"));
        // Drop it locally at once so the banner count is right before the next poll.
        setApprovals((prev) => prev.filter((a) => a.id !== approval.id));
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : t("approvals.decideFailed");
        toast.error(msg);
        // Re-sync: a 409 means someone already decided it, so reflect the real state.
        void load();
      } finally {
        setBusyId(null);
      }
    },
    [t, load],
  );

  if (approvals.length === 0) return null;

  return (
    <div className="border-b bg-status-warn-bg/40">
      {/* The one quiet row. Opening reveals the details; nothing has run yet. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs"
      >
        <AlertTriangle className="size-3.5 shrink-0 text-status-warn" />
        <span className="min-w-0 flex-1 text-start font-medium" dir="auto">
          {t("approvals.banner", { count: approvals.length })}
        </span>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
      </button>

      {open && (
        <div className="max-h-96 space-y-2 overflow-y-auto px-3 pb-3">
          {approvals.map((a) => {
            const isExpanded = expandedId === a.id;
            const count = a.payload?.affected_count ?? null;
            const sample = Array.isArray(a.payload?.sample_rows) ? a.payload!.sample_rows! : [];
            const busy = busyId === a.id;
            return (
              <div key={a.id} className="rounded-lg border bg-background p-2.5">
                <div className="flex items-start gap-2">
                  <Database className="mt-0.5 size-3.5 shrink-0 text-status-warn" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium leading-snug" dir="auto">
                      {a.title}
                    </p>
                    {a.payload?.migration_path && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" dir="ltr">
                        {a.payload.repo ? `${a.payload.repo} · ` : ""}
                        {a.payload.migration_path}
                      </p>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : a.id)}
                  className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {t("approvals.showDetails")}
                </button>

                {isExpanded && (
                  <div className="mt-2 space-y-2">
                    {a.payload?.sql && (
                      <div>
                        <p className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                          SQL
                        </p>
                        <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed" dir="ltr">
                          {a.payload.sql}
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
                    onClick={() => void decide(a, "approve")}
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : t("approvals.approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1 text-xs"
                    disabled={busy}
                    onClick={() => void decide(a, "reject")}
                  >
                    {t("approvals.reject")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
