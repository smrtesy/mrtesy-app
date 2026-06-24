"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail, Calendar } from "lucide-react";
import { api, setActiveOrgId, ApiError } from "@/lib/api/client";
import { navigateTop } from "@/lib/navigate";

export default function OnboardingStep1() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();

  // Defensive: if the user somehow reached this step without an org
  // (e.g. older account from before this onboarding flow existed), bounce
  // them through the workspace step first.
  useEffect(() => {
    (async () => {
      try {
        const { orgs } = await api<{ orgs: Array<{ id: string }> }>(
          "/api/orgs/me",
          { noOrg: true },
        );
        if (!orgs || orgs.length === 0) {
          router.replace(`/${locale}/onboarding/organization`);
          return;
        }
        // Make sure an active org is selected so the next API calls carry X-Org-Id.
        setActiveOrgId(orgs[0].id);
      } catch (e) {
        // If auth check failed, the middleware will already redirect to /login.
        if (!(e instanceof ApiError && e.status === 401)) {
          console.error("[onboarding] org check failed:", e);
        }
      }
    })();
  }, [router, locale]);

  function handleConnect() {
    navigateTop("/api/auth/google?service=gmail_calendar");
  }

  function handleSkip() {
    router.push(`/${locale}/onboarding/drive`);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-accent">
          <Mail className="h-8 w-8 text-primary" />
        </div>
        <CardTitle>{t("step1.title")}</CardTitle>
        <CardDescription>{t("step1.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Mail className="h-5 w-5 text-status-late" />
          <span className="flex-1">Gmail</span>
          <span className="text-xs text-muted-foreground">gmail.modify</span>
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Calendar className="h-5 w-5 text-primary" />
          <span className="flex-1">Google Calendar</span>
          <span className="text-xs text-muted-foreground">calendar</span>
        </div>
        <Button onClick={handleConnect} className="w-full min-h-[48px]">
          {t("connect")}
        </Button>
        <Button onClick={handleSkip} variant="ghost" className="w-full min-h-[48px]">
          {t("skip")}
        </Button>
        <div className="flex justify-center gap-2 pt-2">
          <div className="h-2 w-8 rounded-full bg-primary" />
          <div className="h-2 w-8 rounded-full bg-muted" />
          <div className="h-2 w-8 rounded-full bg-muted" />
          <div className="h-2 w-8 rounded-full bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}
