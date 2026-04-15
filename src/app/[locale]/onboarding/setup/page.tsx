"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle2, Rocket, Mail, Calendar, Info, FolderOpen, Search, X } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
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

interface DriveFolder {
  id: string;
  name: string;
}

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
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [selectedFolderName, setSelectedFolderName] = useState<string>("");
  const [driveConnected, setDriveConnected] = useState(false);
  const [driveToken, setDriveToken] = useState<string>("");
  // Drive search state
  const [folderSearch, setFolderSearch] = useState("");
  const [searchResults, setSearchResults] = useState<DriveFolder[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const isHe = locale === "he";

  // Check if Drive is connected and get token
  useEffect(() => {
    async function checkDrive() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: creds } = await supabase
        .from("user_credentials")
        .select("access_token")
        .eq("user_id", user.id)
        .eq("service", "google_drive")
        .single();
      if (creds) {
        setDriveConnected(true);
        setDriveToken(creds.access_token);
      }
    }
    checkDrive();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close search results on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Drive folder search (debounced)
  const searchDriveFolders = useCallback(async (query: string) => {
    if (!driveToken || query.length < 2) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }

    // Check if input is a Google Drive folder URL
    const urlMatch = query.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) {
      setSearchLoading(true);
      try {
        const folderId = urlMatch[1];
        const resp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${driveToken}` } }
        );
        if (resp.ok) {
          const folder = await resp.json();
          setSelectedFolder(folder.id);
          setSelectedFolderName(folder.name);
          setFolderSearch(folder.name);
          setShowResults(false);
          setSearchResults([]);
        } else {
          toast.error(isHe ? "תיקייה לא נמצאה" : "Folder not found");
        }
      } catch { /* ignore */ }
      setSearchLoading(false);
      return;
    }

    // Regular text search
    setSearchLoading(true);
    try {
      const q = encodeURIComponent(
        `mimeType='application/vnd.google-apps.folder' and name contains '${query.replace(/'/g, "\\'")}' and trashed=false`
      );
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10&orderBy=name&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${driveToken}` } }
      );
      if (resp.ok) {
        const data = await resp.json();
        setSearchResults(data.files || []);
        setShowResults(true);
      }
    } catch { /* ignore */ }
    setSearchLoading(false);
  }, [driveToken, isHe]);

  // Handle search input change with debounce
  function handleSearchChange(value: string) {
    setFolderSearch(value);
    // Clear selection if user is typing something different
    if (selectedFolder && value !== selectedFolderName) {
      setSelectedFolder("");
      setSelectedFolderName("");
    }
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => searchDriveFolders(value), 400);
  }

  function selectFolder(folder: DriveFolder) {
    setSelectedFolder(folder.id);
    setSelectedFolderName(folder.name);
    setFolderSearch(folder.name);
    setShowResults(false);
    setSearchResults([]);
  }

  function clearFolder() {
    setSelectedFolder("");
    setSelectedFolderName("");
    setFolderSearch("");
    setSearchResults([]);
    setShowResults(false);
  }

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
          .in("source_type", ["gmail", "gmail_sent"]),
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

      // Trigger Drive sync in background (don't await — it can take time)
      if (selectedFolder || driveConnected) {
        fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/drive-sync`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              "Content-Type": "application/json",
            },
          }
        ).catch(() => { /* ignore drive sync errors */ });
      }

      // onboarding_completed is now set by the edge function itself,
      // but set it here too as a safety net
      await supabase
        .from("user_settings")
        .update({ onboarding_completed: true })
        .eq("user_id", user.id);

      setDone(true);
    } catch (e) {
      // Even on timeout/error, check if the edge function managed to mark onboarding
      // as complete (it may have finished the IDs phase but timed out on response)
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: settings } = await supabase
            .from("user_settings")
            .select("onboarding_completed, initial_scan_completed_at")
            .eq("user_id", user.id)
            .single();

          if (settings?.onboarding_completed) {
            // Scan actually succeeded, just response timed out
            toast.success(isHe ? "הסריקה הושלמה!" : "Scan completed!");
            setDone(true);
            return;
          }

          // Edge function started but didn't complete — mark onboarding anyway
          // since IDs may have been saved and batch-details will fill in the rest
          if (settings?.initial_scan_completed_at === null) {
            await supabase
              .from("user_settings")
              .update({
                onboarding_completed: true,
                initial_scan_completed_at: new Date().toISOString(),
              })
              .eq("user_id", user.id);
            toast.info(isHe
              ? "הסריקה עדיין רצה ברקע. תוכל להיכנס לאפליקציה."
              : "Scan is still running in the background. You can enter the app.");
            setDone(true);
            return;
          }
        }
      } catch { /* ignore recovery errors */ }

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

            {/* Drive folder search */}
            {driveConnected && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-green-500" />
                  <label className="text-sm font-medium">
                    {isHe ? "Drive — איזו תיקייה לסרוק?" : "Drive — which folder to scan?"}
                  </label>
                </div>
                <div ref={searchContainerRef} className="relative">
                  <div className="relative">
                    <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={folderSearch}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      onFocus={() => { if (searchResults.length > 0) setShowResults(true); }}
                      placeholder={isHe ? "חפש תיקייה או הדבק קישור Drive..." : "Search folder or paste Drive URL..."}
                      className="w-full rounded-md border px-3 py-2.5 ps-9 pe-9 text-sm bg-background min-h-[44px]"
                      dir="auto"
                    />
                    {searchLoading && (
                      <Loader2 className="absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                    {selectedFolder && !searchLoading && (
                      <button
                        onClick={clearFolder}
                        className="absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {/* Search results dropdown */}
                  {showResults && searchResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-lg max-h-48 overflow-auto">
                      {searchResults.map((folder) => (
                        <button
                          key={folder.id}
                          onClick={() => selectFolder(folder)}
                          className="w-full text-start px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
                        >
                          <FolderOpen className="h-4 w-4 text-green-500 shrink-0" />
                          <span className="truncate">{folder.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {selectedFolder && (
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    {isHe ? `נבחרה: ${selectedFolderName}` : `Selected: ${selectedFolderName}`}
                  </p>
                )}
                {!selectedFolder && (
                  <p className="text-xs text-muted-foreground">
                    {isHe ? "השאר ריק לסריקת כל הקבצים (3 חודשים אחרונים)" : "Leave empty to scan all files (last 3 months)"}
                  </p>
                )}
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

            {/* Progress — shimmer bars with real count */}
            <style>{`
              @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(200%); }
              }
            `}</style>
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1">
                    <Mail className="h-3 w-3 text-red-500" /> Gmail
                  </span>
                  <span className="font-mono">{progress.gmail.toLocaleString()} {isHe ? "הודעות" : "messages"}</span>
                </div>
                <div className="h-2 rounded-full bg-red-100 overflow-hidden relative">
                  <div
                    className="absolute inset-0 bg-red-400/40 rounded-full"
                    style={{ animation: "shimmer 1.5s ease-in-out infinite" }}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3 text-blue-500" /> {isHe ? "לוח שנה" : "Calendar"}
                  </span>
                  <span className="font-mono">{progress.calendar.toLocaleString()} {isHe ? "אירועים" : "events"}</span>
                </div>
                <div className="h-2 rounded-full bg-blue-100 overflow-hidden relative">
                  <div
                    className="absolute inset-0 bg-blue-400/40 rounded-full"
                    style={{ animation: "shimmer 1.5s ease-in-out infinite 0.3s" }}
                  />
                </div>
              </div>
            </div>

            <p className="text-xs text-center text-muted-foreground">
              {isHe
                ? "שומר הודעות... העיבוד ימשיך ברקע."
                : "Saving messages... Processing will continue in the background."}
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
                  <p>Gmail: {stats.gmail} {isHe ? "הודעות" : "messages"}</p>
                  <p>{isHe ? "לוח שנה" : "Calendar"}: {stats.calendar} {isHe ? "אירועים" : "events"}</p>
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
