"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ChevronDown, ChevronUp, Copy, Check, PencilLine, ArrowUpRight, Search, X } from "lucide-react";
import { CorrectionDialog, type CorrectionDraft } from "@/components/smrttask/log/CorrectionDialog";
import { CorrectionsExportButton } from "@/components/smrttask/log/CorrectionsExportButton";
import { useOpenWhatsAppChat } from "@/hooks/useOpenWhatsAppChat";

const sourceIcons: Record<string, string> = {
  gmail: "📧",
  gmail_sent: "📤",
  whatsapp: "💬",
  whatsapp_echo: "💬",
  google_drive: "📁",
  google_calendar: "📅",
  sms: "📱",
  sms_echo: "📱",
};

const processingBadge: Record<string, { variant: "default" | "secondary" | "outline"; key: string }> = {
  pending: { variant: "secondary", key: "badgePending" },
  processed: { variant: "outline", key: "badgeProcessed" },
};

// סטטוס = משמעות. טקסט בצבע מלא, רקע בגוון חלש (לפי מערכת העיצוב).
// טוקני הסטטוס זהים ב-light/dark, לכן אין צורך בוריאנטי dark:.
const classificationColors: Record<string, string> = {
  actionable: "bg-status-ok-bg text-status-ok",
  user_actionable: "bg-status-ok-bg text-status-ok",
  actionable_followup: "bg-status-ok-bg text-status-ok",
  informational: "bg-status-warn-bg text-status-warn",
  informational_followup: "bg-status-warn-bg text-status-warn",
  spam: "bg-status-warn-bg text-status-warn",
  skip: "bg-status-warn-bg text-status-warn",
  pending: "bg-status-late-bg text-status-late",
};

const sourceFilters = [
  { key: "all", labelKey: "filterAll" },
  { key: "gmail", labelKey: "filterGmail" },
  { key: "google_drive", labelKey: "filterDrive" },
  { key: "google_calendar", labelKey: "filterCalendar" },
  { key: "whatsapp", labelKey: "filterWhatsapp" },
  { key: "sms", labelKey: "filterSms" },
];

const statusFilters = [
  { key: "all", labelKey: "statusAll" },
  { key: "pending", labelKey: "statusPending" },
  { key: "processed", labelKey: "statusProcessed" },
];

// Page size for the log list. The first fetch pulls one page; a quiet
// "load more" button below the list appends the next page on demand.
const PAGE_SIZE = 200;

// Only the columns the UI actually renders/filters on. Deliberately NOT "*":
// source_messages carries wide fields (body_text, raw message payloads) that
// would make the default 48h view transfer megabytes. Note: the "all history"
// search still matches on body_text server-side — filtering doesn't require
// selecting the column.
const SELECT_COLUMNS =
  "id, serial_display, source_type, source_id, processing_status, ai_classification, received_at, created_at, subject, sender, sender_email, recipient, source_url, " +
  "log_entries!log_source_msg_fk(classification_reason, task_title, task_id, error_message, status, ai_model_used, ai_input_tokens, ai_output_tokens, ai_cost_usd, processing_duration_ms, pre_classification, details, created_at), " +
  "tasks!source_message_id(id, serial_display, status, manually_verified)";

// Merge the two timestamps into one sort key so the list is ordered by the
// date each row actually shows (processed time when present, else ingestion
// time) — otherwise pending items (no log_created_at) drift out of order.
function byDisplayDateDesc(a: SourceEntry, b: SourceEntry): number {
  const da = new Date(a.log_created_at || a.created_at).getTime();
  const db = new Date(b.log_created_at || b.created_at).getTime();
  return db - da;
}

const RECLASSIFY_OPTIONS = [
  { value: "actionable", labelKey: "classActionable" },
  { value: "informational", labelKey: "classInformational" },
  { value: "spam", labelKey: "classSpam" },
] as const;

