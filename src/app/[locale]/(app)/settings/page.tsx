"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  LogOut, Mail, FolderOpen, MessageCircle, Calendar,
  CheckCircle2, XCircle, RefreshCw, Trash2, RotateCcw, Shield,
  Loader2, Filter, Repeat,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface ConnectionStatus {
  gmail: boolean;
  drive: boolean;
  calendar: boolean;
  whatsapp: boolean;
}

const connections = [
  { key: "gmail" as keyof ConnectionStatus, label: "Gmail", icon: Mail, color: "text-red-500" },
  { key: "drive" as keyof ConnectionStatus, label: "Google Drive", icon: FolderOpen, color: "text-green-500" },
  { key: "calendar" as keyof ConnectionStatus, label: "Calendar", icon: Calendar, color: "text-blue-500" },
  { key: "whatsapp" as keyof ConnectionStatus, label: "WhatsApp", icon: MessageCircle, color: "text-emerald-500" },
] as const;

export default function SettingsPage() {
  const t = useTranslations("settings");
  const tAuth = useTranslations("auth");
  const { locale } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const [connStatus, setConnStatus] = useState<ConnectionStatus>({
    gmail: false, drive: false, calendar: false, whatsapp: false,
  });
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasSmrtTask, setHasSmrtTask] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resyncLoading, setResyncLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", user.id)
        .single();
      const { data: creds } = await supabase
        .from("user_credentials")
        .select("service")
        .eq("user_id", user.id);

      const serviceTypes = (creds || []).map((c: { service: string }) => c.service);
      setConnStatus({
        gmail: serviceTypes.includes("gmail_calendar") || data?.gmail_connected,
        drive: serviceTypes.includes("drive") || data?.drive_connected,
        calendar: serviceTypes.includes("gmail_calendar") || data?.calendar_connected,
        whatsapp: data?.whatsapp_connected ?? false,
      });

      // Check admin
      const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase());
      setIsAdmin(adminEmails.includes(user.email?.toLowerCase() || ""));

      // Check if active org has smrtTask enabled
      const { data: memberships } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .limit(10);

      if (memberships && memberships.length > 0) {
        const orgIds = memberships.map((m: { org_id: string }) => m.org_id);
        const { data: appRows } = await supabase
          .from("app_memberships")
          .select("apps!inner(slug)")
          .in("org_id", orgIds)
          .eq("apps.slug", "smrtesy");
        const found = (appRows ?? []).some((r: { apps: unknown }) => {
          const app = Array.isArray(r.apps) ? r.apps[0] : r.apps;
          return (app as { slug?: string } | null)?.slug === "smrtesy";
        });
        setHasSmrtTask(found);
      }
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push(`/${locale}/login`);
  }

  async function switchLanguage() {
    const newLocale = locale === "he" ? "en" : "he";
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("user_settings")
        .update({ preferred_language: newLocale })
        .eq("user_id", user.id);
    }
    router.push(`/${newLocale}/settings`);
  }

  async function handleResetData() {
    if (!resetConfirm) {
      setResetConfirm(true);
      return;
    }
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>

      {/* Organization */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("organization")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Link href={`/${locale}/settings/org`}>
            <Button variant="outline" className="min-h-[48px] w-full sm:w-auto">
              {t("manageOrgAndMembers")}
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Language */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("language")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={switchLanguage} className="min-h-[48px]">
            {t("switchLang")}
          </Button>
        </CardContent>
      </Card>

      {/* smrtTask-specific sections — only shown when org has smrtTask enabled */}
      {hasSmrtTask && (
        <>
          {/* Connections */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("connections")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {connections.map((conn) => {
                const connected = connStatus[conn.key];
                return (
                  <div key={conn.key} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <conn.icon className={`h-5 w-5 ${conn.color}`} />
                      <span className="text-sm font-medium">{conn.label}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {connected ? (
                        <Badge variant="default" className="gap-1 bg-green-500">
                          <CheckCircle2 className="h-3 w-3" />
                          {t("connected")}
                        </Badge>
                      ) : (
                        <>
                          <Badge variant="secondary" className="gap-1">
                            <XCircle className="h-3 w-3" />
                            {t("disconnected")}
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1"
                            onClick={() => {
                              const serviceMap: Record<string, string> = {
                                gmail: "gmail_calendar",
                                drive: "drive",
                                calendar: "gmail_calendar",
                                whatsapp: "",
                              };
                              const svc = serviceMap[conn.key];
                              if (conn.key === "whatsapp") {
                                window.location.href = `/${locale}/onboarding/whatsapp?redirect=settings`;
                              } else if (svc) {
                                window.location.href = `/api/auth/google?service=${svc}&redirect=settings`;
                              }
                            }}
                          >
                            <RefreshCw className="h-3 w-3" />
                            {t("reconnect")}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Rules + Sync */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("rulesAndAutomation")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              <Link href={`/${locale}/settings/rules`}>
                <Button variant="outline" className="min-h-[48px] w-full gap-2 justify-start">
                  <Filter className="h-4 w-4" />
                  {t("skipRulesAndStyle")}
                </Button>
              </Link>
              <Link href={`/${locale}/settings/sync`}>
                <Button variant="outline" className="min-h-[48px] w-full gap-2 justify-start">
                  <Repeat className="h-4 w-4" />
                  {t("syncSchedules")}
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Data Management */}
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
        </>
      )}

      {/* Admin link (mobile access) */}
      {isAdmin && (
        <Card>
          <CardContent className="p-4">
            <Link
              href={`/${locale}/admin`}
              className="flex items-center gap-3 text-sm font-medium text-primary hover:underline"
            >
              <Shield className="h-5 w-5" />
              {t("adminPanel")}
            </Link>
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* Sign Out */}
      <Button
        variant="destructive"
        onClick={handleSignOut}
        className="w-full min-h-[48px] gap-2"
      >
        <LogOut className="h-4 w-4" />
        {tAuth("signOut")}
      </Button>
    </div>
  );
}
