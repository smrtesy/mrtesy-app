"use client";

/**
 * The ORG-WIDE side of the hybrid approval display
 * (docs/claude-console/autonomy-safety-gate.md).
 *
 * The in-app Claude does reversible work on its own; the ONE thing it routes to a
 * human is a DESTRUCTIVE migration. Those land as `pending` rows in
 * claude_action_approvals and MUST stay visible org-wide — a safety gate that
 * hides from another admin or a background session is no gate at all.
 *
 * But org-wide no longer means a full card out of context: the decision belongs
 * in the conversation that raised it (ThreadApprovals, inside ClaudeChat), where
 * the human can see what Claude did and why. So this panel is a short list of
 * POINTERS — one quiet row per pending migration, each linking to its thread.
 * The full SQL / preview / Approve / Reject live in-thread.
 *
 * Fallback: an approval with no thread (a legacy row, or a run we couldn't link)
 * has nowhere to point, so it renders its full decision card here inline — it
 * must still be actionable.
 *
 * COMPACT BY DEFAULT (CLAUDE.md): renders NOTHING when the queue is empty.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ChevronDown, ChevronRight, Database } from "lucide-react";

import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { usePendingApprovals, ApprovalCard } from "./ApprovalCard";

export function ApprovalsPanel({ locale }: { locale: string }) {
  const t = useTranslations("claudeChat");
  const { approvals, reload, remove } = usePendingApprovals();
  const [open, setOpen] = useState(false);

  if (approvals.length === 0) return null;

  return (
    <div className="border-b bg-status-warn-bg/40">
      {/* The one quiet row. Opening reveals the pointers; nothing has run yet. */}
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
          {approvals.map((a) =>
            a.thread_id ? (
              // Pointer: the decision lives in the thread. One click lands there.
              <div
                key={a.id}
                className="flex items-center gap-2 rounded-lg border bg-background p-2.5"
              >
                <Database className="size-3.5 shrink-0 text-status-warn" />
                <p className="min-w-0 flex-1 truncate text-xs font-medium" dir="auto">
                  {a.title}
                </p>
                <OpenTabLink
                  href={`/${locale}/claude?thread=${a.thread_id}`}
                  label={t("approvals.openInThread")}
                  className="shrink-0 whitespace-nowrap text-[11px] font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  {t("approvals.openInThread")}
                </OpenTabLink>
              </div>
            ) : (
              // No thread to point at — keep the full decision here so it stays
              // actionable.
              <ApprovalCard key={a.id} approval={a} t={t} onDecided={remove} onError={reload} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
