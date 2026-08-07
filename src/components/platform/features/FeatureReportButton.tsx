"use client";

/**
 * Source 2 of the feature log (docs/feature-channels-plan.md §8) — a proactive
 * "report a problem" button, visible to EVERY user (beta and stable alike).
 *
 * Discreet by default (compact-UI principle): a small, low-key floating icon in
 * the corner that expands into a dialog only on click. The dialog follows the
 * CorrectionDialog pattern — one free-text field ("what were you trying to do?")
 * plus a read-only preview of everything the report will carry (screen, feature,
 * recent console errors, failed requests, full URL, app version, channel,
 * browser). Privacy is the point: the user SEES the payload before it is sent,
 * which matters most for thin-client customers. On send it goes to the shared
 * log sink (POST /api/client-errors, category='feature_report') via
 * submitFeatureReport — no new endpoint.
 *
 * Automatic screenshot is intentionally deferred for v1 (would need a new npm
 * dependency such as html2canvas). The hook is left in `report.screenshot` so it
 * can be filled in later without changing the payload shape or the server.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Flag } from "lucide-react";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppAccess } from "@/contexts/AppAccessContext";
import {
  getRecentClientEvents,
  submitFeatureReport,
  type RecentClientEvent,
} from "@/lib/error-capture";
import { useCurrentFeatureId } from "./FeatureIdContext";

/** The context the report carries — assembled when the dialog opens and shown to
 *  the user verbatim before they send. */
interface CollectedContext {
  full_url: string;
  screen_key: string;
  feature_id: string | null;
  channel: string;
  app_commit: string | null;
  user_agent: string;
  recent_events: RecentClientEvent[];
  /** v1: always null — automatic screenshot is deferred (see file header). */
  screenshot: null;
}

function stripLocaleFromPath(pathname: string): string {
  return pathname.replace(/^\/(he|en)(?=\/|$)/, "") || "/";
}

export function FeatureReportButton({
  variant = "floating",
}: {
  /** "floating" = the discreet fixed corner flag (now mobile-only — the desktop
   *  entry point moved into the sidebar Claude row). "inline" = an icon button
   *  matching the sidebar search split. */
  variant?: "floating" | "inline";
} = {}) {
  const t = useTranslations("featureReport");
  const { channel } = useAppAccess();
  const featureId = useCurrentFeatureId();

  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ctx, setCtx] = useState<CollectedContext | null>(null);

  // Collect the context the moment the dialog opens (a fresh snapshot every time),
  // and reset the field. The app commit is best-effort from the Vercel deploy-info
  // route; a failure just leaves it null.
  useEffect(() => {
    if (!open) return;
    setDescription("");
    setSubmitting(false);
    const pathname = window.location.pathname;
    const base: CollectedContext = {
      full_url: window.location.href,
      screen_key: stripLocaleFromPath(pathname),
      feature_id: featureId,
      channel,
      app_commit: null,
      user_agent: navigator.userAgent,
      recent_events: getRecentClientEvents(),
      screenshot: null,
    };
    setCtx(base);
    let cancelled = false;
    fetch("/api/deploy-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { commit_short?: string | null } | null) => {
        if (cancelled || !info?.commit_short) return;
        setCtx((prev) => (prev ? { ...prev, app_commit: info.commit_short ?? null } : prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, channel, featureId]);

  async function handleSubmit() {
    if (!ctx || !description.trim() || submitting) return;
    setSubmitting(true);
    // Re-snapshot recent events at send time so anything that failed while the
    // dialog was open is included too.
    const report = { ...ctx, recent_events: getRecentClientEvents() };
    const ok = await submitFeatureReport({
      featureId: ctx.feature_id,
      screenKey: ctx.screen_key,
      description: description.trim(),
      report,
    });
    setSubmitting(false);
    if (ok) {
      toast.success(t("sent"));
      setOpen(false);
    } else {
      toast.error(t("sendFailed"));
    }
  }

  const errorEvents = ctx?.recent_events.filter((e) => e.type !== "api") ?? [];
  const apiEvents = ctx?.recent_events.filter((e) => e.type === "api") ?? [];

  return (
    <>
      {variant === "inline" ? (
        // Sidebar Claude-row entry point — mirrors the search split beside it.
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={() => setOpen(true)}
          title={t("open")}
          aria-label={t("open")}
          className="shrink-0"
        >
          <Flag className="h-4 w-4" />
        </Button>
      ) : (
        // Discreet floating trigger. On mobile it is the entry point (no
        // sidebar there). On desktop it is a FALLBACK: globals.css hides it
        // unless the sidebar is collapsed (data-feature-report-floating rule) —
        // because when the sidebar is open, its inline variant in the Claude row
        // is the entry point, and when collapsed the inline one hides with the
        // aside. Raised above the mobile bottom nav (pb-20 on the main content).
        <button
          type="button"
          data-feature-report-floating
          onClick={() => setOpen(true)}
          title={t("open")}
          aria-label={t("open")}
          className="fixed bottom-24 end-3 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground opacity-50 shadow-sm backdrop-blur transition-opacity hover:opacity-100 md:bottom-4"
        >
          <Flag className="h-4 w-4" />
        </button>
      )}

      <Dialog open={open} onOpenChange={(o) => { if (!submitting) setOpen(o); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* What were you trying to do? */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("descriptionLabel")}</p>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                rows={3}
                dir="auto"
                autoFocus
              />
            </div>

            {/* Read-only preview of what will be sent — privacy: the user sees the
                payload before pressing send. */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("previewLabel")}</p>
              <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-md border bg-muted/40 p-2.5 text-[11px]" dir="ltr">
                <PreviewRow label={t("fieldScreen")} value={ctx?.screen_key ?? "—"} />
                <PreviewRow label={t("fieldFeature")} value={ctx?.feature_id ?? "—"} />
                <PreviewRow label={t("fieldChannel")} value={ctx?.channel ?? "—"} />
                <PreviewRow label={t("fieldVersion")} value={ctx?.app_commit ?? "—"} />
                <PreviewRow label={t("fieldUrl")} value={ctx?.full_url ?? "—"} />
                <PreviewRow label={t("fieldBrowser")} value={ctx?.user_agent ?? "—"} />
                <PreviewRow
                  label={t("fieldConsoleErrors")}
                  value={errorEvents.length ? errorEvents.map((e) => e.message).join(" | ") : t("none")}
                />
                <PreviewRow
                  label={t("fieldFailedRequests")}
                  value={
                    apiEvents.length
                      ? apiEvents.map((e) => `${e.status ?? "?"} ${e.method ?? ""} ${e.url ?? ""}`.trim()).join(" | ")
                      : t("none")
                  }
                />
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t("privacyNote")}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
              {t("cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || !description.trim()}>
              {submitting ? t("sending") : t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <span className="shrink-0 font-medium text-muted-foreground">{label}:</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}
