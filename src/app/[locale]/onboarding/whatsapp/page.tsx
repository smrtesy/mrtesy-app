"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MessageCircle, Copy, Check, ExternalLink, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

export default function OnboardingStep3() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect");
  const [copied, setCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const supabase = createClient();
  const isHe = locale === "he";

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

  async function handleTestWebhook() {
    setTesting(true);
    setTestResult(null);
    try {
      // Send a test POST to the webhook to see if it responds
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          object: "whatsapp_business_account",
          entry: [{
            changes: [{
              value: {
                messages: [{
                  from: "test",
                  id: "test_" + Date.now(),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "Test message from smrtesy setup" },
                }],
                contacts: [{ profile: { name: "smrtesy Test" }, wa_id: "test" }],
              },
            }],
          }],
        }),
      });
      if (resp.ok) {
        setTestResult("success");
        toast.success(isHe ? "ה-webhook עובד!" : "Webhook is working!");
      } else {
        setTestResult("error");
        toast.error(isHe ? `שגיאה: ${resp.status}` : `Error: ${resp.status}`);
      }
    } catch {
      setTestResult("error");
      toast.error(isHe ? "לא ניתן להתחבר ל-webhook" : "Cannot reach webhook");
    } finally {
      setTesting(false);
    }
  }

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
    router.push(redirectTo === "settings" ? `/${locale}/settings` : `/${locale}/onboarding/setup`);
  }

  function handleCopy() {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSkip() {
    router.push(redirectTo === "settings" ? `/${locale}/settings` : `/${locale}/onboarding/setup`);
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
        {/* Setup Instructions */}
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs space-y-2">
          <p className="font-medium text-amber-800">
            {isHe ? "הוראות הגדרה:" : "Setup instructions:"}
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-amber-700" dir={isHe ? "rtl" : "ltr"}>
            <li>{isHe ? "העתק את ה-Webhook URL למטה" : "Copy the Webhook URL below"}</li>
            <li>
              {isHe ? "פתח את " : "Open "}
              <a
                href="https://app.dualhook.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium inline-flex items-center gap-0.5"
              >
                Dualhook <ExternalLink className="h-2.5 w-2.5 inline" />
              </a>
              {isHe ? " → Webhook Override → הדבק את ה-URL בשדה Webhook URL" : " → Webhook Override → paste URL in Webhook URL field"}
            </li>
            <li>{isHe ? "לחץ Save Changes ב-Dualhook, ואז Test Connection" : "Click Save Changes in Dualhook, then Test Connection"}</li>
            <li>{isHe ? "חזור לכאן ולחץ 'בדוק חיבור' לוודא שעובד" : "Come back here and click 'Test Connection' to verify"}</li>
            <li>{isHe ? "לחץ 'חיבור' לסיום" : "Click 'Connect' to finish"}</li>
          </ol>
        </div>

        {/* Webhook URL */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Webhook URL</label>
          <div className="flex gap-2">
            <Input value={webhookUrl} readOnly className="text-xs font-mono" dir="ltr" />
            <Button variant="outline" size="icon" onClick={handleCopy} className="min-w-[48px] min-h-[48px] shrink-0">
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Test Connection */}
        <Button
          variant="outline"
          onClick={handleTestWebhook}
          disabled={testing || !webhookUrl}
          className="w-full min-h-[48px] gap-2"
        >
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : testResult === "success" ? (
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          ) : testResult === "error" ? (
            <AlertCircle className="h-4 w-4 text-red-500" />
          ) : (
            <MessageCircle className="h-4 w-4" />
          )}
          {isHe ? "בדוק חיבור" : "Test Connection"}
        </Button>

        {/* Connect */}
        <Button onClick={handleConnect} className="w-full min-h-[48px]">
          {t("connect")}
        </Button>
        <Button onClick={handleSkip} variant="ghost" className="w-full min-h-[48px]">
          {t("skip")}
        </Button>

        {/* Progress */}
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
