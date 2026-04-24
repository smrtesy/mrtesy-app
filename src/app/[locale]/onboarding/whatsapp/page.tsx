"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MessageCircle, CheckCircle2, AlertCircle, Loader2, ExternalLink } from "lucide-react";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

const DEFAULT_SHEET_ID = "1_0hZE_gTzAyN-DHWhaxSQEnF4tJm1XL6nFUSJngtuaI";
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

export default function OnboardingWhatsApp() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect");
  const supabase = createClient();
  const isHe = locale === "he";

  const [sheetId, setSheetId] = useState(DEFAULT_SHEET_ID);
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

      // Trigger a test PART 2 run with the sheet ID
      const res = await fetch(`${BACKEND_URL}/api/sync/part2`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ lookback_hours: 168, force: true }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      // Check if any whatsapp source_messages were created
      const { data: { user } } = await supabase.auth.getUser();
      await new Promise((r) => setTimeout(r, 3000)); // give server time to process

      const { count } = await supabase
        .from("source_messages")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user!.id)
        .eq("source_type", "whatsapp");

      setRowCount(count ?? 0);
      setTestResult("success");
      toast.success(
        isHe
          ? `גישה לSheet הצליחה! ${count ?? 0} הודעות זוהו`
          : `Sheet access successful! ${count ?? 0} messages found`,
      );
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

    await supabase
      .from("user_settings")
      .update({ whatsapp_connected: true })
      .eq("user_id", user.id);

    toast.success(isHe ? "WhatsApp חובר בהצלחה" : "WhatsApp connected");
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
        <CardTitle>{isHe ? "חיבור WhatsApp" : "WhatsApp Connection"}</CardTitle>
        <CardDescription>
          {isHe
            ? "המערכת קוראת הודעות WhatsApp מ-Google Sheet שמעודכן על ידי Dualhook"
            : "The system reads WhatsApp messages from a Google Sheet updated by Dualhook"}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* How it works */}
        <div className="rounded-lg border bg-muted/50 p-3 text-xs space-y-1.5" dir={isHe ? "rtl" : "ltr"}>
          <p className="font-medium">{isHe ? "איך זה עובד:" : "How it works:"}</p>
          <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
            <li>
              {isHe ? "Dualhook מעתיק הודעות WhatsApp ל-" : "Dualhook copies WhatsApp messages to "}
              <a
                href={`https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5"
              >
                Google Sheet <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </li>
            <li>{isHe ? "השרת קורא מה-Sheet כל כמה שעות" : "The server reads from the Sheet every few hours"}</li>
            <li>{isHe ? "AI מנתח את השיחות ויוצר משימות" : "AI analyzes conversations and creates tasks"}</li>
          </ol>
        </div>

        {/* Sheet ID field */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            {isHe ? "Google Sheet ID" : "Google Sheet ID"}
          </label>
          <Input
            value={sheetId}
            onChange={(e) => setSheetId(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="Sheet ID..."
          />
          <p className="text-xs text-muted-foreground">
            {isHe ? "ה-ID מתוך קישור ה-Sheet (ברירת מחדל: ה-Sheet הנוכחי)" : "ID from the Sheet URL (default: current Sheet)"}
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
          {testing
            ? (isHe ? "בודק גישה…" : "Testing access…")
            : (isHe ? "בדוק גישה ל-Sheet" : "Test Sheet Access")}
        </Button>

        {testResult === "success" && rowCount !== null && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700 text-center">
            {isHe
              ? `✓ גישה לSheet מאושרת — ${rowCount} הודעות נמצאו`
              : `✓ Sheet access confirmed — ${rowCount} messages found`}
          </div>
        )}

        {testResult === "error" && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700" dir={isHe ? "rtl" : "ltr"}>
            {isHe
              ? "שגיאה בגישה ל-Sheet. ודא שחיבור Google מאושר ושה-Sheet משותף נכון."
              : "Sheet access failed. Make sure Google is connected and the Sheet is properly shared."}
          </div>
        )}

        {/* Connect / Skip */}
        <Button onClick={handleConnect} className="w-full min-h-[48px]">
          {isHe ? "אשר חיבור" : "Confirm Connection"}
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
