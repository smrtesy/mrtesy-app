"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { LogOut, Mail, FolderOpen, MessageCircle, Calendar, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

interface UserSettings {
  preferred_language: string;
  timezone: string;
  classification_model: string;
  summary_model: string;
  daily_ai_budget_usd: number;
  show_ai_costs: boolean;
  gmail_connected: boolean;
  drive_connected: boolean;
  whatsapp_connected: boolean;
  calendar_connected: boolean;
}

const connections = [
  { key: "gmail_connected", label: "Gmail", icon: Mail, color: "text-red-500" },
  { key: "drive_connected", label: "Google Drive", icon: FolderOpen, color: "text-green-500" },
  { key: "calendar_connected", label: "Calendar", icon: Calendar, color: "text-blue-500" },
  { key: "whatsapp_connected", label: "WhatsApp", icon: MessageCircle, color: "text-emerald-500" },
] as const;

export default function SettingsPage() {
  const t = useTranslations("settings");
  const tAuth = useTranslations("auth");
  const { locale } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const [settings, setSettings] = useState<UserSettings | null>(null);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", user.id)
        .single();
      if (data) setSettings(data as UserSettings);
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push(`/${locale}/login`);
  }

  function switchLanguage() {
    const newLocale = locale === "he" ? "en" : "he";
    router.push(`/${newLocale}/settings`);
  }

  async function toggleShowCosts() {
    if (!settings) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const newVal = !settings.show_ai_costs;
    const { error } = await supabase
      .from("user_settings")
      .update({ show_ai_costs: newVal })
      .eq("user_id", user.id);
    if (error) {
      toast.error(error.message);
    } else {
      setSettings({ ...settings, show_ai_costs: newVal });
    }
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
            const connected = settings?.[conn.key] ?? false;
            return (
              <div key={conn.key} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <conn.icon className={`h-5 w-5 ${conn.color}`} />
                  <span className="text-sm font-medium">{conn.label}</span>
                </div>
                {connected ? (
                  <Badge variant="default" className="gap-1 bg-green-500">
                    <CheckCircle2 className="h-3 w-3" />
                    {t("connected")}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <XCircle className="h-3 w-3" />
                    {t("disconnected")}
                  </Badge>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* AI Settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("aiModel")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("classificationModel")}</span>
            <Badge variant="outline" className="text-xs">
              {settings?.classification_model || "claude-haiku-4-5"}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("summaryModel")}</span>
            <Badge variant="outline" className="text-xs">
              {settings?.summary_model || "claude-sonnet-4-6"}
            </Badge>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("budget")}</span>
            <Badge variant="outline" className="text-xs">
              ${settings?.daily_ai_budget_usd?.toFixed(2) || "1.00"}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("showAiCosts")}</span>
            <Button
              variant={settings?.show_ai_costs ? "default" : "outline"}
              size="sm"
              className="min-h-[36px]"
              onClick={toggleShowCosts}
            >
              {settings?.show_ai_costs ? "ON" : "OFF"}
            </Button>
          </div>
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