interface SourceEntry {
  id: string;
  serial_display: string | null;
  source_type: string;
  source_id: string;
  processing_status: string;
  ai_classification: string | null;
  received_at: string | null;
  created_at: string;
  subject: string | null;
  sender: string | null;
  sender_email: string | null;
  recipient: string | null;
  source_url: string | null;
  // From log_entries LEFT JOIN
  classification_reason: string | null;
  task_title: string | null;
  task_serial: string | null;
  task_id: string | null;
  task_status: string | null;
  task_manually_verified: boolean | null;
  error_message: string | null;
  log_status: string | null;
  log_created_at: string | null;
  pre_classification: string | null;
  log_details: Record<string, unknown> | null;
  ai_model_used: string | null;
  ai_input_tokens: number | null;
  ai_output_tokens: number | null;
  ai_cost_usd: number | null;
  processing_duration_ms: number | null;
}

export function LogPageClient({ locale }: { locale: string }) {
  const t = useTranslations("log");
  const tLog = useTranslations("logPage");
  const openWhatsApp = useOpenWhatsAppChat();
  const supabase = createClient();
  const [logs, setLogs] = useState<SourceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reclassifyOpenId, setReclassifyOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // Correction capture (feature: explanation + general/personal scope) and the
  // refresh key that keeps the export button's "pending" badge in sync.
  const [correctionDraft, setCorrectionDraft] = useState<CorrectionDraft | null>(null);
  const [correctionsRefreshKey, setCorrectionsRefreshKey] = useState(0);
  // "Search all history": when on (and a query is typed) the 48h window is
  // dropped and the search runs server-side across the user's whole stored
  // history. Debounced so we don't fire a query on every keystroke.
  const [searchAllHistory, setSearchAllHistory] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Pagination: hasMore is true when the last fetch returned a full page;
  // fetchedCountRef tracks the raw row offset for the next page request.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const fetchedCountRef = useRef(0);

  const dateFmtLocale = locale === "he" ? "he-IL" : "en-US";
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(dateFmtLocale, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [dateFmtLocale],
  );

  // Close reclassify dropdown when clicking outside any [data-reclassify] element
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (!(e.target as Element).closest("[data-reclassify]")) {
        setReclassifyOpenId(null);
      }
    }
    if (reclassifyOpenId) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [reclassifyOpenId]);

  // Debounce the query that drives the server-side "all history" search so a
  // fresh DB round-trip only fires ~300ms after the user stops typing.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Effective search derived from the DEBOUNCED query — one source of truth
  // shared by the fetch and the client-side filter. `historyMode` is true only
  // once the box is ticked AND the term is long enough to be worth a full-
  // history scan. `historySearchKey` collapses to "" whenever we are NOT doing
  // a history search, so typing with the box off never changes fetchLogs' deps
  // (no DB round-trip / skeleton flash on every keystroke).
  const searchTerm = debouncedQuery.replace(/[,()*%\\"]/g, " ").trim();
  const historyMode = searchAllHistory && searchTerm.length >= 2;
  const historySearchKey = historyMode ? searchTerm : "";

  /** Fetch one page of log rows starting at raw-row offset `from`, fully
   *  mapped (log entry merged in, routed task ids resolved). Shared by the
   *  initial fetch and "load more". Returns rawCount so callers can tell
   *  whether the page was full (i.e. more rows likely exist). */
  const fetchPage = useCallback(async (from: number) => {
    // Two modes:
    //  • default — items from the last 48 hours (window on ingestion time
    //    created_at), newest first, one page at a time.
    //  • "search all history" — the 48h window is dropped and the query is
    //    filtered server-side across the user's ENTIRE stored history, so an
    //    email / WhatsApp / Drive item from weeks ago is findable. The match
    //    covers the human-meaningful columns plus body_text (message content),
    //    so a hit inside the body still surfaces the row.
    let query = supabase
      .from("source_messages")
      .select(SELECT_COLUMNS)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (historyMode) {
      const cols = ["subject", "sender", "sender_email", "recipient", "serial_display", "body_text"];
      query = query.or(cols.map((c) => `${c}.ilike.*${historySearchKey}*`).join(","));
    } else {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      query = query.gte("created_at", cutoff);
    }

    if (sourceFilter !== "all") {
      if (sourceFilter === "whatsapp") {
        query = query.in("source_type", ["whatsapp", "whatsapp_echo"]);
      } else if (sourceFilter === "sms") {
        // The SMS filter covers both two-party threads and self-notes (sms_echo).
        query = query.in("source_type", ["sms", "sms_echo"]);
      } else {
        query = query.eq("source_type", sourceFilter);
      }
    }

    if (statusFilter !== "all") {
      query = query.eq("processing_status", statusFilter);
    }

    const { data, error } = await query;
    // Surface failed pages instead of silently rendering an empty list.
    // No user-facing error surface exists in this component (all fetches are
    // best-effort), so log-only.
    if (error) console.error("[log] source_messages page fetch failed:", error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped = (data || []).map((row: any) => {
      const logArr = row.log_entries || [];
      const logEntry = logArr.length > 0 ? logArr[logArr.length - 1] : null;

      let resolvedUrl = row.source_url || null;
      if (!resolvedUrl && row.source_id) {
        if (row.source_type === "gmail" || row.source_type === "gmail_sent") {
          resolvedUrl = `https://mail.google.com/mail/u/0/#all/${row.source_id}`;
        }
      }

      const tasksArr = row.tasks || [];
      const linkedTask = tasksArr.length > 0 ? tasksArr[0] : null;
      const taskSerial = linkedTask?.serial_display ?? null;

      return {
        id: row.id,
        serial_display: row.serial_display ?? null,
        source_type: row.source_type,
        source_id: row.source_id,
        processing_status: row.processing_status,
        ai_classification: row.ai_classification,
        received_at: row.received_at,
        created_at: row.created_at,
        subject: row.subject,
        sender: row.sender,
        sender_email: row.sender_email,
        recipient: row.recipient,
        source_url: resolvedUrl,
        classification_reason: logEntry?.classification_reason || null,
        task_title: logEntry?.task_title || null,
        task_serial: taskSerial,
        // Created-from-this-message task wins; otherwise fall back to the matter
        // the log says this message was routed INTO (serial/status resolved
        // below) so routed follow-ups still link to their task.
        task_id: linkedTask?.id ?? logEntry?.task_id ?? null,
        task_status: linkedTask?.status ?? null,
        task_manually_verified: linkedTask?.manually_verified ?? null,
        error_message: logEntry?.error_message || null,
        log_status: logEntry?.status || null,
        log_created_at: logEntry?.created_at || null,
        pre_classification: logEntry?.pre_classification || null,
        log_details: logEntry?.details || null,
        ai_model_used: logEntry?.ai_model_used || null,
        ai_input_tokens: logEntry?.ai_input_tokens || null,
        ai_output_tokens: logEntry?.ai_output_tokens || null,
        ai_cost_usd: logEntry?.ai_cost_usd || null,
        processing_duration_ms: logEntry?.processing_duration_ms || null,
      };
    });

    // Routed follow-ups append to an EXISTING matter, so no task is created
    // from this message and the tasks!source_message_id join above is empty —
    // but the log entry recorded which matter it was routed INTO. Resolve those
    // task ids so the row links to the real task (T-serial) instead of leaving
    // the user unable to find where the update went.
    const needIds = Array.from(
      new Set(
        mapped
          .filter((m: SourceEntry) => m.task_id && m.task_serial == null)
          .map((m: SourceEntry) => m.task_id as string),
      ),
    );
    if (needIds.length > 0) {
      const { data: routed } = await supabase
        .from("tasks")
        .select("id, serial_display, status, title_he, title, manually_verified")
        .in("id", needIds);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byId = new Map<string, any>((routed || []).map((t: any) => [t.id, t]));
      for (const m of mapped) {
        if (m.task_id && m.task_serial == null && byId.has(m.task_id)) {
          const t = byId.get(m.task_id);
          m.task_serial = t.serial_display ?? null;
          m.task_status = t.status ?? null;
          m.task_manually_verified = t.manually_verified ?? null;
          if (!m.task_title) m.task_title = t.title_he || t.title || null;
        }
      }
    }

    return { rows: mapped as SourceEntry[], rawCount: (data || []).length };
  }, [supabase, sourceFilter, statusFilter, historyMode, historySearchKey]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { rows, rawCount } = await fetchPage(0);
    rows.sort(byDisplayDateDesc);
    setLogs(rows);
    fetchedCountRef.current = rawCount;
    setHasMore(rawCount === PAGE_SIZE);
    setLoading(false);

    const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase());
    setIsAdmin(adminEmails.includes(user.email?.toLowerCase() || ""));
  }, [supabase, fetchPage]);

  /** Append the next page. Dedupes by id (offset pagination can re-serve a
   *  row when new items arrive between fetches) and re-sorts the merged list
   *  by display date so appended rows interleave correctly. */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const { rows, rawCount } = await fetchPage(fetchedCountRef.current);
    fetchedCountRef.current += rawCount;
    setHasMore(rawCount === PAGE_SIZE);
    setLogs((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      const merged = [...prev, ...rows.filter((r) => !seen.has(r.id))];
      merged.sort(byDisplayDateDesc);
      return merged;
    });
    setLoadingMore(false);
  }, [fetchPage, hasMore, loadingMore]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  async function reclassify(log: SourceEntry, newClass: string) {
    setReclassifyOpenId(null);
    const isActionable = newClass === "actionable";
    const updates: Record<string, string> = {
      ai_classification: isActionable ? "user_actionable" : newClass,
      processing_status: isActionable ? "pending" : "processed",
    };
    await supabase.from("source_messages").update(updates).eq("id", log.id);
    setLogs((prev) =>
      prev.map((l) =>
        l.id === log.id
          ? { ...l, ai_classification: updates.ai_classification, processing_status: updates.processing_status }
          : l
      )
    );
    // Offer to record an explanation for the fix (optional — the user can
    // cancel). This is what turns a one-off reclassify into a learnable rule.
    openCorrection(log, "reclassify", "ai_classification", log.ai_classification, updates.ai_classification);
  }

  /** Deep-link to the linked task. Unverified suggestions live in /inbox,
   *  everything else opens in /tasks via the shared ?focus= mechanism. */
  function taskHref(log: SourceEntry): string | null {
    if (!log.task_id) return null;
    if (log.task_manually_verified === false) {
      return `/${locale}/inbox?focus=${log.task_id}`;
    }
    return `/${locale}/tasks?focus=${log.task_id}`;
  }

  /** Comprehensive, self-contained snapshot of a log row for the export. */
  function buildContext(log: SourceEntry): Record<string, unknown> {
    return {
      source_type: log.source_type,
      source_id: log.source_id,
      source_url: log.source_url,
      serial_display: log.serial_display,
      subject: log.subject,
      sender: log.sender,
      sender_email: log.sender_email,
      recipient: log.recipient,
      received_at: log.received_at,
      processed_at: log.log_created_at,
      processing_status: log.processing_status,
      pre_classification: log.pre_classification,
      ai_classification: log.ai_classification,
      classification_reason: log.classification_reason,
      ai_model_used: log.ai_model_used,
      ai_input_tokens: log.ai_input_tokens,
      ai_output_tokens: log.ai_output_tokens,
      ai_cost_usd: log.ai_cost_usd,
      processing_duration_ms: log.processing_duration_ms,
      task: log.task_id
        ? { id: log.task_id, serial: log.task_serial, title: log.task_title, status: log.task_status }
        : null,
      error_message: log.error_message,
      log_details: log.log_details,
    };
  }

  function openCorrection(
    log: SourceEntry,
    type: CorrectionDraft["correction_type"],
    field: string | null,
    oldValue: string | null,
    newValue: string | null,
  ) {
    setCorrectionDraft({
      source_message_id: log.id,
      task_id: log.task_id,
      log_entry_id: null,
      correction_type: type,
      field,
      old_value: oldValue,
      new_value: newValue,
      context: buildContext(log),
    });
  }

  function buildCopyText(log: SourceEntry): string {
    const lines: string[] = [
      "=== smrtTask AI Processing Log ===",
      `תאריך עיבוד: ${log.log_created_at ? dateFormatter.format(new Date(log.log_created_at)) : dateFormatter.format(new Date(log.created_at))}`,
      `מקור: ${log.source_type}`,
    ];
    if (log.subject) lines.push(`נושא: ${log.subject}`);
    if (log.sender) lines.push(`שולח: ${log.sender}${log.sender_email && log.sender_email !== log.sender ? ` <${log.sender_email}>` : ""}`);
    if (log.recipient) lines.push(`נמען: ${log.recipient}`);
    lines.push("");
    if (log.pre_classification) lines.push(`Pre-classification: ${log.pre_classification}`);
    if (log.ai_classification) lines.push(`AI classification: ${log.ai_classification}`);
    if (log.classification_reason) lines.push(`סיבה: ${log.classification_reason}`);
    lines.push("");
    if (log.ai_model_used) lines.push(`מודל: ${log.ai_model_used}`);
    if (log.ai_input_tokens) lines.push(`טוקנים: ${log.ai_input_tokens} → ${log.ai_output_tokens ?? 0}`);
    if (log.ai_cost_usd) lines.push(`עלות: $${Number(log.ai_cost_usd).toFixed(5)}`);
    if (log.processing_duration_ms) lines.push(`זמן: ${log.processing_duration_ms}ms`);
    if (log.task_title) lines.push(`\nמשימה נוצרה: ${log.task_title}${log.task_serial ? ` (${log.task_serial})` : ""}`);
    if (log.error_message) lines.push(`\nשגיאה: ${log.error_message}`);
    if (log.log_details) lines.push(`\nפרטים נוספים:\n${JSON.stringify(log.log_details, null, 2)}`);
    return lines.join("\n");
  }

  async function copyDetails(e: React.MouseEvent, log: SourceEntry) {
    e.stopPropagation();
    await navigator.clipboard.writeText(buildCopyText(log));
    setCopiedId(log.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  function classLabel(cls: string | null) {
    if (!cls || cls === "pending") return null;
    if (cls === "user_actionable") return tLog("classActionable") + " ✎";
    if (cls === "actionable" || cls === "actionable_followup") return tLog("classActionable");
    if (cls === "informational" || cls === "informational_followup") return tLog("classInformational");
    if (cls === "spam") return tLog("classSpam");
    if (cls === "skip") return "skip";
    return cls;
  }

  // Free-text search over the loaded entries — matches across every
  // human-meaningful field so the user can find an item by subject, sender,
  // reason, task title, serial, etc. Skip it ONLY when a history search is
  // actually running (box on AND term long enough) — then the server already
  // filtered the full history, so render as-is. With the box on but the term
  // still too short, we keep narrowing the 48h window client-side.
  const q = searchQuery.trim().toLowerCase();
  const displayedLogs = useMemo(
    () =>
      q && !historyMode
        ? logs.filter((l) =>
            [
              l.subject, l.sender, l.sender_email, l.recipient,
              l.classification_reason, l.task_title, l.task_serial,
              l.serial_display, l.source_type, l.ai_classification, l.error_message,
            ].some((v) => v && v.toLowerCase().includes(q)),
          )
        : logs,
    [logs, q, historyMode],
  );

  return (
    <>
      {/* Top bar: search + export. Search filters the loaded entries across
          all meaningful fields. Export hands corrections to Claude Code. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tLog("searchPlaceholder")}
            dir="auto"
            className="h-9 w-full rounded-full border bg-background ps-9 pe-9 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute end-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={tLog("searchClear")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <CorrectionsExportButton refreshKey={correctionsRefreshKey} />
      </div>

      {/* "Search all history" — quiet: only shown once the user is actually
          searching. Ticking it drops the 48h window and runs the search
          server-side across the whole stored history (incl. message body). */}
      {searchQuery.trim().length > 0 && (
        <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={searchAllHistory}
            onChange={(e) => setSearchAllHistory(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-muted-foreground/40 accent-primary"
          />
          <span className="font-medium text-foreground/80">{tLog("searchAllHistory")}</span>
          <span className="truncate">{tLog("searchAllHistoryHint")}</span>
        </label>
      )}

      {/* Source Filter Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {sourceFilters.map((f) => (
          <button
            key={f.key}
            onClick={() => setSourceFilter(f.key)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              sourceFilter === f.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {tLog(f.labelKey)}
          </button>
        ))}
      </div>

      {/* Status Filter Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {statusFilters.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              statusFilter === f.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {tLog(f.labelKey)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : displayedLogs.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          {q ? (
            <p>{tLog("searchNoResults")}</p>
          ) : (
            <>
              <p>{t("noEntries")}</p>
              <p className="text-xs mt-1">{t("entriesAppearAfter")}</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {displayedLogs.map((log) => {
            const isExpanded = expandedId === log.id;
            const isReclassifyOpen = reclassifyOpenId === log.id;
            const displayTitle = log.subject || log.sender || tLog("noSubject");
            // Always show the time the system processed/ingested the item
            const displayDate = log.log_created_at || log.created_at;
            const badge = processingBadge[log.processing_status] || processingBadge.pending;
            const classColor = classificationColors[log.ai_classification || "pending"] || "";
            const classText = classLabel(log.ai_classification);
            const canReclassify = log.processing_status === "processed" || log.ai_classification === "user_actionable";

            return (
              <div
                key={log.id}
                className={`rounded-lg border bg-card p-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors ${
                  log.processing_status === "pending" ? "opacity-75" : ""
                }`}
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
              >
                {/* Row 1 */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base">{sourceIcons[log.source_type || ""] || "📋"}</span>
                  {log.serial_display && (
                    <span className="font-mono text-[10px] rounded border px-1 py-0.5 text-muted-foreground bg-muted/40">
                      {log.serial_display}
                    </span>
                  )}
                  {log.task_serial && (() => {
                    const href = taskHref(log);
                    const cls = "font-mono text-[10px] rounded border px-1 py-0.5 text-primary border-primary/50 bg-primary/10";
                    return href ? (
                      <a
                        href={href}
                        onClick={(e) => e.stopPropagation()}
                        className={`${cls} inline-flex items-center gap-0.5 hover:bg-primary/20 transition-colors`}
                        title={tLog("openTask")}
                      >
                        → {log.task_serial}
                        <ArrowUpRight className="h-2.5 w-2.5" />
                      </a>
                    ) : (
                      <span className={cls}>→ {log.task_serial}</span>
                    );
                  })()}
                  <Badge variant={badge.variant} className="text-[10px]">
                    {tLog(badge.key)}
                  </Badge>

                  {/* Reclassifiable classification badge */}
                  {classText && (
                    <div className="relative" data-reclassify="true">
                      <button
                        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity ${classColor}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (canReclassify) setReclassifyOpenId(isReclassifyOpen ? null : log.id);
                        }}
                        title={canReclassify ? tLog("reclassify") : undefined}
                      >
                        {classText}
                      </button>
                      {isReclassifyOpen && (
                        <div className="absolute top-full mt-1 start-0 z-50 rounded-lg border bg-popover shadow-md min-w-[110px] py-1">
                          <p className="px-2 py-1 text-[10px] text-muted-foreground font-medium">
                            {tLog("reclassifyAs")}
                          </p>
                          {RECLASSIFY_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              className="w-full px-2 py-1.5 text-left text-xs hover:bg-accent transition-colors"
                              onClick={(e) => { e.stopPropagation(); reclassify(log, opt.value); }}
                            >
                              {tLog(opt.labelKey)}
                              {opt.value === "actionable" && (
                                <span className="ms-1 text-[10px] text-muted-foreground">
                                  {tLog("reprocessNote")}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {log.log_status === "failed" && <span className="text-xs">🔴</span>}
                  <span className="ms-auto text-[10px] text-muted-foreground whitespace-nowrap">
                    {dateFormatter.format(new Date(displayDate))}
                  </span>
                  {isExpanded ? (
                    <ChevronUp className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  )}
                </div>

                {/* Row 2: subject + sender + source link */}
                <div className="mt-1.5 flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate" dir="auto">{displayTitle}</p>
                    {log.sender && log.sender !== displayTitle && (
                      <p className="text-[11px] text-muted-foreground truncate" dir="auto">
                        {log.sender}
                        {log.sender_email && log.sender_email !== log.sender && (
                          <span className="opacity-60"> ({log.sender_email})</span>
                        )}
                        {log.recipient && (
                          <span className="opacity-60"> → {log.recipient}</span>
                        )}
                      </p>
                    )}
                  </div>
                  {log.source_url && (() => {
                    const isWa = log.source_type === "whatsapp" || log.source_type === "whatsapp_echo";
                    if (isWa) {
                      const phone = ((log.source_url ?? "").match(/wa\.me\/([^?#]+)/)?.[1] ?? "").replace(/\D/g, "");
                      return (
                        <button
                          type="button"
                          className="shrink-0 text-muted-foreground hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Open the conversation in the docked side-panel, or
                            // — inside a workspace pane where that panel is
                            // CSS-hidden — the full /whatsapp reader (the hook
                            // picks the right one).
                            openWhatsApp(phone || null);
                          }}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      );
                    }
                    return (
                      <a href={log.source_url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-primary" onClick={(e) => e.stopPropagation()}>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    );
                  })()}
                </div>

                {/* Row 3: classification reason */}
                {log.classification_reason && !isExpanded && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground/80 line-clamp-2" dir="auto">
                    {log.classification_reason}
                  </p>
                )}

                {/* Row 4: task created — links to the task when one exists */}
                {log.task_title && (() => {
                  const href = taskHref(log);
                  const inner = (
                    <>
                      <span>→</span>
                      <span className="truncate" dir="auto">{log.task_title}</span>
                      {href && <ArrowUpRight className="h-3 w-3 shrink-0" />}
                    </>
                  );
                  return href ? (
                    <a
                      href={href}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1.5 flex items-center gap-1 text-[11px] text-primary hover:underline"
                      title={tLog("openTask")}
                    >
                      {inner}
                    </a>
                  ) : (
                    <div className="mt-1.5 flex items-center gap-1 text-[11px] text-primary">{inner}</div>
                  );
                })()}

                {/* Row 5: error (collapsed = clamp, expanded = full) */}
                {log.error_message && (
                  <p className={`mt-1.5 text-[11px] text-status-late ${isExpanded ? "" : "line-clamp-2"}`}>
                    {log.error_message}
                  </p>
                )}

                {/* Expanded: full AI details panel */}
                {isExpanded && (
                  <div
                    className="mt-3 rounded-md border bg-muted/40 p-3 space-y-2 text-[11px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Header with correction + copy buttons */}
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-xs text-muted-foreground">{tLog("aiDetails")}</span>
                      <div className="flex items-center gap-1.5">
                        <button
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-background border hover:bg-accent transition-colors"
                          onClick={(e) => { e.stopPropagation(); openCorrection(log, "note", null, null, null); }}
                          title={tLog("addCorrectionTitle")}
                        >
                          <PencilLine className="h-3 w-3" /> {tLog("addCorrection")}
                        </button>
                        <button
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-background border hover:bg-accent transition-colors"
                          onClick={(e) => copyDetails(e, log)}
                        >
                          {copiedId === log.id ? (
                            <><Check className="h-3 w-3 text-status-ok" /> {tLog("copied")}</>
                          ) : (
                            <><Copy className="h-3 w-3" /> {tLog("copyDetails")}</>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Processing time */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                      {log.log_created_at && (
                        <>
                          <span className="font-medium text-foreground/70">{tLog("processedAt")}</span>
                          <span dir="ltr">{new Date(log.log_created_at).toLocaleString(dateFmtLocale)}</span>
                        </>
                      )}
                      {log.pre_classification && (
                        <>
                          <span className="font-medium text-foreground/70">{tLog("preClassification")}</span>
                          <span>{log.pre_classification}</span>
                        </>
                      )}
                      {log.ai_classification && (
                        <>
                          <span className="font-medium text-foreground/70">{tLog("aiClassification")}</span>
                          <span>{log.ai_classification}</span>
                        </>
                      )}
                      {log.ai_model_used && (
                        <>
                          <span className="font-medium text-foreground/70">{tLog("model")}</span>
                          <span>{log.ai_model_used}</span>
                        </>
                      )}
                      {(log.ai_input_tokens || log.ai_output_tokens) && (
                        <>
                          <span className="font-medium text-foreground/70">{tLog("tokens")}</span>
                          <span dir="ltr">{log.ai_input_tokens ?? 0} → {log.ai_output_tokens ?? 0}</span>
                        </>
                      )}
                      {log.ai_cost_usd && (
                        <>
                          <span className="font-medium text-foreground/70">{tLog("cost")}</span>
                          <span dir="ltr">${Number(log.ai_cost_usd).toFixed(5)}</span>
                        </>
                      )}
                      {log.processing_duration_ms && (
                        <>
                          <span className="font-medium text-foreground/70">{tLog("duration")}</span>
                          <span dir="ltr">{log.processing_duration_ms}ms</span>
                        </>
                      )}
                    </div>

                    {/* Full classification reason */}
                    {log.classification_reason && (
                      <div>
                        <p className="font-medium text-foreground/70 mb-0.5">{tLog("reason")}</p>
                        <p dir="auto" className="whitespace-pre-wrap text-muted-foreground">{log.classification_reason}</p>
                      </div>
                    )}

                    {/* Classifier confidence (recorded on every classified message) */}
                    {typeof (log.log_details as { classification_confidence?: unknown } | null)?.classification_confidence === "string" && (
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-foreground/70">{tLog("classificationConfidence")}</span>
                        <span className={`text-[10px] uppercase font-medium ${(log.log_details as { classification_confidence: string }).classification_confidence === "low" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}>
                          {(log.log_details as { classification_confidence: string }).classification_confidence}
                        </span>
                      </div>
                    )}

                    {/* Per-model verdict trail (low-confidence escalation) */}
                    {Array.isArray((log.log_details as { classification_trail?: unknown } | null)?.classification_trail) && (
                      <div>
                        <p className="font-medium text-foreground/70 mb-0.5">{tLog("modelTrail")}</p>
                        <div className="flex flex-col gap-1">
                          {((log.log_details as { classification_trail: Array<{ model: string; classification: string; confidence: string; reason: string }> }).classification_trail).map((step, i, arr) => (
                            <div key={`${i}-${step.model}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted-foreground">
                              <span dir="ltr" className="font-mono text-[10px] text-foreground/80">{step.model}</span>
                              <span className="font-medium">{step.classification}</span>
                              <span className="text-[10px] uppercase opacity-70">({step.confidence})</span>
                              {i === arr.length - 1 && <span className="text-[10px] text-primary">{tLog("modelTrailFinal")}</span>}
                              {step.reason && <span dir="auto" className="basis-full whitespace-pre-wrap text-[11px] opacity-80">{step.reason}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Task-builder confidence (recorded for every built task) */}
                    {typeof (log.log_details as { task_confidence?: unknown } | null)?.task_confidence === "string" && (
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-foreground/70">{tLog("taskConfidence")}</span>
                        <span className={`text-[10px] uppercase font-medium ${(log.log_details as { task_confidence: string }).task_confidence === "low" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}>
                          {(log.log_details as { task_confidence: string }).task_confidence}
                        </span>
                      </div>
                    )}

                    {/* Task-builder per-model trail (Opus escalation) */}
                    {Array.isArray((log.log_details as { task_trail?: unknown } | null)?.task_trail) && (
                      <div>
                        <p className="font-medium text-foreground/70 mb-0.5">{tLog("taskTrail")}</p>
                        <div className="flex flex-col gap-1">
                          {((log.log_details as { task_trail: Array<{ model: string; confidence: string; taskCount: number }> }).task_trail).map((step, i, arr) => (
                            <div key={`${i}-${step.model}`} className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                              <span dir="ltr" className="font-mono text-[10px] text-foreground/80">{step.model}</span>
                              <span className="text-[10px] uppercase opacity-70">({step.confidence})</span>
                              <span dir="ltr" className="text-[10px]">{step.taskCount} ✓</span>
                              {i === arr.length - 1 && <span className="text-[10px] text-primary">{tLog("modelTrailFinal")}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Extra details JSON */}
                    {log.log_details && Object.keys(log.log_details).length > 0 && (
                      <div>
                        <p className="font-medium text-foreground/70 mb-0.5">{tLog("details")}</p>
                        <pre className="whitespace-pre-wrap text-muted-foreground text-[10px] overflow-x-auto">{JSON.stringify(log.log_details, null, 2)}</pre>
                      </div>
                    )}

                    {/* Admin cost row */}
                    {isAdmin && (log.ai_cost_usd || log.ai_model_used) && (
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60 pt-1 border-t">
                        {log.ai_model_used && <span>{log.ai_model_used}</span>}
                        {log.ai_input_tokens && <span>{log.ai_input_tokens}+{log.ai_output_tokens} tok</span>}
                        {log.ai_cost_usd && <span>${Number(log.ai_cost_usd).toFixed(5)}</span>}
                        {log.processing_duration_ms && <span>{log.processing_duration_ms}ms</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Quiet "load more": only when the last fetch returned a full
              page. Small centered ghost button — per the compact-UI rule. */}
          {hasMore && (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
              >
                {loadingMore ? tLog("loadingMore") : tLog("loadMore")}
              </button>
            </div>
          )}
        </div>
      )}

      <CorrectionDialog
        open={!!correctionDraft}
        draft={correctionDraft}
        onClose={() => setCorrectionDraft(null)}
        onSaved={() => setCorrectionsRefreshKey((k) => k + 1)}
      />
    </>
  );
}
