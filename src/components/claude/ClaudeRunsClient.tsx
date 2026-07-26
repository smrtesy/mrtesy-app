"use client";

/**
 * Claude runs console — slice 1 of docs/claude-console/plan.md.
 *
 * Launch a run from inside smrtesy and watch its full event stream, all served
 * from our own database. Per the compact-UI convention in CLAUDE.md the launch
 * form is collapsed behind a single icon button and the event stream expands
 * only for the run you open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, Loader2, Play, Plus, X } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";

interface Run {
  id: string;
  title: string;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  claude_account: string | null;
  repo: string | null;
  session_id: string | null;
  result_summary: string | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface RunEvent {
  seq: number;
  kind: string;
  text: string | null;
  tool_name: string | null;
  created_at: string;
}

/** A run in one of these states is still moving, so the view keeps polling. */
const LIVE: Run["status"][] = ["queued", "running"];
const POLL_MS = 2500;

function statusVariant(status: Run["status"]): "default" | "secondary" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "done") return "default";
  return "secondary";
}

export function ClaudeRunsClient() {
  const t = useTranslations("claudeRuns");
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [launching, setLaunching] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Held in a ref so the polling effect doesn't restart on every list refresh.
  const openRunRef = useRef<string | null>(null);
  openRunRef.current = openRun;

  const loadRuns = useCallback(async () => {
    try {
      const { runs: list } = await api<{ runs: Run[] }>("/api/claude/runs");
      setRuns(list ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEvents = useCallback(async (runId: string, quiet = false) => {
    if (!quiet) setEventsLoading(true);
    try {
      const { events: list } = await api<{ run: Run; events: RunEvent[] }>(
        `/api/claude/runs/${runId}`,
      );
      setEvents(list ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      if (!quiet) setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Poll only while something is actually in flight — a finished list is static,
  // so there is nothing to refresh and no reason to keep hitting the backend.
  const hasLive = runs.some((r) => LIVE.includes(r.status));
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => {
      void loadRuns();
      const open = openRunRef.current;
      if (open) void loadEvents(open, true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [hasLive, loadRuns, loadEvents]);

  async function handleLaunch() {
    if (!prompt.trim()) return;
    setLaunching(true);
    try {
      await api("/api/claude/runs", {
        method: "POST",
        body: { title: title.trim() || undefined, prompt: prompt.trim() },
      });
      toast.success(t("launched"));
      setPrompt("");
      setTitle("");
      setFormOpen(false);
      await loadRuns();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  function toggleRun(runId: string) {
    if (openRun === runId) {
      setOpenRun(null);
      setEvents([]);
      return;
    }
    setOpenRun(runId);
    setEvents([]);
    void loadEvents(runId);
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <Button
          size="sm"
          variant={formOpen ? "ghost" : "default"}
          onClick={() => setFormOpen((v) => !v)}
          aria-label={formOpen ? t("cancel") : t("newRun")}
        >
          {formOpen ? <X className="size-4" /> : <Plus className="size-4" />}
        </Button>
      </div>

      {formOpen && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("newRun")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
            />
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("promptPlaceholder")}
              rows={5}
            />
            <p className="text-xs text-muted-foreground">{t("costNote")}</p>
            <Button size="sm" onClick={handleLaunch} disabled={launching || !prompt.trim()}>
              {launching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              <span className="ms-1">{t("launch")}</span>
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => {
            const isOpen = openRun === run.id;
            return (
              <Card key={run.id}>
                <button
                  type="button"
                  onClick={() => toggleRun(run.id)}
                  className="flex w-full items-center gap-2 p-3 text-start"
                >
                  {isOpen ? (
                    <ChevronDown className="size-4 shrink-0" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0" />
                  )}
                  <span className="flex-1 truncate text-sm">{run.title}</span>
                  {LIVE.includes(run.status) && <Loader2 className="size-3 animate-spin" />}
                  <Badge variant={statusVariant(run.status)}>{t(`status.${run.status}`)}</Badge>
                </button>

                {isOpen && (
                  <CardContent className="space-y-2 border-t pt-3">
                    {run.error && (
                      <p className="text-xs text-destructive whitespace-pre-wrap">{run.error}</p>
                    )}
                    {run.result_summary && (
                      <p className="text-sm whitespace-pre-wrap">{run.result_summary}</p>
                    )}

                    {eventsLoading ? (
                      <Skeleton className="h-24 w-full" />
                    ) : events.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("noEvents")}</p>
                    ) : (
                      <div className="max-h-96 space-y-1 overflow-y-auto">
                        {events.map((ev) => (
                          <div key={ev.seq} className="rounded border p-2 text-xs">
                            <div className="mb-1 flex items-center gap-2 text-muted-foreground">
                              <span>{ev.kind}</span>
                              {ev.tool_name && <span className="font-mono">{ev.tool_name}</span>}
                            </div>
                            {ev.text && <pre className="whitespace-pre-wrap break-words">{ev.text}</pre>}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
