"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw } from "lucide-react";

type LogLevel = "all" | "info" | "warning" | "error";
type TimeRange = "today" | "7d" | "30d";

export default function AdminLogsPage() {
  const t = useTranslations("admin");
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<LogLevel>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("today");

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("log_entries")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (level !== "all") {
      query = query.eq("level", level);
    }

    const now = new Date();
    if (timeRange === "today") {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      query = query.gte("created_at", start.toISOString());
    } else if (timeRange === "7d") {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      query = query.gte("created_at", start.toISOString());
    } else if (timeRange === "30d") {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      query = query.gte("created_at", start.toISOString());
    }

    const { data } = await query;
    setLogs(data || []);
    setLoading(false);
  }, [level, timeRange, supabase]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("systemLogs")}</h1>
        <Button variant="outline" size="icon" className="h-9 w-9" onClick={fetchLogs}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="flex rounded-lg border overflow-hidden">
          {(["all", "error", "warning", "info"] as LogLevel[]).map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`px-3 py-1.5 text-xs font-medium ${level === l ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {l === "all" ? "All" : l.charAt(0).toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border overflow-hidden">
          {(["today", "7d", "30d"] as TimeRange[]).map((tr) => (
            <button
              key={tr}
              onClick={() => setTimeRange(tr)}
              className={`px-3 py-1.5 text-xs font-medium ${timeRange === tr ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {tr === "today" ? "Today" : tr === "7d" ? "7 Days" : "30 Days"}
            </button>
          ))}
        </div>
      </div>

      {/* Log entries */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 rounded" />)}
        </div>
      ) : logs.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">{t("noLogs")}</p>
      ) : (
        <div className="space-y-1">
          {logs.map((log) => (
            <div key={log.id} className="flex items-start gap-2 rounded border p-2 text-sm">
              <Badge
                variant={log.level === "error" ? "destructive" : log.level === "warning" ? "secondary" : "outline"}
                className="text-[10px] mt-0.5"
              >
                {log.level}
              </Badge>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{log.category}</span>
                  <Badge variant="outline" className="text-[10px]">{log.status}</Badge>
                </div>
                {log.subject && <p className="text-xs text-muted-foreground truncate">{log.subject}</p>}
                {log.error_message && <p className="text-xs text-red-500 truncate">{log.error_message}</p>}
                {log.ai_cost_usd && <span className="text-xs text-muted-foreground">${Number(log.ai_cost_usd).toFixed(6)}</span>}
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(log.created_at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
