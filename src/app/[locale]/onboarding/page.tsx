"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail, Calendar, Loader2 } from "lucide-react";
import { api, setActiveOrgId, ApiError } from "@/lib/api/client";
import { navigateTop } from "@/lib/navigate";

export default function OnboardingStep1() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();
  // Gate rendering until we've decided whether this is a project-only worker
  // (who skips the whole source-connection + scan flow) or a full user.
  const [ready, setReady] = useState(false);

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

        // Project-only ("lite") worker: they have no data sources to connect and
        // nothing to scan. Skip the entire connect+scan onboarding — mark it done
        // and drop them straight into their task list. This is what fixes an
        // invited worker being pushed through the sync screen (and hitting the
        // permission error on "scan"). If the access check fails (e.g. no
        // smrtTask grant at all) we fall through to the normal flow.
        let isLite = false;
        try {
          const { access_level } = await api<{ access_level: string }>("/api/tasks/access");
          isLite = access_level === "lite";
        } catch (accessErr) {
          if (!(accessErr instanceof ApiError && accessErr.status === 403)) {
            console.error("[onboarding] access check failed:", accessErr);
          }
        }
        if (isLite) {
          // Commit to the lite path: mark onboarding done and go to tasks. Never
          // fall back to the source-connection flow (a lite worker can't finish
          // it). If the settings write fails transiently, still route to /tasks —
          // the layout re-runs this page and retries, so it self-heals rather
          // than stranding the worker on a Gmail step they can't complete.
          try {
            await api("/api/me/settings", {
              method: "PATCH",
              body: { onboarding_completed: true },
              noOrg: true,
            });
          } catch (patchErr) {
            console.error("[onboarding] completing lite onboarding failed:", patchErr);
          }
          router.replace(`/${locale}/tasks`);
          return;
        }
        setReady(true);
      } catch (e) {
        // If auth check failed, the middleware will already redirect to /login.
        if (!(e instanceof ApiError && e.status === 401)) {
          console.error("[onboarding] org check failed:", e);
        }
        setReady(true);
      }
    })();
  }, [router, locale]);

  function handleConnect() {
    navigateTop("/api/auth/google?service=gmail_calendar");
  }

  function handleSkip() {
    router.push(`/${locale}/onboarding/drive`);
  }

  // Hold the UI until we know whether to skip the flow entirely (lite worker),
  // so a project-only worker never sees the "connect Gmail" step flash by.
  if (!ready) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
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
