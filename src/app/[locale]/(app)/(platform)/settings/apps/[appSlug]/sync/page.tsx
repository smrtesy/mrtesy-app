"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Play, RefreshCw, CheckCircle2, XCircle, Clock,
  FileSearch, Zap, StopCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

interface RunSession {
  id: string;
  run_title: string;
  run_type: string;
  part: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  tasks_created: number | null;
  tasks_updated: number | null;
  items_processed: number | null;
  actionable_count: number | null;
  informational_count: number | null;
  rules_added: number | null;
  errors_count: number | null;
  summary: string | null;
}

interface SyncSchedule {
  part: string;
  is_auto: boolean;
  is_enabled: boolean;
  last_run_at: string | null;
}

const PARTS = [
  {
    key: "part0",
    label: "PART 0 — Style Learning",
    description: "Learn writing style from sent emails (manual only, run once)",
    icon: Zap,
    color: "text-muted-foreground",
    manualOnly: true,
  },
  {
    key: "part1",
    label: "PART 1 — Email + Drive + Calendar",
    description: "Collect new emails, Drive documents, and calendar events",
    icon: FileSearch,
    color: "text-muted-foreground",
    manualOnly: false,
  },
  // Part 2 (WhatsApp) is now event-driven via /api/webhooks/whatsapp,
  // not cron-pulled, so it's intentionally absent from this sync UI.
  // Part 3 (classifier) is now the ai-process edge function via pg_cron,
  // not cron-pulled from server, so it's intentionally absent from this sync UI.
] as const;

function statusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    running:   { label: "Running",   className: "bg-accent text-accent-foreground border-primary" },
    completed: { label: "Completed", className: "bg-status-ok-bg text-status-ok border-status-ok" },
    partial:   { label: "Partial",   className: "bg-status-warn-bg text-status-warn border-status-warn" },
    failed:    { label: "Failed",    className: "bg-status-late-bg text-status-late border-status-late" },
  };
  const s = map[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={s.className}>{s.label}</Badge>;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function SettingsSyncPage() {
  const supabase = createClient();
  const { appSlug } = useParams<{ appSlug: string }>();
  const [sessions, setSessions] = useState<RunSession[]>([]);
  const [schedules, setSchedules] = useState<Record<string, SyncSchedule>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [sessionsRes, schedulesRes] = await Promise.all([
      supabase
        .from("run_sessions")
        .select("*")
        .eq("user_id", user.id)
        .eq("app_slug", appSlug)
        .order("started_at", { ascending: false })
        .limit(30),
      supabase
        .from("sync_schedules")
        .select("*")
        .eq("user_id", user.id)
        .eq("app_slug", appSlug),
    ]);

    setSessions(sessionsRes.data ?? []);
    const sched: Record<string, SyncSchedule> = {};
    for (const s of schedulesRes.data ?? []) sched[s.part] = s;
    setSchedules(sched);
    setLoading(false);
  }, [supabase, appSlug]);

  useEffect(() => {
    loadData();

    // Replace 5s polling with realtime subscription — fires only on actual changes.
    const channel = supabase
      .channel("sync-page-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "run_sessions" }, loadData)
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_schedules" }, loadData)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadData, supabase]);

  async function triggerPart(part: "part0" | "part1") {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error("Not authenticated"); return; }

    setRunning((r) => ({ ...r, [part]: true }));
    try {
      const res = await fetch(`${BACKEND_URL}/api/sync/${part}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(
          part === "part0" ? { language: "he" } : {}
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Unknown error");
      toast.success(`${part.toUpperCase()} started (session ${json.session_id?.slice(0, 8)})`);
      setTimeout(loadData, 2000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning((r) => ({ ...r, [part]: false }));
    }
  }

  async function cancelSession(sessionId?: string) {
    try {
      const result = await api<{ ok: boolean; cancelled: number }>("/api/sync/cancel", {
        method: "POST",
        body: sessionId ? { session_id: sessionId } : {},
      });
      toast.success(`Stopped ${result.cancelled} running session${result.cancelled === 1 ? "" : "s"}`);
      loadData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleAuto(part: string, currentAuto: boolean) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase.from("sync_schedules").upsert(
      {
        user_id: user.id,
        app_slug: appSlug,
        part,
        is_auto: !currentAuto,
        is_enabled: true,
        next_run_at: !currentAuto ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() : null,
      },
      { onConflict: "user_id,app_slug,part" },
    );
    if (error) { toast.error(error.message); return; }
    await loadData();
    toast.success(`Auto-sync ${!currentAuto ? "enabled" : "disabled"} for ${part.toUpperCase()}`);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  const recentByPart = (part: string) =>
    sessions.filter((s) => s.part === part).slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold min-w-0 truncate">Sync Control</h1>
        <div className="flex items-center gap-2 shrink-0">
          {sessions.some((s) => s.status === "running") && (
            <Button variant="destructive" size="sm" onClick={() => cancelSession()} className="gap-1.5">
              <StopCircle className="h-4 w-4" />
              Stop all
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={loadData} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Part cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {PARTS.map((part) => {
          const Icon = part.icon;
          const sched = schedules[part.key];
          const runningSession = sessions.find((s) => s.part === part.key && s.status === "running");
          const isRunning = running[part.key] || !!runningSession;
          const last = recentByPart(part.key)[0];

          return (
            <Card key={part.key}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className={`h-5 w-5 ${part.color}`} />
                  {part.label}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{part.description}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {last && (
                  <div className="rounded-lg bg-muted p-3 space-y-1">
                    <div className="flex items-center justify-between">
                      {statusBadge(last.status)}
                      <span className="text-xs text-muted-foreground">
                        {formatDuration(last.duration_seconds)}
                      </span>
                    </div>
                    {last.summary && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{last.summary}</p>
                    )}
                    <div className="flex gap-3 text-xs text-muted-foreground">
                      {last.tasks_created ? <span>+{last.tasks_created} tasks</span> : null}
                      {last.items_processed ? <span>{last.items_processed} items</span> : null}
                      {(last.errors_count ?? 0) > 0 ? (
                        <span className="text-status-late">{last.errors_count} errors</span>
                      ) : null}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={isRunning}
                    onClick={() => triggerPart(part.key as "part0" | "part1")}
                  >
                    {isRunning ? (
                      <RefreshCw className="h-4 w-4 me-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 me-2" />
                    )}
                    {isRunning ? "Running…" : "Run Now"}
                  </Button>

                  {runningSession && (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="gap-1"
                      onClick={() => cancelSession(runningSession.id)}
                      title="Cancel this run"
                    >
                      <StopCircle className="h-4 w-4" />
                      Stop
                    </Button>
                  )}

                  {!part.manualOnly && (
                    <Button
                      size="sm"
                      variant={sched?.is_auto ? "default" : "outline"}
                      className="gap-1"
                      onClick={() => toggleAuto(part.key, sched?.is_auto ?? false)}
                    >
                      {sched?.is_auto ? (
                        <><CheckCircle2 className="h-4 w-4" /> Auto</>
                      ) : (
                        <><Clock className="h-4 w-4" /> Manual</>
                      )}
                    </Button>
                  )}
                </div>

                {sched?.last_run_at && (
                  <p className="text-xs text-muted-foreground">
                    Last run: {new Date(sched.last_run_at).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Run history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Run History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No runs yet. Click &quot;Run Now&quot; to start.
            </p>
          ) : (
            <div className="space-y-2">
              {sessions.slice(0, 20).map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-lg border p-3 text-sm"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {s.status === "completed" ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-status-ok" />
                    ) : s.status === "failed" ? (
                      <XCircle className="h-4 w-4 shrink-0 text-status-late" />
                    ) : s.status === "running" ? (
                      <RefreshCw className="h-4 w-4 shrink-0 text-primary animate-spin" />
                    ) : (
                      <Clock className="h-4 w-4 shrink-0 text-status-warn" />
                    )}
                    <div className="min-w-0">
                      <p className="font-medium truncate">{s.run_title}</p>
                      {s.summary && (
                        <p className="text-xs text-muted-foreground truncate">{s.summary}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ms-3">
                    <span className="text-xs text-muted-foreground">
                      {formatDuration(s.duration_seconds)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(s.started_at).toLocaleString()}
                    </span>
                    {statusBadge(s.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
