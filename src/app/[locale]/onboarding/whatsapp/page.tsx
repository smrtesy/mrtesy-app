"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MessageCircle, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

export default function OnboardingWhatsApp() {
  const t = useTranslations("onboarding");
  const tWa = useTranslations("onboardingWhatsapp");
  const { locale } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect");
  const supabase = createClient();
  const isHe = locale === "he";

  // Start empty: each tenant must paste their own Sheet ID. Pre-filling
  // a shared default would silently route every new tenant to the operator's
  // Sheet, which is exactly the multi-tenant footgun this onboarding step
  // is supposed to prevent.
  const [sheetId, setSheetId] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setRowCount(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const res = await fetch(`${BACKEND_URL}/api/me/whatsapp/test-sheet`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sheet_id: sheetId }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);

      const count = (payload.row_count as number | undefined) ?? 0;
      setRowCount(count);
      setTestResult("success");
      toast.success(tWa("sheetAccessSuccess", { count }));
    } catch (e) {
      setTestResult("error");
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  async function handleConnect() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Persist the per-user Sheet ID so PART 2 routes this user's pipeline
    // to their own Sheet, not the operator's env-configured default.
    // Without this, every tenant would silently ingest the operator's rows.
    const { error: updErr } = await supabase
      .from("user_settings")
      .update({ whatsapp_connected: true, whatsapp_sheet_id: sheetId })
      .eq("user_id", user.id);
    if (updErr) {
      toast.error(updErr.message);
      return;
    }

    toast.success(tWa("whatsappConnected"));
    router.push(redirectTo === "settings" ? `/${locale}/settings` : `/${locale}/onboarding/setup`);
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
        <CardTitle>{tWa("title")}</CardTitle>
        <CardDescription>
          {tWa("description")}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* How it works */}
        <div className="rounded-lg border bg-muted/50 p-3 text-xs space-y-1.5" dir={isHe ? "rtl" : "ltr"}>
          <p className="font-medium">{tWa("howItWorks")}</p>
          <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
            <li>{tWa("step1")}</li>
            <li>{tWa("step2")}</li>
            <li>{tWa("step3")}</li>
          </ol>
        </div>

        {/* Sheet ID field */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            {tWa("sheetIdLabel")}
          </label>
          <Input
            value={sheetId}
            onChange={(e) => setSheetId(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="Sheet ID..."
          />
          <p className="text-xs text-muted-foreground">
            {tWa("sheetIdHint")}
          </p>
        </div>

        {/* Test button */}
        <Button
          variant="outline"
          className="w-full min-h-[48px] gap-2"
          onClick={handleTest}
          disabled={testing || !sheetId}
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
          {testing ? tWa("testingAccess") : tWa("testSheetAccess")}
        </Button>

        {testResult === "success" && rowCount !== null && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700 text-center">
            {tWa("sheetAccessConfirmed", { count: rowCount })}
          </div>
        )}

        {testResult === "error" && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700" dir={isHe ? "rtl" : "ltr"}>
            {tWa("sheetAccessError")}
          </div>
        )}

        {/* Connect / Skip */}
        <Button onClick={handleConnect} className="w-full min-h-[48px]">
          {tWa("confirmConnection")}
        </Button>
        <Button onClick={handleSkip} variant="ghost" className="w-full min-h-[48px]">
          {t("skip")}
        </Button>

        {/* Progress dots */}
        <div className="flex justify-center gap-2 pt-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-2 w-8 rounded-full ${i < 3 ? "bg-blue-600" : "bg-muted"}`} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
