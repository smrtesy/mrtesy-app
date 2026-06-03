"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, ChevronDown, ChevronRight, Copy, Check } from "lucide-react";

type LogLevel = "all" | "info" | "warning" | "error";
type TimeRange = "today" | "7d" | "30d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogEntry = Record<string, any>;

function copyToClipboard(text: string, onDone: () => void) {
  navigator.clipboard.writeText(text).then(onDone).catch(() => {
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    onDone();
  });
}

function LogRow({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const isError = log.level === "error";

  function handleCopy() {
    copyToClipboard(JSON.stringify(log, null, 2), () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Fields to show in expanded view — ordered by usefulness for debugging
  const debugFields = [
    ["id", log.id],
    ["user_id", log.user_id],
    ["level", log.level],
    ["category", log.category],
    ["status", log.status],
    ["source_type", log.source_type],
    ["error_message", log.error_message],
    ["details", log.details ? JSON.stringify(log.details, null, 2) : null],
    ["classification_reason", log.classification_reason],
    ["ai_classification", log.ai_classification],
    ["pre_classification", log.pre_classification],
    ["task_title", log.task_title],
    ["task_action", log.task_action],
    ["subject", log.subject],
    ["sender_email", log.sender_email],
    ["sender", log.sender],
    ["source_id", log.source_id],
    ["source_url", log.source_url],
    ["ai_model_used", log.ai_model_used],
    ["ai_input_tokens", log.ai_input_tokens],
    ["ai_output_tokens", log.ai_output_tokens],
    ["ai_cost_usd", log.ai_cost_usd],
    ["processing_duration_ms", log.processing_duration_ms],
    ["retry_count", log.retry_count],
    ["created_at", log.created_at],
    ["message_received_at", log.message_received_at],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  return (
    <div className={`rounded border text-sm ${isError ? "border-status-late bg-status-late-bg" : ""}`}>
      {/* Summary row */}
      <div
        className="flex items-start gap-2 p-2 cursor-pointer hover:bg-accent/40 rounded"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="mt-0.5 text-muted-foreground shrink-0">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <Badge
          variant={isError ? "destructive" : log.level === "warning" ? "secondary" : "outline"}
          className="text-[10px] shrink-0 mt-0.5"
        >
          {log.level}
        </Badge>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-semibold">{log.category}</span>
            {log.status && <Badge variant="outline" className="text-[10px]">{log.status}</Badge>}
            {log.source_type && <span className="text-[11px] text-muted-foreground">{log.source_type}</span>}
          </div>
          {log.error_message && (
            <p className="text-xs text-status-late mt-0.5 break-words whitespace-pre-wrap">
              {log.error_message}
            </p>
          )}
          {!log.error_message && log.subject && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{log.subject}</p>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
          {new Date(log.created_at).toLocaleString()}
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t px-3 pb-3 pt-2 space-y-2">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={handleCopy}>
              {copied ? <Check className="h-3.5 w-3.5 text-status-ok" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied!" : "Copy JSON"}
            </Button>
          </div>
          <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs font-mono">
            {debugFields.map(([key, val]) => (
              <div key={key} className="contents">
                <span className="text-muted-foreground truncate">{key}</span>
                <span className={`break-all whitespace-pre-wrap ${key === "error_message" ? "text-status-late font-semibold" : ""}`}>
                  {String(val)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminLogsPage() {
  const t = useTranslations("admin");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<LogLevel>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("today");

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    // Super-admin backend route (service-role) so the admin sees platform-wide
    // logs — a user-scoped client only ever sees its own rows under RLS.
    const params = new URLSearchParams({ level, range: timeRange });
    try {
      const { logs } = await api<{ logs: LogEntry[] }>(
        `/api/admin/logs?${params}`,
        { noOrg: true },
      );
      setLogs(logs ?? []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [level, timeRange]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const errorCount = logs.filter((l) => l.level === "error").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{t("systemLogs")}</h1>
          {errorCount > 0 && (
            <Badge variant="destructive">{errorCount} errors</Badge>
          )}
          <span className="text-sm text-muted-foreground">{logs.length} entries</span>
        </div>
        <Button variant="outline" size="icon" className="h-9 w-9" onClick={fetchLogs}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="flex rounded-lg border overflow-hidden">
          {(["all", "error", "warning", "info"] as LogLevel[]).map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${level === l ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {t(`filter${l.charAt(0).toUpperCase() + l.slice(1)}`)}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border overflow-hidden">
          {(["today", "7d", "30d"] as TimeRange[]).map((tr) => (
            <button
              key={tr}
              onClick={() => setTimeRange(tr)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${timeRange === tr ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {t(`filter${tr === "today" ? "Today" : tr === "7d" ? "7d" : "30d"}`)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 rounded" />)}
        </div>
      ) : logs.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">{t("noLogs")}</p>
      ) : (
        <div className="space-y-1">
          {logs.map((log) => <LogRow key={log.id} log={log} />)}
        </div>
      )}
    </div>
  );
}
