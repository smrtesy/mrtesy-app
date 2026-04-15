"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { LogOut, Mail, FolderOpen, MessageCircle, Calendar, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

interface ConnectionStatus {
  gmail: boolean;
  drive: boolean;
  calendar: boolean;
  whatsapp: boolean;
}

const connections = [
  { key: "gmail" as keyof ConnectionStatus, label: "Gmail", icon: Mail, color: "text-red-500", settingsKey: "gmail_connected" },
  { key: "drive" as keyof ConnectionStatus, label: "Google Drive", icon: FolderOpen, color: "text-green-500", settingsKey: "drive_connected" },
  { key: "calendar" as keyof ConnectionStatus, label: "Calendar", icon: Calendar, color: "text-blue-500", settingsKey: "calendar_connected" },
  { key: "whatsapp" as keyof ConnectionStatus, label: "WhatsApp", icon: MessageCircle, color: "text-emerald-500", settingsKey: "whatsapp_connected" },
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

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", user.id)
        .single();
      // Check actual credentials for real connection status
      const { data: creds } = await supabase
        .from("user_credentials")
        .select("service_type")
        .eq("user_id", user.id);

      const serviceTypes = (creds || []).map((c: { service_type: string }) => c.service_type);
      setConnStatus({
        gmail: serviceTypes.includes("gmail_calendar"),
        drive: serviceTypes.includes("drive"),
        calendar: serviceTypes.includes("gmail_calendar"), // calendar uses same OAuth as gmail
        whatsapp: data?.whatsapp_connected ?? false, // WhatsApp uses settings flag (webhook-based)
      });
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

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
                            window.location.href = `/${locale}/onboarding/whatsapp`;
                          } else if (svc) {
                            window.location.href = `/api/auth/google?service=${svc}`;
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
