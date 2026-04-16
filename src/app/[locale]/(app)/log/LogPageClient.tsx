"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ChevronDown, ChevronUp } from "lucide-react";

const sourceIcons: Record<string, string> = {
  gmail: "📧",
  gmail_sent: "📤",
  whatsapp: "💬",
  whatsapp_echo: "💬",
  google_drive: "📁",
  google_calendar: "📅",
};

const processingBadge: Record<string, { variant: "default" | "secondary" | "outline"; label: string; labelEn: string }> = {
  pending: { variant: "secondary", label: "ממתין", labelEn: "Pending" },
  processed: { variant: "outline", label: "עובד", labelEn: "Processed" },
};

const classificationColors: Record<string, string> = {
  actionable: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  informational: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  spam: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  skip: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  pending: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
};

const sourceFilters = [
  { key: "all", label: "הכל", labelEn: "All" },
  { key: "gmail", label: "📧 אימייל", labelEn: "📧 Email" },
  { key: "google_drive", label: "📁 דרייב", labelEn: "📁 Drive" },
  { key: "google_calendar", label: "📅 יומן", labelEn: "📅 Calendar" },
  { key: "whatsapp", label: "💬 WhatsApp", labelEn: "💬 WhatsApp" },
];

const statusFilters = [
  { key: "all", label: "הכל", labelEn: "All" },
  { key: "pending", label: "ממתין", labelEn: "Pending" },
  { key: "processed", label: "עובד", labelEn: "Processed" },
];

interface SourceEntry {
  id: string;
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
  error_message: string | null;
  log_status: string | null;
  ai_model_used: string | null;
  ai_input_tokens: number | null;
  ai_output_tokens: number | null;
  ai_cost_usd: number | null;
  processing_duration_ms: number | null;
}

export function LogPageClient({ locale }: { locale: string }) {
  const t = useTranslations("log");
  const supabase = createClient();
  const [logs, setLogs] = useState<SourceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const dateFmtLocale = locale === "he" ? "he-IL" : "en-US";
  const dateFormatter = new Intl.DateTimeFormat(dateFmtLocale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    let query = supabase
      .from("source_messages")
      .select("*, log_entries!log_source_msg_fk(classification_reason, task_title, error_message, status, ai_model_used, ai_input_tokens, ai_output_tokens, ai_cost_usd, processing_duration_ms)")
      .order("received_at", { ascending: false })
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
    const mapped = (data || []).map((row: any) => {
      // log_entries is an array (one source_message can have multiple log entries)
      // Take the most recent one (last in array)
      const logArr = row.log_entries || [];
      const logEntry = logArr.length > 0 ? logArr[logArr.length - 1] : null;

      // Resolve source URL
      let resolvedUrl = row.source_url || null;
      if (!resolvedUrl && row.source_id) {
        if (row.source_type === "gmail" || row.source_type === "gmail_sent") {
          resolvedUrl = `https://mail.google.com/mail/u/0/#all/${row.source_id}`;
        }
      }

      return {
        id: row.id,
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
        // From log_entries
        classification_reason: logEntry?.classification_reason || null,
        task_title: logEntry?.task_title || null,
        error_message: logEntry?.error_message || null,
        log_status: logEntry?.status || null,
        ai_model_used: logEntry?.ai_model_used || null,
        ai_input_tokens: logEntry?.ai_input_tokens || null,
        ai_output_tokens: logEntry?.ai_output_tokens || null,
        ai_cost_usd: logEntry?.ai_cost_usd || null,
        processing_duration_ms: logEntry?.processing_duration_ms || null,
      };
    });
    setLogs(mapped as SourceEntry[]);
    setLoading(false);

    // Check admin
    const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase());
    setIsAdmin(adminEmails.includes(user.email?.toLowerCase() || ""));
  }, [supabase, sourceFilter, statusFilter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

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
            {locale === "he" ? f.label : f.labelEn}
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
            {locale === "he" ? f.label : f.labelEn}
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
            const displayTitle = log.subject || log.sender || (locale === "he" ? "הודעה ללא נושא" : "No subject");
            const displayDate = log.received_at || log.created_at;
            const badge = processingBadge[log.processing_status] || processingBadge.pending;
            const classColor = classificationColors[log.ai_classification || "pending"] || "";

            return (
              <div
                key={log.id}
                className={`rounded-lg border bg-card p-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors ${
                  log.processing_status === "pending" ? "opacity-75" : ""
                }`}
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
              >
                {/* Row 1: source icon + processing status + classification + time */}
                <div className="flex items-center gap-2">
                  <span className="text-base">
                    {sourceIcons[log.source_type || ""] || "📋"}
                  </span>
                  <Badge variant={badge.variant} className="text-[10px]">
                    {locale === "he" ? badge.label : badge.labelEn}
                  </Badge>
                  {log.ai_classification && log.ai_classification !== "pending" && (
                    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${classColor}`}>
                      {log.ai_classification}
                    </span>
                  )}
                  {log.log_status === "failed" && (
                    <span className="text-xs">🔴</span>
                  )}
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
                  {log.source_url && (
                    <a
                      href={log.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-muted-foreground hover:text-primary"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>

                {/* Row 3: classification reason (collapsed = 2 lines, expanded = full) */}
                {log.classification_reason && (
                  <p className={`mt-1.5 text-[11px] text-muted-foreground/80 ${isExpanded ? "" : "line-clamp-2"}`} dir="auto">
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

                {/* Row 5: error */}
                {log.error_message && (
                  <p className={`mt-1.5 text-[11px] text-red-500 ${isExpanded ? "" : "line-clamp-2"}`}>
                    {log.error_message}
                  </p>
                )}

                {/* Row 6: admin-only cost info */}
                {isAdmin && (log.ai_cost_usd || log.ai_model_used) && (
                  <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/60">
                    {log.ai_model_used && <span>{log.ai_model_used}</span>}
                    {log.ai_input_tokens && <span>{log.ai_input_tokens}+{log.ai_output_tokens} tok</span>}
                    {log.ai_cost_usd && <span>${Number(log.ai_cost_usd).toFixed(5)}</span>}
                    {log.processing_duration_ms && <span>{log.processing_duration_ms}ms</span>}
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
