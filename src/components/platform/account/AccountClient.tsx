"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";
import { navigateTop } from "@/lib/navigate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { OrgSwitcher } from "@/components/platform/layout/OrgSwitcher";
import { NotificationSettings } from "@/components/pwa/NotificationSettings";
import {
  LogOut, Mail, FolderOpen, MessageCircle, Calendar,
  CheckCircle2, XCircle, RefreshCw, Globe,
} from "lucide-react";
import { toast } from "sonner";

function timezoneList(current?: string): string[] {
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
  const list = sv && sv.length > 0 ? [...sv] : ["America/New_York", "Asia/Jerusalem", "Europe/London", "UTC"];
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

interface ConnectionStatus {
  gmail: boolean;
  drive: boolean;
  calendar: boolean;
  whatsapp: boolean;
}

const connections = [
  { key: "gmail" as keyof ConnectionStatus, label: "Gmail", icon: Mail, color: "text-status-late" },
  { key: "drive" as keyof ConnectionStatus, label: "Google Drive", icon: FolderOpen, color: "text-status-ok" },
  { key: "calendar" as keyof ConnectionStatus, label: "Calendar", icon: Calendar, color: "text-primary" },
  { key: "whatsapp" as keyof ConnectionStatus, label: "WhatsApp", icon: MessageCircle, color: "text-status-ok" },
] as const;

export function AccountClient() {
  const t = useTranslations("account");
  const tSettings = useTranslations("settings");
  const tAuth = useTranslations("auth");
  const { locale } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  // The Google OAuth callback redirects here with ?error=save_failed when the
  // credential save failed (the service is deliberately NOT marked connected).
  useEffect(() => {
    if (searchParams.get("error") === "save_failed") {
      toast.error(t("connectionSaveFailed"));
      router.replace(`/${locale}/account`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>({
    gmail: false, drive: false, calendar: false, whatsapp: false,
  });
  const [userEmail, setUserEmail] = useState<string>("");
  const [userName, setUserName] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("");
  // Resolved after mount — during SSR prerender Intl reports the server's
  // timezone, which would mismatch on hydration.
  const [browserTz, setBrowserTz] = useState<string>("");
  useEffect(() => {
    setBrowserTz(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
  }, []);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserEmail(user.email ?? "");
      const md = (user.user_metadata ?? {}) as Record<string, unknown>;
      const name =
        (typeof md.full_name === "string" && md.full_name) ||
        (typeof md.name === "string" && md.name) ||
        "";
      setUserName(name);

      const { data } = await supabase
        .from("user_settings")
        .select("whatsapp_connected, timezone")
        .eq("user_id", user.id)
        .single();
      if (data?.timezone) setTimezone(data.timezone);

      // Mirror the health probe behaviour from the old /settings page:
      // refresh credentials and drop revoked rows so the indicators reflect
      // the live token state rather than stale DB rows.
      let serviceTypes: string[] = [];
      try {
        const health = await api<{ services: string[] }>(
          "/api/me/credentials/health",
          { noOrg: true },
        );
        serviceTypes = health.services ?? [];
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) {
          const { data: creds } = await supabase
            .from("user_credentials")
            .select("service")
            .eq("user_id", user.id);
          serviceTypes = (creds || []).map((c: { service: string }) => c.service);
        }
      }

      setConnStatus({
        gmail: serviceTypes.includes("gmail"),
        drive: serviceTypes.includes("google_drive"),
        calendar: serviceTypes.includes("google_calendar"),
        whatsapp: data?.whatsapp_connected ?? false,
      });
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSignOut() {
    await supabase.auth.signOut();
    // Wipe offline-cached pages/data so the next user on this device can't read
    // them. Use the ready registration's active worker — `controller` is null on
    // first load / hard reload, which would silently skip the wipe.
    try {
      const reg = await navigator.serviceWorker?.ready;
      reg?.active?.postMessage("CLEAR_CACHE");
    } catch {
      /* no SW (dev or unsupported) — nothing cached to clear */
    }
    router.push(`/${locale}/login`);
  }

  async function saveTimezone(tz: string) {
    const prev = timezone;
    setTimezone(tz);
    try {
      await api("/api/me/settings", { method: "PATCH", body: { timezone: tz }, noOrg: true });
      toast.success(t("timezoneSaved"));
    } catch {
      setTimezone(prev);
      toast.error(t("timezoneSaveFailed"));
    }
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
    router.push(`/${newLocale}/account`);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>

      {/* Identity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("identity")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {userName && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("name")}</span>
              <span className="font-medium" dir="auto">{userName}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t("email")}</span>
            <span className="font-medium" dir="ltr">{userEmail}</span>
          </div>
        </CardContent>
      </Card>

      {/* Organization */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("organization")}</CardTitle>
        </CardHeader>
        <CardContent>
          <OrgSwitcher locale={typeof locale === "string" ? locale : "he"} />
        </CardContent>
      </Card>

      {/* Connections */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{tSettings("connections")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {connections.map((conn) => {
            const connected = connStatus[conn.key];
            return (
              <div key={conn.key}>
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <conn.icon className={`h-5 w-5 shrink-0 ${conn.color}`} />
                    <span className="text-sm font-medium truncate">{conn.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {connected ? (
                      <Badge variant="default" className="gap-1 bg-status-ok text-white">
                        <CheckCircle2 className="h-3 w-3" />
                        {tSettings("connected")}
                      </Badge>
                    ) : (
                      <>
                        <Badge variant="secondary" className="gap-1">
                          <XCircle className="h-3 w-3" />
                          {tSettings("disconnected")}
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
                              navigateTop(`/${locale}/onboarding/whatsapp?redirect=account`);
                            } else if (svc) {
                              navigateTop(`/api/auth/google?service=${svc}&redirect=account`);
                            }
                          }}
                        >
                          <RefreshCw className="h-3 w-3" />
                          {tSettings("reconnect")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Notifications */}
      <NotificationSettings />

      {/* Timezone */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" />
            {t("timezone")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[40px]"
            value={timezone}
            onChange={(e) => saveTimezone(e.target.value)}
            dir="ltr"
          >
            {!timezone && <option value="">—</option>}
            {timezoneList(timezone || undefined).map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
          {browserTz && timezone && timezone !== browserTz && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground"
              onClick={() => saveTimezone(browserTz)}
            >
              {t("timezoneUseBrowser", { tz: browserTz })}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Language */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{tSettings("language")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={switchLanguage} className="min-h-[48px]">
            {tSettings("switchLang")}
          </Button>
        </CardContent>
      </Card>

      <Separator />

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
