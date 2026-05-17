"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { api, setActiveOrgId, ApiError } from "@/lib/api/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Building2, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "";
}

export default function OnboardingOrganizationStep() {
  const { locale } = useParams() as { locale: string };
  const router = useRouter();
  const supabase = createClient();
  const isHe = locale === "he";
  const tOrg = useTranslations("onboardingOrg");

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(true);

  // Skip-if-already-has-org + smart default name
  useEffect(() => {
    (async () => {
      try {
        const { orgs } = await api<{ orgs: Array<{ id: string }> }>("/api/orgs/me", { noOrg: true });
        if (orgs && orgs.length > 0) {
          setActiveOrgId(orgs[0].id);
          router.replace(`/${locale}/onboarding`);
          return;
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) {
          console.error("orgs/me check:", e);
        }
      }

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
  }, [router, locale, supabase, tOrg]);

  // Auto-generate slug from name (unless user edited it manually)
  useEffect(() => {
    if (!slugEdited) {
      setSlug(toSlug(name));
      setSlugStatus("idle");
    }
  }, [name, slugEdited]);

  const checkSlug = useCallback(async (value: string) => {
    if (!value) { setSlugStatus("idle"); return; }
    setSlugStatus("checking");
    try {
      const res = await api<{ available: boolean; reason?: string }>(`/api/orgs/slug-check?slug=${encodeURIComponent(value)}`, { noOrg: true });
      setSlugStatus(res.available ? "available" : (res.reason === "invalid_format" ? "invalid" : "taken"));
    } catch {
      setSlugStatus("idle");
    }
  }, []);

  // Debounce slug check
  useEffect(() => {
    if (!slug) { setSlugStatus("idle"); return; }
    const t = setTimeout(() => checkSlug(slug), 500);
    return () => clearTimeout(t);
  }, [slug, checkSlug]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) { toast.error(tOrg("enterNameError")); return; }
    if (!slug) { toast.error(tOrg("slugRequired")); return; }
    if (slugStatus === "taken") { toast.error(tOrg("slugTaken")); return; }
    if (slugStatus === "invalid") { toast.error(tOrg("slugInvalid")); return; }

    setCreating(true);
    try {
      const { org } = await api<{ org: { id: string; slug: string } }>("/api/orgs", {
        method: "POST",
        body: { name: trimmed, name_he: isHe ? trimmed : null, slug },
        noOrg: true,
      });

      setActiveOrgId(org.id);

      try {
        await api(`/api/org/apps/smrtesy`, { method: "POST" });
      } catch (e) {
        console.warn("[onboarding] failed to enable smrtesy app:", e);
      }

      toast.success(tOrg("workspaceCreated"));
      router.push(`/${locale}/onboarding`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(tOrg("slugTaken"));
        setSlugStatus("taken");
      } else {
        toast.error(e instanceof Error ? e.message : "Error creating organization");
      }
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

  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN;

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
          <Building2 className="h-8 w-8 text-blue-600" />
        </div>
        <CardTitle>{tOrg("title")}</CardTitle>
        <CardDescription>{tOrg("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium">{tOrg("workspaceNameLabel")}</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={tOrg("workspaceNamePlaceholder")}
            dir="auto"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="min-h-[48px]"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium">{tOrg("subdomainLabel")}</label>
          <div className="flex items-center gap-1">
            <Input
              value={slug}
              onChange={(e) => {
                const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
                setSlug(v);
                setSlugEdited(true);
              }}
              placeholder="my-org"
              dir="ltr"
              className="min-h-[48px] font-mono text-sm"
            />
            <div className="w-6 shrink-0 flex justify-center">
              {slugStatus === "checking" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              {slugStatus === "available" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
              {(slugStatus === "taken" || slugStatus === "invalid") && <XCircle className="h-4 w-4 text-red-500" />}
            </div>
          </div>
          {appDomain && slug && (
            <p className="text-[11px] text-muted-foreground font-mono">
              {slug}.{appDomain}
            </p>
          )}
          {slugStatus === "taken" && (
            <p className="text-[11px] text-red-500">{tOrg("slugTaken")}</p>
          )}
          {slugStatus === "invalid" && (
            <p className="text-[11px] text-red-500">{tOrg("slugInvalid")}</p>
          )}
          {slugStatus === "available" && (
            <p className="text-[11px] text-green-600">{tOrg("slugAvailable")}</p>
          )}
        </div>

        <Button
          onClick={handleCreate}
          disabled={creating || !name.trim() || !slug || slugStatus !== "available"}
          className="w-full min-h-[48px] gap-2"
        >
          {creating && <Loader2 className="h-4 w-4 animate-spin" />}
          {tOrg("continue")}
        </Button>

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
