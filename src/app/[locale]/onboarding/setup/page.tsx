"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle2, Rocket, Mail, Calendar, Info, FolderOpen } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

const gmailOptions = [
  { value: 7 },
  { value: 14 },
  { value: 30 },
  { value: 60 },
  { value: 90 },
];

const calendarOptions = [
  { value: 3 },
  { value: 6 },
  { value: 12 },
  { value: 24 },
];

export default function OnboardingSetup() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState<{ gmail: number; calendar: number } | null>(null);
  const [gmailDays, setGmailDays] = useState(30);
  const [calMonths, setCalMonths] = useState(12);
  const [progress, setProgress] = useState({ gmail: 0, calendar: 0, phase: "" });
  const [driveFolders, setDriveFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [loadingFolders, setLoadingFolders] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const isHe = locale === "he";

  // Load Drive top-level folders if connected
  useEffect(() => {
    async function loadFolders() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: creds } = await supabase
        .from("user_credentials")
        .select("access_token")
        .eq("user_id", user.id)
        .eq("service", "google_drive")
        .single();
      if (!creds) return;

      setLoadingFolders(true);
      try {
        // Only fetch top-level folders (parent = root), not all nested folders
        const resp = await fetch(
          "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder'+and+'root'+in+parents+and+trashed=false&fields=files(id,name)&orderBy=name&pageSize=30",
          { headers: { Authorization: `Bearer ${creds.access_token}` } }
        );
        if (resp.ok) {
          const data = await resp.json();
          setDriveFolders(data.files || []);
        }
      } catch { /* ignore */ }
      setLoadingFolders(false);
    }
    loadFolders();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll DB for progress while scanning
  useEffect(() => {
    if (!scanning) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    pollRef.current = setInterval(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [gmailResult, calResult] = await Promise.all([
        supabase
          .from("source_messages")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("source_type", "gmail"),
        supabase
          .from("source_messages")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("source_type", "google_calendar"),
      ]);

      const gmailCount = gmailResult.count || 0;
      const calCount = calResult.count || 0;

      setProgress({
        gmail: gmailCount,
        calendar: calCount,
        phase: calCount > 0 ? "calendar" : gmailCount > 0 ? "gmail" : "starting",
      });
    }, 1500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [scanning, supabase]);

  async function startScan() {
    setScanning(true);
    setProgress({ gmail: 0, calendar: 0, phase: "starting" });
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Save scan preferences (including Drive folder if selected)
      const updateData: Record<string, unknown> = {
        initial_scan_days_back: gmailDays,
        calendar_initial_scan_months: calMonths,
      };
      if (selectedFolder) {
        updateData.drive_folder_id = selectedFolder;
      }
      await supabase
        .from("user_settings")
        .update(updateData)
        .eq("user_id", user.id);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("No session");

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
        toast.info(t("step4.alreadyDone"));
      } else if (data.success) {
        setStats({ gmail: data.gmail_ids || 0, calendar: data.calendar_events || 0 });
        toast.success(t("step4.complete"));
      } else {
        throw new Error(data.error || "Scan failed");
      }

      await supabase
        .from("user_settings")
        .update({ onboarding_completed: true })
        .eq("user_id", user.id);

      setDone(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  function goToApp() {
    router.push(`/${locale}/tasks`);
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
      <CardContent className="space-y-5">
        {!scanning && !done && (
          <>
            {/* Explanation */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-700">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                <p>
                  {isHe
                    ? "הסריקה הראשונית שואבת את כל ההודעות והאירועים, מסווגת אותם עם AI ויוצרת משימות חכמות אוטומטית. התהליך עשוי לקחת מספר דקות."
                    : "The initial scan fetches all messages and events, classifies them with AI, and creates smart tasks automatically. This may take a few minutes."}
                </p>
              </div>
            </div>

            {/* Gmail scan range */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-red-500" />
                <label className="text-sm font-medium">
                  {isHe ? "Gmail — כמה ימים אחורה?" : "Gmail — how many days back?"}
                </label>
              </div>
              <div className="flex gap-2 flex-wrap">
                {gmailOptions.map((opt) => (
                  <Button
                    key={opt.value}
                    variant={gmailDays === opt.value ? "default" : "outline"}
                    size="sm"
                    className="min-h-[40px]"
                    onClick={() => setGmailDays(opt.value)}
                  >
                    {opt.value} {isHe ? "ימים" : "days"}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {isHe
                  ? `≈ ${Math.round(gmailDays * 5)} הודעות | עלות AI משוערת: ~$${(gmailDays * 5 * 0.003).toFixed(2)}`
                  : `≈ ${Math.round(gmailDays * 5)} messages | Est. AI cost: ~$${(gmailDays * 5 * 0.003).toFixed(2)}`}
              </p>
            </div>

            {/* Calendar scan range */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-blue-500" />
                <label className="text-sm font-medium">
                  {isHe ? "לוח שנה — כמה חודשים?" : "Calendar — how many months?"}
                </label>
              </div>
              <div className="flex gap-2 flex-wrap">
                {calendarOptions.map((opt) => (
                  <Button
                    key={opt.value}
                    variant={calMonths === opt.value ? "default" : "outline"}
                    size="sm"
                    className="min-h-[40px]"
                    onClick={() => setCalMonths(opt.value)}
                  >
                    ±{opt.value} {isHe ? "חודשים" : "months"}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {isHe
                  ? `אירועים עתידיים — עד ${calMonths} חודשים קדימה`
                  : `Future events — up to ${calMonths} months ahead`}
              </p>
            </div>

            {/* Drive folder selection */}
            {driveFolders.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-green-500" />
                  <label className="text-sm font-medium">
                    {isHe ? "Drive — איזו תיקייה לסרוק?" : "Drive — which folder to scan?"}
                  </label>
                </div>
                <select
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  className="w-full rounded-md border px-3 py-2.5 text-sm bg-background min-h-[44px]"
                  dir="auto"
                >
                  <option value="">📂 {isHe ? "כל הקבצים (3 חודשים אחרונים)" : "All files (last 3 months)"}</option>
                  {driveFolders.map((f) => (
                    <option key={f.id} value={f.id}>📁 {f.name}</option>
                  ))}
                </select>
              </div>
            )}
            {loadingFolders && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {isHe ? "טוען תיקיות Drive..." : "Loading Drive folders..."}
              </div>
            )}

            <Button onClick={startScan} className="w-full min-h-[48px] mt-2">
              <Rocket className="h-4 w-4 me-2" />
              {isHe ? "התחל סריקה" : "Start Scan"}
            </Button>
          </>
        )}

        {scanning && (
          <div className="space-y-4 py-4">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
              <p className="text-sm font-medium">
                {isHe ? "סורק..." : "Scanning..."}
              </p>
            </div>

            {/* Progress bars */}
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1">
                    <Mail className="h-3 w-3 text-red-500" /> Gmail
                  </span>
                  <span className="font-mono">{progress.gmail} {isHe ? "הודעות" : "messages"}</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, (progress.gmail / Math.max(1, gmailDays * 5)) * 100)}%` }}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3 text-blue-500" /> {isHe ? "לוח שנה" : "Calendar"}
                  </span>
                  <span className="font-mono">{progress.calendar} {isHe ? "אירועים" : "events"}</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, (progress.calendar / Math.max(1, calMonths * 20)) * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <p className="text-xs text-center text-muted-foreground">
              {isHe ? "זה יכול לקחת עד דקה..." : "This may take up to a minute..."}
            </p>
          </div>
        )}

        {done && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <p className="font-medium">{t("step4.complete")}</p>
              {stats && (
                <div className="text-center text-sm text-muted-foreground space-y-1">
                  <p>📧 Gmail: {stats.gmail} {isHe ? "הודעות" : "messages"}</p>
                  <p>📅 {isHe ? "לוח שנה" : "Calendar"}: {stats.calendar} {isHe ? "אירועים" : "events"}</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                {isHe
                  ? "המערכת תעבד את ההודעות ברקע ותיצור משימות אוטומטית."
                  : "The system will process messages in the background and create tasks automatically."}
              </p>
            </div>
            <Button onClick={goToApp} className="w-full min-h-[48px]">
              {t("step4.enterApp")} →
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
