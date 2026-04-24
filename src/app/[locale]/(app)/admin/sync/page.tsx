"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Play, RefreshCw, CheckCircle2, XCircle, Clock,
  MessageSquare, FileSearch, Zap,
} from "lucide-react";
import { toast } from "sonner";

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
    key: "part2",
    label: "PART 2 — WhatsApp",
    description: "Read new messages from Google Sheet and create tasks",
    icon: MessageSquare,
    color: "text-emerald-500",
  },
  {
    key: "part3",
    label: "PART 3 — Classifier",
    description: "Classify pending source messages into tasks with Claude AI",
    icon: FileSearch,
    color: "text-blue-500",
  },
] as const;

function statusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    running:   { label: "Running",   className: "bg-blue-100 text-blue-700 border-blue-200" },
    completed: { label: "Completed", className: "bg-green-100 text-green-700 border-green-200" },
    partial:   { label: "Partial",   className: "bg-yellow-100 text-yellow-700 border-yellow-200" },
    failed:    { label: "Failed",    className: "bg-red-100 text-red-700 border-red-200" },
  };
  const s = map[status] ?? { label: status, className: "bg-gray-100 text-gray-700" };
  return <Badge variant="outline" className={s.className}>{s.label}</Badge>;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function AdminSyncPage() {
  const supabase = createClient();
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
        .order("started_at", { ascending: false })
        .limit(30),
      supabase
        .from("sync_schedules")
        .select("*")
        .eq("user_id", user.id),
    ]);

    setSessions(sessionsRes.data ?? []);
    const sched: Record<string, SyncSchedule> = {};
    for (const s of schedulesRes.data ?? []) sched[s.part] = s;
    setSchedules(sched);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadData();
    // Poll every 5 seconds while a run session might be active
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  async function triggerPart(part: "part2" | "part3") {
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
        body: JSON.stringify(part === "part2" ? { lookback_hours: 48 } : { limit: 50 }),
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

  async function toggleAuto(part: string, currentAuto: boolean) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from("sync_schedules").upsert(
      {
        user_id: user.id,
        part,
        is_auto: !currentAuto,
        is_enabled: true,
        next_run_at: !currentAuto ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() : null,
      },
      { onConflict: "user_id,part" },
    );
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Sync Control</h1>
        <Button variant="outline" size="sm" onClick={loadData}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Part cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {PARTS.map((part) => {
          const Icon = part.icon;
          const sched = schedules[part.key];
          const isRunning = running[part.key] || sessions.some((s) => s.part === part.key && s.status === "running");
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
                        <span className="text-red-500">{last.errors_count} errors</span>
                      ) : null}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={isRunning}
                    onClick={() => triggerPart(part.key as "part2" | "part3")}
                  >
                    {isRunning ? (
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-2" />
                    )}
                    {isRunning ? "Running…" : "Run Now"}
                  </Button>

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
              No runs yet. Click "Run Now" to start.
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
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                    ) : s.status === "failed" ? (
                      <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                    ) : s.status === "running" ? (
                      <RefreshCw className="h-4 w-4 shrink-0 text-blue-500 animate-spin" />
                    ) : (
                      <Clock className="h-4 w-4 shrink-0 text-yellow-500" />
                    )}
                    <div className="min-w-0">
                      <p className="font-medium truncate">{s.run_title}</p>
                      {s.summary && (
                        <p className="text-xs text-muted-foreground truncate">{s.summary}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-3">
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
