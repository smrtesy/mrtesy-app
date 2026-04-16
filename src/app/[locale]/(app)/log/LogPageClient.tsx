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
  google_drive: "📁",
  google_calendar: "📅",
};

const statusIcons: Record<string, string> = {
  ok: "✅",
  skipped: "⚠️",
  failed: "🔴",
  duplicate: "🔄",
};

const sourceFilters = [
  { key: "all", label: "הכל", labelEn: "All" },
  { key: "gmail", label: "📧 אימייל", labelEn: "📧 Email" },
  { key: "google_drive", label: "📁 דרייב", labelEn: "📁 Drive" },
  { key: "google_calendar", label: "📅 יומן", labelEn: "📅 Calendar" },
  { key: "whatsapp", label: "💬 WhatsApp", labelEn: "💬 WhatsApp" },
];

interface LogEntry {
  id: string;
  source_type: string;
  status: string;
  category: string;
  ai_classification: string | null;
  created_at: string;
  subject: string | null;
  sender: string | null;
  sender_email: string | null;
  source_url: string | null;
  source_id: string | null;
  recipient: string | null;
  classification_reason: string | null;
  task_title: string | null;
  error_message: string | null;
  ai_model_used: string | null;
  ai_input_tokens: number | null;
  ai_output_tokens: number | null;
  ai_cost_usd: number | null;
  processing_duration_ms: number | null;
}

export function LogPageClient({ locale }: { locale: string }) {
  const t = useTranslations("log");
  const supabase = createClient();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("all");
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
      .from("log_entries")
      .select("*, source_messages!log_source_msg_fk(recipient, source_url, source_id)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (sourceFilter !== "all") {
      query = query.eq("source_type", sourceFilter);
    }

    const { data } = await query;
    const mapped = (data || []).map((row: any) => {
      // Build source URL: prefer source_messages.source_url, fallback to Gmail URL from source_id
      const smUrl = row.source_messages?.source_url || null;
      const smSourceId = row.source_messages?.source_id || row.source_id || null;
      let resolvedUrl = row.source_url || smUrl;
      if (!resolvedUrl && smSourceId) {
        if (row.source_type === "gmail" || row.source_type === "gmail_sent") {
          resolvedUrl = `https://mail.google.com/mail/u/0/#all/${smSourceId}`;
        }
      }
      return {
        ...row,
        source_url: resolvedUrl,
        source_id: smSourceId,
        recipient: row.source_messages?.recipient || null,
      };
    });
    setLogs(mapped as LogEntry[]);
    setLoading(false);

    // Check admin
    const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase());
    setIsAdmin(adminEmails.includes(user.email?.toLowerCase() || ""));
  }, [supabase, sourceFilter]);

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

            return (
              <div
                key={log.id}
                className="rounded-lg border bg-card p-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
              >
                {/* Row 1: source icon + status + category + classification + time */}
                <div className="flex items-center gap-2">
                  <span className="text-base">
                    {sourceIcons[log.source_type || ""] || "📋"}
                  </span>
                  <span className="text-xs">{statusIcons[log.status] || ""}</span>
                  <Badge
                    variant={
                      log.status === "failed" ? "destructive" :
                      log.status === "skipped" ? "secondary" : "outline"
                    }
                    className="text-[10px]"
                  >
                    {log.category}
                  </Badge>
                  {log.ai_classification && (
                    <Badge variant="outline" className="text-[10px]">{log.ai_classification}</Badge>
                  )}
                  <span className="ms-auto text-[10px] text-muted-foreground whitespace-nowrap">
                    {dateFormatter.format(new Date(log.created_at))}
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
