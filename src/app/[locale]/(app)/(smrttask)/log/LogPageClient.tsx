"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ChevronDown, ChevronUp, Copy, Check } from "lucide-react";

const sourceIcons: Record<string, string> = {
  gmail: "📧",
  gmail_sent: "📤",
  whatsapp: "💬",
  whatsapp_echo: "💬",
  google_drive: "📁",
  google_calendar: "📅",
};

const processingBadge: Record<string, { variant: "default" | "secondary" | "outline"; key: string }> = {
  pending: { variant: "secondary", key: "badgePending" },
  processed: { variant: "outline", key: "badgeProcessed" },
};

const classificationColors: Record<string, string> = {
  actionable: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  user_actionable: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  actionable_followup: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  informational: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  informational_followup: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  spam: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  skip: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  pending: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
};

const sourceFilters = [
  { key: "all", labelKey: "filterAll" },
  { key: "gmail", labelKey: "filterGmail" },
  { key: "google_drive", labelKey: "filterDrive" },
  { key: "google_calendar", labelKey: "filterCalendar" },
  { key: "whatsapp", labelKey: "filterWhatsapp" },
];

const statusFilters = [
  { key: "all", labelKey: "statusAll" },
  { key: "pending", labelKey: "statusPending" },
  { key: "processed", labelKey: "statusProcessed" },
];

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
  const supabase = createClient();
  const [logs, setLogs] = useState<SourceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reclassifyOpenId, setReclassifyOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const dateFmtLocale = locale === "he" ? "he-IL" : "en-US";
  const dateFormatter = new Intl.DateTimeFormat(dateFmtLocale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

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

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    let query = supabase
      .from("source_messages")
      .select("*, log_entries!log_source_msg_fk(classification_reason, task_title, error_message, status, ai_model_used, ai_input_tokens, ai_output_tokens, ai_cost_usd, processing_duration_ms, pre_classification, details, created_at), tasks!source_message_id(serial_display)")
      .order("created_at", { ascending: false })
      .limit(200);

    if (sourceFilter !== "all") {
      if (sourceFilter === "whatsapp") {
        query = query.in("source_type", ["whatsapp", "whatsapp_echo"]);
      } else {
        query = query.eq("source_type", sourceFilter);
      }
    }

    if (statusFilter !== "all") {
      query = query.eq("processing_status", statusFilter);
    }

    const { data } = await query;
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
      const taskSerial = tasksArr.length > 0 ? tasksArr[0].serial_display : null;

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
    setLogs(mapped as SourceEntry[]);
    setLoading(false);

    const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase());
    setIsAdmin(adminEmails.includes(user.email?.toLowerCase() || ""));
  }, [supabase, sourceFilter, statusFilter]);

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

  return (
    <>
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
      ) : logs.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <p>{t("noEntries")}</p>
          <p className="text-xs mt-1">{t("entriesAppearAfter")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => {
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
                  {log.task_serial && (
                    <span className="font-mono text-[10px] rounded border px-1 py-0.5 text-primary border-primary/50 bg-primary/10">
                      → {log.task_serial}
                    </span>
                  )}
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
                      const href = phone
                        ? `/${locale}/whatsapp?chat_id=${encodeURIComponent(phone)}`
                        : `/${locale}/whatsapp`;
                      return (
                        <a href={href} className="shrink-0 text-muted-foreground hover:text-primary" onClick={(e) => e.stopPropagation()}>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
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

                {/* Row 4: task created */}
                {log.task_title && (
                  <div className="mt-1.5 flex items-center gap-1 text-[11px] text-primary">
                    <span>→</span>
                    <span className="truncate" dir="auto">{log.task_title}</span>
                  </div>
                )}

                {/* Row 5: error (collapsed = clamp, expanded = full) */}
                {log.error_message && (
                  <p className={`mt-1.5 text-[11px] text-red-500 ${isExpanded ? "" : "line-clamp-2"}`}>
                    {log.error_message}
                  </p>
                )}

                {/* Expanded: full AI details panel */}
                {isExpanded && (
                  <div
                    className="mt-3 rounded-md border bg-muted/40 p-3 space-y-2 text-[11px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Header with copy button */}
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-xs text-muted-foreground">{tLog("aiDetails")}</span>
                      <button
                        className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-background border hover:bg-accent transition-colors"
                        onClick={(e) => copyDetails(e, log)}
                      >
                        {copiedId === log.id ? (
                          <><Check className="h-3 w-3 text-green-500" /> {tLog("copied")}</>
                        ) : (
                          <><Copy className="h-3 w-3" /> {tLog("copyDetails")}</>
                        )}
                      </button>
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
        </div>
      )}
    </>
  );
}
