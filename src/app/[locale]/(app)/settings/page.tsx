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
  Loader2,
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
        .select("service_type")
        .eq("user_id", user.id);

      const serviceTypes = (creds || []).map((c: { service_type: string }) => c.service_type);
      setConnStatus({
        gmail: serviceTypes.includes("gmail_calendar") || data?.gmail_connected,
        drive: serviceTypes.includes("drive") || data?.drive_connected,
        calendar: serviceTypes.includes("gmail_calendar") || data?.calendar_connected,
        whatsapp: data?.whatsapp_connected ?? false,
      });

      // Check admin
      const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase());
      setIsAdmin(adminEmails.includes(user.email?.toLowerCase() || ""));
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

      // Delete in correct order (foreign keys)
      await supabase.from("task_activities").delete().eq("user_id", uid);
      await supabase.from("reminders").delete().eq("user_id", uid);
      await supabase.from("tasks").delete().eq("user_id", uid);
      await supabase.from("log_entries").delete().eq("user_id", uid);
      await supabase.from("source_messages").delete().eq("user_id", uid);
      await supabase.from("sync_state").delete().eq("user_id", uid);

      // Reset scan flags
      await supabase.from("user_settings").update({
        initial_scan_started_at: null,
        initial_scan_completed_at: null,
        initial_setup_completed: false,
      }).eq("user_id", uid);

      toast.success(locale === "he" ? "כל הנתונים נמחקו בהצלחה" : "All data deleted successfully");
      setResetConfirm(false);
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

      // Reset initial scan flag so it can run again
      await supabase.from("user_settings").update({
        initial_scan_started_at: null,
        initial_scan_completed_at: null,
      }).eq("user_id", user.id);

      // Call initial-scan edge function
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/initial-scan`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
            "Content-Type": "application/json",
          },
        }
      );
      const result = await resp.json();
      if (result.error) throw new Error(result.error);
      toast.success(
        locale === "he"
          ? `סנכרון הושלם: ${result.gmail_messages || 0} אימיילים, ${result.calendar_events || 0} אירועים`
          : `Sync complete: ${result.gmail_messages || 0} emails, ${result.calendar_events || 0} events`
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setResyncLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>

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

      {/* Data Management */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {locale === "he" ? "ניהול נתונים" : "Data Management"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Re-sync button */}
          <Button
            variant="outline"
            onClick={handleResync}
            disabled={resyncLoading}
            className="w-full min-h-[48px] gap-2"
          >
            {resyncLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            {locale === "he" ? "סנכרון מחדש" : "Re-sync Data"}
          </Button>

          {/* Reset data button */}
          <Button
            variant={resetConfirm ? "destructive" : "outline"}
            onClick={handleResetData}
            disabled={resetLoading}
            className="w-full min-h-[48px] gap-2"
          >
            {resetLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {resetConfirm
              ? (locale === "he" ? "לחץ שוב לאישור מחיקה" : "Click again to confirm deletion")
              : (locale === "he" ? "מחק את כל הנתונים" : "Delete All Data")}
          </Button>
        </CardContent>
      </Card>

      {/* Admin link (mobile access) */}
      {isAdmin && (
        <Card>
          <CardContent className="p-4">
            <Link
              href={`/${locale}/admin`}
              className="flex items-center gap-3 text-sm font-medium text-primary hover:underline"
            >
              <Shield className="h-5 w-5" />
              {locale === "he" ? "פאנל ניהול" : "Admin Panel"}
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
