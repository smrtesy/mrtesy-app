"use client";

/**
 * Floating chip + global modal host for background merge jobs.
 *
 * Mounted ONCE in the locale layout. Reads `useMergeJob()` state and:
 *
 *   - phase='running' : renders a yellow pulsing chip "🤖 AI מסיים מיזוג..."
 *     Click does nothing visible (the user is told to wait).
 *
 *   - phase='ready'   : renders a green chip "✓ מיזוג מוכן — פתח".
 *     Click consumes the job (provider → idle) and opens the global
 *     MergeModal with the proposal pre-applied at step 2.
 *
 *   - phase='error'   : renders a red chip with the error message.
 *     Click clears the job.
 *
 *   - phase='idle'    : renders nothing.
 *
 * The chip is fixed to the top-left in RTL and top-right in LTR, just
 * under the Toaster so they don't collide. z-index above sticky headers.
 *
 * The modal that opens from here uses the same <MergeModal> component
 * used inline by the suggestions screens. After a successful merge it
 * dispatches MERGE_COMPLETED_EVENT so any mounted list can refetch.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Sparkles, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { useMergeJob, dispatchMergeCompleted, type MergeJobContext, type MergeJobProposal } from "@/contexts/MergeJobContext";
import { MergeModal, type MergeInitialState } from "@/components/smrttask/merge/MergeModal";

interface BackgroundMergeChipProps {
  locale: string;
}

export function BackgroundMergeChip({ locale }: BackgroundMergeChipProps) {
  const t = useTranslations("merge");
  const { state, consume, clear } = useMergeJob();

  // When the user clicks a 'ready' chip we consume the job (provider goes
  // back to idle) and stash the snapshot here so we can drive MergeModal.
  // Keeping it in local state means a second background job can start
  // running while this modal is still open without clobbering the view.
  const [openSnapshot, setOpenSnapshot] = useState<
    { ctx: MergeJobContext; proposal: MergeJobProposal } | null
  >(null);

  if (state.phase === "idle" && !openSnapshot) return null;

  const dir = locale === "he" ? "rtl" : "ltr";
  const positionClass = dir === "rtl"
    ? "fixed top-14 right-3 sm:right-4"
    : "fixed top-14 left-3 sm:left-4";

  // ── chip ────────────────────────────────────────────────────────────────
  let chip: React.ReactNode = null;
  if (state.phase === "running") {
    chip = (
      <button
        type="button"
        className="flex items-center gap-2 rounded-full border border-status-warn/30 bg-status-warn-bg px-3 py-1.5 text-sm shadow-lg hover:bg-status-warn-bg/80 transition-colors"
        title={t("chipRunningTooltip")}
      >
        <Sparkles className="h-4 w-4 text-status-warn animate-pulse" />
        <span className="text-status-warn">{t("chipRunning")}</span>
      </button>
    );
  } else if (state.phase === "ready") {
    chip = (
      <button
        type="button"
        onClick={() => {
          const snap = consume();
          if (snap) setOpenSnapshot(snap);
        }}
        className="flex items-center gap-2 rounded-full border border-status-ok/30 bg-status-ok-bg px-3 py-1.5 text-sm shadow-lg hover:bg-status-ok-bg/80 transition-colors animate-in fade-in slide-in-from-top-2"
      >
        <CheckCircle2 className="h-4 w-4 text-status-ok" />
        <span className="text-status-ok font-medium">{t("chipReady")}</span>
      </button>
    );
  } else if (state.phase === "error") {
    chip = (
      <div className="flex items-center gap-2 rounded-full border border-status-late/30 bg-status-late-bg px-3 py-1.5 text-sm shadow-lg">
        <AlertTriangle className="h-4 w-4 text-status-late" />
        <span className="text-status-late">{t("chipError")}</span>
        <button
          type="button"
          onClick={clear}
          className="text-status-late hover:text-status-late/80"
          title={t("chipDismiss")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <>
      {chip && (
        <div className={`${positionClass} z-50`} dir={dir}>
          {chip}
        </div>
      )}

      {openSnapshot && (
        <MergeModal
          open={true}
          onClose={() => setOpenSnapshot(null)}
          sources={openSnapshot.ctx.sources}
          initialState={
            {
              proposal: openSnapshot.proposal,
              targetMode: openSnapshot.ctx.targetMode,
              existingTargetId: openSnapshot.ctx.existingTargetId,
              sources: openSnapshot.ctx.sources,
            } satisfies MergeInitialState
          }
          locale={locale}
          onMerged={(result) => {
            const itemCount = (result.task?.checklist as unknown[] | undefined)?.length ?? 0;
            toast.success(itemCount > 0
              ? t("successToastWithChecklist", { count: itemCount })
              : t("successToast"));
            dispatchMergeCompleted();
            setOpenSnapshot(null);
          }}
          // No onMinimize here — once consumed, the only way back to
          // background mode is to close and re-trigger from a list page.
        />
      )}
    </>
  );
}
