"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { api, setActiveOrgId, ApiError } from "@/lib/api/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Step 0 of onboarding — name your workspace.
 *
 * Creates the user's first organization, enables the smrtesy app on it, and
 * sets it as the active org in localStorage so subsequent screens (Gmail/Drive)
 * are scoped correctly. If the user already has any org (e.g. they refreshed
 * after creating it), we skip straight to the next step.
 */
export default function OnboardingOrganizationStep() {
  const { locale } = useParams() as { locale: string };
  const router = useRouter();
  const supabase = createClient();
  const isHe = locale === "he";
  const tOrg = useTranslations("onboardingOrg");

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(true);

  // Skip-if-already-has-org + smart default name
  useEffect(() => {
    (async () => {
      try {
        // If user already has any org, jump to the next step.
        const { orgs } = await api<{ orgs: Array<{ id: string }> }>("/api/orgs/me", { noOrg: true });
        if (orgs && orgs.length > 0) {
          setActiveOrgId(orgs[0].id);
          router.replace(`/${locale}/onboarding`);
          return;
        }
      } catch (e) {
        // 401 means session not yet established — let the user proceed; they'll get the error on submit.
        if (!(e instanceof ApiError && e.status === 401)) {
          console.error("orgs/me check:", e);
        }
      }

      // Suggest a default workspace name based on auth metadata.
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const fullName = (user.user_metadata?.full_name as string | undefined)
          ?? (user.user_metadata?.name as string | undefined)
          ?? user.email?.split("@")[0];
        if (fullName) {
          setName(tOrg("defaultWorkspaceName", { fullName }));
        }
      }
      setChecking(false);
    })();
  }, [router, locale, supabase, isHe, tOrg]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(tOrg("enterNameError"));
      return;
    }
    setCreating(true);
    try {
      // 1. Create the org (caller becomes owner)
      const { org } = await api<{ org: { id: string; slug: string } }>("/api/orgs", {
        method: "POST",
        body: { name: trimmed, name_he: isHe ? trimmed : null },
        noOrg: true,
      });

      // 2. Make it the active org so the next API call carries X-Org-Id
      setActiveOrgId(org.id);

      // 3. Enable smrtesy for the new org (best-effort — onboarding can continue without it)
      try {
        await api(`/api/org/apps/smrtesy`, { method: "POST" });
      } catch (e) {
        console.warn("[onboarding] failed to enable smrtesy app:", e);
      }

      toast.success(tOrg("workspaceCreated"));
      router.push(`/${locale}/onboarding`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error creating organization");
    } finally {
      setCreating(false);
    }
  }

  if (checking) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
          <Building2 className="h-8 w-8 text-blue-600" />
        </div>
        <CardTitle>
          {tOrg("title")}
        </CardTitle>
        <CardDescription>
          {tOrg("description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-medium">
            {tOrg("workspaceNameLabel")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={tOrg("workspaceNamePlaceholder")}
            dir="auto"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="min-h-[48px]"
          />
          <p className="text-[11px] text-muted-foreground">
            {tOrg("changeLaterHint")}
          </p>
        </div>

        <Button
          onClick={handleCreate}
          disabled={creating || !name.trim()}
          className="w-full min-h-[48px] gap-2"
        >
          {creating && <Loader2 className="h-4 w-4 animate-spin" />}
          {tOrg("continue")}
        </Button>

        {/* 5-step indicator: org → gmail → drive → whatsapp → setup */}
        <div className="flex justify-center gap-2 pt-2">
          <div className="h-2 w-6 rounded-full bg-blue-600" />
          <div className="h-2 w-6 rounded-full bg-gray-200" />
          <div className="h-2 w-6 rounded-full bg-gray-200" />
          <div className="h-2 w-6 rounded-full bg-gray-200" />
          <div className="h-2 w-6 rounded-full bg-gray-200" />
        </div>
      </CardContent>
    </Card>
  );
}
