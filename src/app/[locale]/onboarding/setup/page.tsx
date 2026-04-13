"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle2, Rocket } from "lucide-react";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

export default function OnboardingSetup() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState<{ gmail: number; calendar: number } | null>(null);

  async function startScan() {
    setScanning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/initial-scan`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await resp.json();

      if (data.skipped) {
        toast.info("Initial scan already completed");
      } else if (data.success) {
        setStats({ gmail: data.gmail_ids || 0, calendar: data.calendar_events || 0 });
        toast.success("Scan complete!");
      } else {
        throw new Error(data.error || "Scan failed");
      }

      // Mark onboarding as completed
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from("user_settings")
          .update({ onboarding_completed: true })
          .eq("user_id", user.id);
      }

      setDone(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  function goToApp() {
    router.push(`/${locale}`);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-purple-100">
          <Rocket className="h-8 w-8 text-purple-600" />
        </div>
        <CardTitle>{t("step4.title")}</CardTitle>
        <CardDescription>{t("step4.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!scanning && !done && (
          <Button onClick={startScan} className="w-full min-h-[48px]">
            {t("step4.title")}
          </Button>
        )}

        {scanning && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
            <p className="text-sm text-muted-foreground">{t("step4.description")}</p>
          </div>
        )}

        {done && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              {stats && (
                <div className="text-center text-sm text-muted-foreground">
                  <p>Gmail: {stats.gmail} messages</p>
                  <p>Calendar: {stats.calendar} events</p>
                </div>
              )}
            </div>
            <Button onClick={goToApp} className="w-full min-h-[48px]">
              {t("step4.title")} →
            </Button>
          </div>
        )}

        <div className="flex justify-center gap-2 pt-2">
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-blue-600" />
        </div>
      </CardContent>
    </Card>
  );
}
