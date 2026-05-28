"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Filter, Repeat, SlidersHorizontal, RotateCcw, Trash2, Loader2 } from "lucide-react";
import { SmrtName } from "@/components/icons/SmrtName";
import { APPS, getApp } from "@/lib/apps/registry";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { SettingsForm as SmrtVoiceSettingsForm } from "@/components/smrtvoice/SettingsForm";

interface Props {
  enabledApps: string[];
  appSlug?: string;
}

export function AppsTabPanel({ enabledApps, appSlug }: Props) {
  const t = useTranslations("settingsTabs");
  const { locale } = useParams() as { locale: string };
  const pathname = usePathname();

  // Active app: prop > first enabled app in registry order
  const orderedEnabled = Object.keys(APPS).filter((slug) => enabledApps.includes(slug));
  const initialSlug = appSlug && orderedEnabled.includes(appSlug)
    ? appSlug
    : orderedEnabled[0];
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(initialSlug);

  useEffect(() => { if (initialSlug) setSelectedSlug(initialSlug); }, [initialSlug]);

  if (orderedEnabled.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {t("noAppsEnabled")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* App sub-tabs */}
      <div className="flex gap-1 overflow-x-auto -mx-4 md:-mx-6 px-4 md:px-6">
        {orderedEnabled.map((slug) => {
          const app = APPS[slug];
          const isActive = selectedSlug === slug;
          return (
            <button
              key={slug}
              type="button"
              onClick={() => setSelectedSlug(slug)}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              <app.Icon className="h-4 w-4" />
              <SmrtName word={app.word} />
            </button>
          );
        })}
      </div>

      {selectedSlug && (
        <AppSettings
          slug={selectedSlug}
          locale={locale}
          pathname={pathname}
        />
      )}
    </div>
  );
}

function AppSettings({ slug, locale, pathname }: {
  slug: string;
  locale: string;
  pathname: string;
}) {
  if (slug === "smrttask") {
    return <SmrtTaskSettings locale={locale} pathname={pathname} />;
  }
  if (slug === "smrtvoice") {
    return (
      <Card>
        <CardContent className="p-4 md:p-6">
          <SmrtVoiceSettingsForm />
        </CardContent>
      </Card>
    );
  }
  // Unknown app — defensive
  const app = getApp(slug);
  return (
    <Card>
      <CardContent className="p-6 text-sm text-muted-foreground">
        {app ? `No settings UI registered for ${app.slug}` : `Unknown app: ${slug}`}
      </CardContent>
    </Card>
  );
}

function SmrtTaskSettings({ locale, pathname }: {
  locale: string;
  pathname: string;
}) {
  const t = useTranslations("settings");
  const supabase = createClient();
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resyncLoading, setResyncLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  async function handleResync() {
    setResyncLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      await supabase.from("user_settings").update({
        onboarding_completed: false,
        initial_scan_started_at: null,
        initial_scan_completed_at: null,
        initial_setup_completed: false,
      }).eq("user_id", user.id);
      window.location.href = `/${locale}/onboarding`;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setResyncLoading(false);
    }
  }

  async function handleResetData() {
    if (!resetConfirm) { setResetConfirm(true); return; }
    setResetLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const uid = user.id;
      await supabase.from("task_activities").delete().eq("user_id", uid);
      await supabase.from("reminders").delete().eq("user_id", uid);
      await supabase.from("project_briefs").delete().eq("user_id", uid);
      await supabase.from("tasks").delete().eq("user_id", uid);
      await supabase.from("projects").delete().eq("user_id", uid);
      await supabase.from("contacts").delete().eq("user_id", uid);
      await supabase.from("log_entries").delete().eq("user_id", uid);
      await supabase.from("source_messages").delete().eq("user_id", uid);
      await supabase.from("sync_state").delete().eq("user_id", uid);
      await supabase.from("user_settings").update({
        initial_scan_started_at: null,
        initial_scan_completed_at: null,
        initial_setup_completed: false,
        onboarding_completed: false,
      }).eq("user_id", uid);
      toast.success(t("dataDeletedRedirecting"));
      setResetConfirm(false);
      setTimeout(() => { window.location.href = `/${locale}/onboarding`; }, 1500);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setResetLoading(false);
    }
  }

  const base = `/${locale}/settings/apps/smrttask`;
  const isLink = (sub: string) => pathname.startsWith(`${base}/${sub}`);

  // The actual rules/sync/parameters pages live at the deep links; this
  // panel renders a launcher (cards) when not focused, and matches the
  // legacy /settings UX for smrtTask.
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("rulesAndAutomation")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          <Link href={`${base}/rules`}>
            <Button
              variant={isLink("rules") ? "default" : "outline"}
              className="min-h-[48px] w-full gap-2 justify-start"
            >
              <Filter className="h-4 w-4" />
              {t("skipRulesAndStyle")}
            </Button>
          </Link>
          <Link href={`${base}/sync`}>
            <Button
              variant={isLink("sync") ? "default" : "outline"}
              className="min-h-[48px] w-full gap-2 justify-start"
            >
              <Repeat className="h-4 w-4" />
              {t("syncSchedules")}
            </Button>
          </Link>
          <Link href={`${base}/parameters`}>
            <Button
              variant={isLink("parameters") ? "default" : "outline"}
              className="min-h-[48px] w-full gap-2 justify-start sm:col-span-2"
            >
              <SlidersHorizontal className="h-4 w-4" />
              {t("classifierParameters")}
            </Button>
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("dataManagement")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="outline"
            onClick={handleResync}
            disabled={resyncLoading}
            className="w-full min-h-[48px] gap-2"
          >
            {resyncLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            {t("resync")}
          </Button>
          <Button
            variant={resetConfirm ? "destructive" : "outline"}
            onClick={handleResetData}
            disabled={resetLoading}
            className="w-full min-h-[48px] gap-2"
          >
            {resetLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {resetConfirm ? t("confirmDeletion") : t("deleteAllData")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
