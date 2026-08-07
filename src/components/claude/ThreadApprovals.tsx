"use client";

/**
 * The IN-THREAD side of the hybrid approval display
 * (docs/claude-console/autonomy-safety-gate.md).
 *
 * When Claude routes a destructive migration to a human, the decision belongs in
 * the conversation that raised it — that is where the human can read what Claude
 * did and why before approving. This renders the FULL decision card (SQL, row
 * preview, Approve / Reject) at the top of the open thread's conversation, for
 * every pending approval whose `thread_id` matches this thread. The org-wide
 * ApprovalsPanel keeps a short pointer to here so the gate stays visible
 * platform-wide.
 *
 * Renders NOTHING when this thread has no pending approvals (compact by default).
 */

import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";

import { usePendingApprovals, ApprovalCard } from "./ApprovalCard";

export function ThreadApprovals({ threadId }: { threadId: string | null }) {
  const t = useTranslations("claudeChat");
  const { approvals, reload, remove } = usePendingApprovals();

  if (!threadId) return null;
  const mine = approvals.filter((a) => a.thread_id === threadId);
  if (mine.length === 0) return null;

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-status-warn/40 bg-status-warn-bg/40 p-2.5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-3.5 shrink-0 text-status-warn" />
        <p className="min-w-0 flex-1 text-xs font-medium" dir="auto">
          {t("approvals.inThreadIntro")}
        </p>
      </div>
      {mine.map((a) => (
        <ApprovalCard key={a.id} approval={a} t={t} onDecided={remove} onError={reload} />
      ))}
    </div>
  );
}
