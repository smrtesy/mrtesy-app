"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MessageCircle, Copy, Check } from "lucide-react";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

export default function OnboardingStep3() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const supabase = createClient();

  // Build webhook URL with actual user_id (only visible to authenticated user)
  useEffect(() => {
    async function loadUser() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setWebhookUrl(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/whatsapp?user_id=${user.id}`
        );
      }
    }
    loadUser();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleConnect() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
      .from("user_settings")
      .update({ whatsapp_connected: true })
      .eq("user_id", user.id);

    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success(t("connect"));
    router.push(`/${locale}/onboarding/setup`);
  }

  function handleCopy() {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSkip() {
    router.push(`/${locale}/onboarding/setup`);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
          <MessageCircle className="h-8 w-8 text-emerald-600" />
        </div>
        <CardTitle>{t("step3.title")}</CardTitle>
        <CardDescription>{t("step3.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Webhook URL</label>
          <div className="flex gap-2">
            <Input value={webhookUrl} readOnly className="text-xs" dir="ltr" />
            <Button variant="outline" size="icon" onClick={handleCopy} className="min-w-[48px] min-h-[48px]">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("step3.description")}
          </p>
        </div>
        <Button onClick={handleConnect} className="w-full min-h-[48px]">
          {t("connect")}
        </Button>
        <Button onClick={handleSkip} variant="ghost" className="w-full min-h-[48px]">
          {t("skip")}
        </Button>
        <div className="flex justify-center gap-2 pt-2">
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}
