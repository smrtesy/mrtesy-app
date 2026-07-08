"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Sunrise, X } from "lucide-react";
import { todayISO } from "@/lib/workdays";

// Per-day marker: "the morning inbox landing already happened today". Visiting
// either the inbox or the tasks screen sets it, so the redirect fires at most
// once a day and never loops.
const LANDING_KEY = "smrttask:morningLanding";
const DISMISS_KEY = "smrttask:morningDismissed";

/**
 * Soft morning nudge: the first time the working surface (/tasks) is opened on
 * a new day, bounce once to the inbox so the day starts with triage — not the
 * desk. It's a nudge, not a lock: after the single redirect the day's marker is
 * set, so navigating back to /tasks stays put.
 */
export function MorningInboxRedirect({ locale }: { locale: string }) {
  const router = useRouter();
  useEffect(() => {
    const today = todayISO();
    if (localStorage.getItem(LANDING_KEY) === today) return;
    localStorage.setItem(LANDING_KEY, today);
    router.replace(`/${locale}/inbox`);
  }, [router, locale]);
  return null;
}

/**
 * "Start your day" banner shown on the inbox. Greets and names the four triage
 * actions (pick for today · give a date · file by level · drop). Auto-appears
 * once per day and collapses when dismissed — quiet by default per the UI rules.
 * Also stamps the landing marker so opening the inbox directly counts as the
 * morning landing (and won't later trigger the /tasks redirect).
 */
export function MorningStartBanner() {
  const t = useTranslations("suggestions");
  const tCommon = useTranslations("common");
  const [show, setShow] = useState(false);

  useEffect(() => {
    const today = todayISO();
    localStorage.setItem(LANDING_KEY, today);
    setShow(localStorage.getItem(DISMISS_KEY) !== today);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, todayISO());
    setShow(false);
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-primary/25 bg-primary/5 p-3">
      <div className="mt-0.5 rounded-full bg-primary/10 p-1.5">
        <Sunrise className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground" dir="auto">{t("morningTitle")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground" dir="auto">{t("morningHint")}</p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={tCommon("close")}
        title={tCommon("close")}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
