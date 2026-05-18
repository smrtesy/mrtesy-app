"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle2, Rocket, Mail, Calendar, Info, FolderOpen, Search, X, Ban, Plus } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";
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

interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

const GMAIL_CATEGORY_DEFAULTS: Record<string, boolean> = {
  promotions: true,
  social: true,
  forums: true,
  updates: false,
};

const GMAIL_CATEGORY_META: Array<{ key: string; label: string; description: string }> = [
  { key: "promotions", label: "Promotions", description: "Newsletters and deals" },
  { key: "social", label: "Social", description: "Social network notifications" },
  { key: "forums", label: "Forums", description: "Mailing lists" },
  { key: "updates", label: "Updates", description: "Receipts and confirmations" },
];

export default function OnboardingSetup() {
  const t = useTranslations("onboarding");
  const tSetup = useTranslations("onboardingSetup");
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
  // Skip-rules state: addresses or domains that should never be turned into
  // tasks. `direction` controls trigger format:
  //   "from"  → from=<addr>          (incoming only)
  //   "to"    → to=<addr>            (outgoing only)
  //   "both"  → from=<addr> + to=<addr>  (two rules, bidirectional)
  // For domains (no @), direction is ignored — domain=<dom> is already
  // bidirectional in parseSkipRules.
  type SkipEntry = { value: string; direction: "from" | "to" | "both" };
  const [skipAddresses, setSkipAddresses] = useState<SkipEntry[]>([]);
  const [skipInput, setSkipInput] = useState("");
  const [skipDirection, setSkipDirection] = useState<SkipEntry["direction"]>("from");
  const [gmailCategories, setGmailCategories] = useState<Record<string, boolean>>(GMAIL_CATEGORY_DEFAULTS);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarList, setCalendarList] = useState<CalendarInfo[]>([]);
  const [selectedCalendars, setSelectedCalendars] = useState<Set<string>>(new Set());
  // Drive search state
  const [folderSearch, setFolderSearch] = useState("");
  const [searchResults, setSearchResults] = useState<DriveFolder[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const searchContainerRef = useRef<HTMLDivElement>(null);

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

  // Check calendar connection and load calendar list
  useEffect(() => {
    async function checkCalendar() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      // Service column stores "gmail" (paired with "google_calendar"); the
      // "gmail_calendar" label is only the OAuth-flow identifier, never written
      // to user_credentials. Using it here returned PostgREST 406 (zero rows
      // with .single()) so the calendar list never rendered during onboarding.
      const { data: creds } = await supabase
        .from("user_credentials")
        .select("access_token")
        .eq("user_id", user.id)
        .eq("service", "gmail")
        .maybeSingle();
      if (!creds) return;
      setCalendarConnected(true);
      try {
        const res = await api<{ calendars: CalendarInfo[] }>("/api/sync/calendars");
        setCalendarList(res.calendars);
        const primaryId = res.calendars.find((c) => c.primary)?.id ?? "primary";
        setSelectedCalendars(new Set([primaryId]));
      } catch {
        // Non-fatal — user can adjust in settings
      }
    }
    checkCalendar();
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
          toast.error(tSetup("folderNotFound"));
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
  }, [driveToken, tSetup]);

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

  function addSkipAddress() {
    const v = skipInput.trim().toLowerCase();
    if (!v) return;
    // Accept either bare emails ("foo@bar.com") or full domains ("bar.com").
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v);
    if (!ok) {
      toast.error(tSetup("invalidAddress"));
      return;
    }
    if (skipAddresses.some((a) => a.value === v)) return;
    setSkipAddresses([...skipAddresses, { value: v, direction: skipDirection }]);
    setSkipInput("");
  }

  function removeSkipAddress(addr: string) {
    setSkipAddresses(skipAddresses.filter((a) => a.value !== addr));
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

      // Persist scan preferences first so the server-side runner can also read them
      // directly from user_settings if the request body is incomplete.
      // Always write drive_folder_id (use null when cleared). A truthy-only
      // write meant `clearFolder()` could not actually clear the column —
      // a stale persisted folder would keep being used on every re-sync.
      const updateData: Record<string, unknown> = {
        initial_scan_days_back: gmailDays,
        calendar_initial_scan_months: calMonths,
        drive_folder_id: selectedFolder || null,
      };
      const { error: settingsErr } = await supabase
        .from("user_settings")
        .update(updateData)
        .eq("user_id", user.id);
      if (settingsErr) throw new Error(`Failed to save settings: ${settingsErr.message}`);

      // Persist skip rules into rules_memory so part1's Gmail query AND the
      // runtime skipFilter both pick them up on this very same scan.
      //
      // Trigger semantics (matches parseSkipRules + the user-scope
      // /settings/rules page):
      //   - Email + direction=from → from=<email>            (incoming)
      //   - Email + direction=to   → to=<email>              (outgoing)
      //   - Email + direction=both → from=<email> AND to=<email>
      //   - Bare domain            → domain=<dom>            (already bidir)
      // created_by must be one of ('user','claude','system') per the CHECK
      // constraint on rules_memory; 'user' is the right bucket for a manually
      // entered rule during onboarding.
      if (skipAddresses.length > 0) {
        const triggers = skipAddresses.flatMap((entry) => {
          if (!entry.value.includes("@")) return [`domain=${entry.value}`];
          if (entry.direction === "both") return [`from=${entry.value}`, `to=${entry.value}`];
          return [`${entry.direction}=${entry.value}`];
        });
        const { data: existing } = await supabase
          .from("rules_memory")
          .select("trigger")
          .eq("user_id", user.id)
          .eq("rule_type", "skip")
          .in("trigger", triggers);
        const existingSet = new Set(
          ((existing ?? []) as Array<{ trigger: string }>).map((r) => r.trigger),
        );
        const rows = triggers
          .filter((t) => !existingSet.has(t))
          .map((trigger) => ({
            user_id: user.id,
            app_slug: "smrtesy",
            rule_type: "skip",
            trigger,
            is_active: true,
            created_by: "user",
          }));
        if (rows.length > 0) {
          const { error: rulesErr } = await supabase
            .from("rules_memory")
            .insert(rows);
          if (rulesErr) throw new Error(`Failed to save skip rules: ${rulesErr.message}`);
        }
      }

      // Save Gmail category skip rules
      const categoryTriggers = Object.entries(gmailCategories)
        .filter(([, enabled]) => enabled)
        .map(([key]) => `category=${key}`);
      if (categoryTriggers.length > 0) {
        const { data: existingCats } = await supabase
          .from("rules_memory")
          .select("trigger")
          .eq("user_id", user.id)
          .in("trigger", categoryTriggers);
        const existingCatSet = new Set(
          ((existingCats ?? []) as Array<{ trigger: string }>).map((r) => r.trigger),
        );
        const catRows = categoryTriggers
          .filter((t) => !existingCatSet.has(t))
          .map((trigger) => ({
            user_id: user.id,
            app_slug: "smrtesy",
            rule_type: "skip",
            trigger,
            is_active: true,
            created_by: "system",
            suggestion_status: "approved",
          }));
        if (catRows.length > 0) {
          const { error: catErr } = await supabase.from("rules_memory").insert(catRows);
          if (catErr) throw new Error(`Failed to save category rules: ${catErr.message}`);
        }
      }

      // Save calendar skip rules (for calendars NOT in selectedCalendars)
      const calSkipTriggers = calendarList
        .filter((c) => !selectedCalendars.has(c.id))
        .map((c) => `calendar=${c.id}`);
      if (calSkipTriggers.length > 0) {
        const { data: existingCalSkips } = await supabase
          .from("rules_memory")
          .select("trigger")
          .eq("user_id", user.id)
          .in("trigger", calSkipTriggers);
        const existingCalSet = new Set(
          ((existingCalSkips ?? []) as Array<{ trigger: string }>).map((r) => r.trigger),
        );
        const calRows = calSkipTriggers
          .filter((t) => !existingCalSet.has(t))
          .map((trigger) => ({
            user_id: user.id,
            app_slug: "smrtesy",
            rule_type: "skip",
            trigger,
            is_active: true,
            created_by: "system",
            suggestion_status: "approved",
          }));
        if (calRows.length > 0) {
          const { error: calErr } = await supabase.from("rules_memory").insert(calRows);
          if (calErr) throw new Error(`Failed to save calendar skip rules: ${calErr.message}`);
        }
      }

      // api() auto-attaches Authorization + X-Org-Id from the active org in localStorage.
      const data = await api<{ ok: true; session_id: string }>("/api/sync/part1", {
        method: "POST",
        body: {
          gmail_days: gmailDays,
          cal_months: calMonths,
          drive_folder_id: selectedFolder || null,
          // ~3 months. The UI hint at the Drive picker promises "last 3
          // months" when the folder is left empty; the previous 24h value
          // contradicted that and silently shrunk the initial scan window.
          drive_hours: 90 * 24,
        },
      });

      const { data: runSession } = await supabase
        .from("run_sessions")
        .select("items_processed")
        .eq("id", data.session_id)
        .single();

      setStats({ gmail: runSession?.items_processed ?? 0, calendar: 0 });
      toast.success(t("step4.complete"));

      const { error: completionErr } = await supabase
        .from("user_settings")
        .update({
          onboarding_completed: true,
          initial_scan_completed_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
      if (completionErr) throw new Error(`Failed to mark onboarding complete: ${completionErr.message}`);

      setDone(true);
    } catch (e) {
      const msg = e instanceof ApiError
        ? `${e.message} (HTTP ${e.status})`
        : (e instanceof Error ? e.message : String(e));
      toast.error(msg);
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
                  {tSetup("scanExplanation")}
                </p>
              </div>
            </div>

            {/* Gmail scan range */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-red-500" />
                <label className="text-sm font-medium">
                  {tSetup("gmailDaysQuestion")}
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
                    {opt.value} {tSetup("daysUnit")}
                  </Button>
                ))}
              </div>
            </div>

            {/* Calendar scan range */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-blue-500" />
                <label className="text-sm font-medium">
                  {tSetup("calendarMonthsQuestion")}
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
                    ±{opt.value} {tSetup("monthsUnit")}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {tSetup("futureEventsHint", { months: calMonths })}
              </p>
            </div>

            {/* Drive folder search */}
            {driveConnected && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-green-500" />
                  <label className="text-sm font-medium">
                    {tSetup("driveFolderQuestion")}
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
                      placeholder={tSetup("driveSearchPlaceholder")}
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
                    {tSetup("folderSelected", { name: selectedFolderName })}
                  </p>
                )}
                {!selectedFolder && (
                  <p className="text-xs text-muted-foreground">
                    {tSetup("driveEmptyHint")}
                  </p>
                )}
              </div>
            )}

            {/* Gmail Categories */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-red-500" />
                <label className="text-sm font-medium">
                  {tSetup("gmailCategoriesLabel")}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {tSetup("gmailCategoriesHint")}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {GMAIL_CATEGORY_META.map((cat) => (
                  <label
                    key={cat.key}
                    className="flex items-start gap-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={gmailCategories[cat.key] ?? false}
                      onChange={(e) =>
                        setGmailCategories((prev) => ({ ...prev, [cat.key]: e.target.checked }))
                      }
                    />
                    <div>
                      <p className="text-sm font-medium">{cat.label}</p>
                      <p className="text-xs text-muted-foreground">{cat.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Calendar Selection */}
            {calendarConnected && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-blue-500" />
                  <label className="text-sm font-medium">
                    {tSetup("calendarSelectionLabel")}
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tSetup("calendarSelectionHint")}
                </p>
                {calendarList.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{tSetup("calendarLoadError")}</p>
                ) : (
                  <div className="space-y-2">
                    {calendarList.map((cal) => (
                      <label
                        key={cal.id}
                        className="flex items-center gap-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          className="shrink-0"
                          checked={selectedCalendars.has(cal.id)}
                          onChange={(e) => {
                            setSelectedCalendars((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(cal.id);
                              else next.delete(cal.id);
                              return next;
                            });
                          }}
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{cal.summary}</p>
                          {cal.primary && (
                            <p className="text-xs text-muted-foreground">Primary calendar</p>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Skip addresses */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Ban className="h-4 w-4 text-muted-foreground" />
                <label className="text-sm font-medium">
                  {tSetup("skipAddressesLabel")}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {tSetup("skipAddressesHint")}
              </p>
              <div className="flex gap-2">
                <Input
                  value={skipInput}
                  onChange={(e) => setSkipInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSkipAddress();
                    }
                  }}
                  placeholder={tSetup("skipAddressPlaceholder")}
                />
                <select
                  value={skipDirection}
                  onChange={(e) => setSkipDirection(e.target.value as SkipEntry["direction"])}
                  className="h-10 rounded-md border bg-background px-2 text-sm shrink-0"
                  aria-label={tSetup("skipDirectionLabel")}
                >
                  <option value="from">{tSetup("skipDirectionFrom")}</option>
                  <option value="to">{tSetup("skipDirectionTo")}</option>
                  <option value="both">{tSetup("skipDirectionBoth")}</option>
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-[40px] shrink-0"
                  onClick={addSkipAddress}
                  disabled={!skipInput.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {skipAddresses.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {skipAddresses.map((entry) => {
                    const isDomain = !entry.value.includes("@");
                    const dirLabel = isDomain
                      ? tSetup("skipDirectionBoth")
                      : tSetup(
                          (`skipDirection${entry.direction.charAt(0).toUpperCase()}${entry.direction.slice(1)}`) as Parameters<typeof tSetup>[0],
                        );
                    return (
                      <span
                        key={entry.value}
                        className="inline-flex items-center gap-1.5 rounded-full border bg-muted px-2 py-0.5 text-xs"
                      >
                        <span dir="ltr">{entry.value}</span>
                        <span className="text-[10px] text-muted-foreground">· {dirLabel}</span>
                        <button
                          onClick={() => removeSkipAddress(entry.value)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label="remove"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            <Button onClick={startScan} className="w-full min-h-[48px] mt-2">
              <Rocket className="h-4 w-4 me-2" />
              {tSetup("startScan")}
            </Button>
          </>
        )}

        {scanning && (
          <div className="space-y-4 py-4">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
              <p className="text-sm font-medium">
                {tSetup("scanning")}
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
                  <span className="font-mono">{progress.gmail.toLocaleString()} {tSetup("messagesUnit")}</span>
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
                    <Calendar className="h-3 w-3 text-blue-500" /> {tSetup("calendarLabel")}
                  </span>
                  <span className="font-mono">{progress.calendar.toLocaleString()} {tSetup("eventsUnit")}</span>
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
              {tSetup("savingMessages")}
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
                  <p>Gmail: {stats.gmail} {tSetup("messagesUnit")}</p>
                  <p>{tSetup("calendarLabel")}: {stats.calendar} {tSetup("eventsUnit")}</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                {tSetup("backgroundProcessing")}
              </p>
              {stats && stats.gmail > 1000 && (
                <p className="text-xs text-amber-600 mt-1">
                  {tSetup("largeMailboxWarning", { count: stats.gmail.toLocaleString() })}
                </p>
              )}
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
