"use client";

/**
 * Claude runs console — docs/claude-console/plan.md.
 *
 * Launch a run from inside smrtesy and watch its full event stream, all served
 * from our own database. Per the compact-UI convention in CLAUDE.md the launch
 * form and the usage panel are both collapsed behind a single icon button, and
 * the event stream expands only for the run you open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BarChart3, BookOpen, ChevronDown, ChevronRight, Loader2, Play, Plus, Sparkles, X } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";
import { UpdateInput } from "@/components/smrttask/tasks/UpdateInput";
import { DictationButton } from "./DictationButton";
import { PlaybookList } from "./PlaybookList";
import { RepoPicker } from "./RepoPicker";
import { StandingInstructions } from "./StandingInstructions";

interface Run {
  id: string;
  title: string;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  claude_account: string | null;
  repo: string | null;
  git_branch: string | null;
  playbook_id: string | null;
  /** What the human typed, before the standing instructions and the method were
   *  prepended server-side. */
  user_prompt: string | null;
  session_id: string | null;
  result_summary: string | null;
  error: string | null;
  model: string | null;
  effort: string | null;
  total_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  num_turns: number | null;
  duration_ms: number | null;
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

interface Usage {
  window_days: number;
  totals: {
    runs: number;
    done: number;
    failed: number;
    cost_usd_equivalent: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    turns: number;
    duration_ms: number;
  };
  by_model: { model: string; cost: number; input: number; output: number; runs: number }[];
  disclaimer: { billing: string; remaining: string; scope: string };
}

/** A run in one of these states is still moving, so the view keeps polling. */
const LIVE: Run["status"][] = ["queued", "running"];
const POLL_MS = 2500;

/** Aliases the CLI documents for --model. "" means send nothing and let the CLI
 *  pick its current default, which is why it is the first option. */
const MODELS = ["", "opus", "sonnet", "fable"] as const;
/** The CLI's closed set for --effort. */
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;

/** Select cannot hold "" as a value, so the default option needs a sentinel. */
const DEFAULT_OPT = "__default__";

function statusVariant(status: Run["status"]): "default" | "secondary" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "done") return "default";
  return "secondary";
}

const fmtInt = (n: number | null | undefined) =>
  typeof n === "number" ? n.toLocaleString() : "—";

/** Costs here run from ~$0.0006 to a few dollars, so a fixed 2 decimals would show
 *  most real runs as $0.00. Small values keep more precision. */
function fmtCost(n: number | null | undefined): string {
  if (typeof n !== "number") return "—";
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function ClaudeRunsClient() {
  const t = useTranslations("claudeRuns");
  const locale = useLocale();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  /** The free-text task router ("עדכון"), which used to be its own sidebar button.
   *  It kept its place in the product by moving here rather than being deleted. */
  const [updateOpen, setUpdateOpen] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>(DEFAULT_OPT);
  const [effort, setEffort] = useState<string>(DEFAULT_OPT);
  /** Which working method the next run follows (claude_playbooks.id) — the backend
   *  prepends its instructions to the prompt. */
  const [playbookId, setPlaybookId] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  /** Dictation: speak, pause 3s, and it launches. On by default because that is
   *  the behaviour asked for; a toggle exists because a long prompt deserves a
   *  read-through before it runs. */
  const [autoSend, setAutoSend] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Held in refs so the polling effect doesn't restart on every list refresh.
  const openRunRef = useRef<string | null>(null);
  openRunRef.current = openRun;
  const usageOpenRef = useRef(false);
  usageOpenRef.current = usageOpen;

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

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await api<Usage>("/api/claude/usage"));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
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
      if (usageOpenRef.current) void loadUsage();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [hasLive, loadRuns, loadEvents, loadUsage]);

  function toggleUsage() {
    const next = !usageOpen;
    setUsageOpen(next);
    if (next && !usage) void loadUsage();
  }

  /**
   * `override` exists for dictation: the transcript arrives in a callback, and
   * reading `prompt` here would use the value from before setPrompt — launching an
   * empty run. The text that was heard is passed in explicitly instead.
   *
   * The method and the standing instructions are NOT composed here: the backend
   * prepends them, so a run can never quietly go out without them.
   */
  const handleLaunch = useCallback(
    async (override?: string) => {
      const text = (override ?? prompt).trim();
      if (!text || launching) return;
      setLaunching(true);
      try {
        await api("/api/claude/runs", {
          method: "POST",
          body: {
            title: title.trim() || undefined,
            prompt: text,
            model: model === DEFAULT_OPT ? undefined : model,
            effort: effort === DEFAULT_OPT ? undefined : effort,
            playbook_id: playbookId ?? undefined,
            repo: repo ?? undefined,
            git_branch: repo ? branch ?? undefined : undefined,
          },
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
    },
    [prompt, launching, title, model, effort, playbookId, repo, branch, t, loadRuns],
  );

  /** Dictation result. With auto-send on, the transcript launches immediately —
   *  speak, pause, done. With it off it lands in the box for review. */
  const handleDictated = useCallback(
    (text: string) => {
      // Combined once and used for both the box and the launch: launching with the
      // transcript alone would silently drop anything already typed.
      const combined = prompt.trim() ? `${prompt.trim()} ${text}` : text;
      setPrompt(combined);
      if (!autoSend) return;
      setFormOpen(true);
      void handleLaunch(combined);
    },
    [prompt, autoSend, handleLaunch],
  );

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
        <div className="flex items-center gap-1">
          {/* Dictation sits in the header, not only inside the form: the whole point
              is that speaking is the fastest way in — no "open the form" step. */}
          <DictationButton onText={handleDictated} disabled={launching} />
          <Button
            size="sm"
            variant={updateOpen ? "secondary" : "ghost"}
            onClick={() => setUpdateOpen(true)}
            aria-label={t("taskRouter")}
            title={t("taskRouter")}
          >
            <Sparkles className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={instructionsOpen ? "secondary" : "ghost"}
            onClick={() => setInstructionsOpen((v) => !v)}
            aria-label={t("instructions.title")}
            title={t("instructions.title")}
          >
            <BookOpen className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={usageOpen ? "secondary" : "ghost"}
            onClick={toggleUsage}
            aria-label={t("usage.title")}
            title={t("usage.title")}
          >
            <BarChart3 className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={formOpen ? "ghost" : "default"}
            onClick={() => setFormOpen((v) => !v)}
            aria-label={formOpen ? t("cancel") : t("newRun")}
          >
            {formOpen ? <X className="size-4" /> : <Plus className="size-4" />}
          </Button>
        </div>
      </div>

      {instructionsOpen && (
        <Card>
          <CardContent className="pt-4">
            <StandingInstructions locale={locale} />
          </CardContent>
        </Card>
      )}

      {usageOpen && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {t("usage.title")}
              {usage ? ` · ${t("usage.windowDays", { days: usage.window_days })}` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!usage ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Stat label={t("usage.runs")} value={String(usage.totals.runs)} />
                  <Stat label={t("usage.failed")} value={String(usage.totals.failed)} />
                  <Stat label={t("usage.inputTokens")} value={fmtInt(usage.totals.input_tokens)} />
                  <Stat label={t("usage.outputTokens")} value={fmtInt(usage.totals.output_tokens)} />
                  <Stat
                    label={t("usage.cacheRead")}
                    value={fmtInt(usage.totals.cache_read_tokens)}
                  />
                  <Stat
                    label={t("usage.cacheWrite")}
                    value={fmtInt(usage.totals.cache_creation_tokens)}
                  />
                  <Stat label={t("usage.turns")} value={fmtInt(usage.totals.turns)} />
                  <Stat
                    label={t("usage.costEquivalent")}
                    value={fmtCost(usage.totals.cost_usd_equivalent)}
                  />
                </div>

                {usage.by_model.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("usage.byModel")}
                    </p>
                    {usage.by_model.map((m) => (
                      <div
                        key={m.model}
                        className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
                      >
                        <span className="truncate font-mono">{m.model}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {fmtInt(m.input)} / {fmtInt(m.output)} · {fmtCost(m.cost)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Stated in the UI, not just the API: the cost figure is a consumption
                    measure on a subscription, and remaining quota genuinely is not
                    available to us — leaving that implicit would be misleading. */}
                <div className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
                  <p>{usage.disclaimer.billing}</p>
                  <p>{usage.disclaimer.remaining}</p>
                  <p>{usage.disclaimer.scope}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {formOpen && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("newRun")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Choosing the method comes FIRST: "I want to open a research" is the
                decision, and the prompt is what to research within it. */}
            <PlaybookList locale={locale} selectedId={playbookId} onSelect={setPlaybookId} />

            <RepoPicker
              locale={locale}
              repo={repo}
              branch={branch}
              onChange={(next) => {
                setRepo(next.repo);
                setBranch(next.branch);
              }}
            />

            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
            />
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter makes a newline. isComposing is checked so
                // an IME's confirmation Enter doesn't submit a half-typed word.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleLaunch();
                }
              }}
              placeholder={t("promptPlaceholder")}
              rows={5}
            />
            <div className="flex flex-wrap gap-2">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder={t("model.label")} />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m || DEFAULT_OPT} value={m || DEFAULT_OPT}>
                      {m ? m : t("model.default")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder={t("effort.label")} />
                </SelectTrigger>
                <SelectContent>
                  {EFFORTS.map((e) => (
                    <SelectItem key={e || DEFAULT_OPT} value={e || DEFAULT_OPT}>
                      {e ? t(`effort.${e}`) : t("effort.default")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DictationButton onText={handleDictated} disabled={launching} />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoSend}
                  onChange={(e) => setAutoSend(e.target.checked)}
                  className="size-3.5"
                />
                {t("dictation.autoSend")}
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{t("submitHint")}</p>
            <p className="text-xs text-muted-foreground">{t("costNote")}</p>
            <p className="text-xs text-muted-foreground">{t("dictation.costNote")}</p>
            <Button size="sm" onClick={() => void handleLaunch()} disabled={launching || !prompt.trim()}>
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
                  {run.repo && (
                    <span
                      dir="ltr"
                      className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline"
                    >
                      {run.repo}
                      {run.git_branch ? `@${run.git_branch}` : ""}
                    </span>
                  )}
                  {run.model && (
                    <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
                      {run.model}
                    </span>
                  )}
                  {LIVE.includes(run.status) && <Loader2 className="size-3 animate-spin" />}
                  <Badge variant={statusVariant(run.status)}>{t(`status.${run.status}`)}</Badge>
                </button>

                {isOpen && (
                  <CardContent className="space-y-2 border-t pt-3">
                    {run.user_prompt && (
                      <p className="whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs" dir="auto">
                        {run.user_prompt}
                      </p>
                    )}
                    {run.error && (
                      <p className="text-xs text-destructive whitespace-pre-wrap">{run.error}</p>
                    )}
                    {run.result_summary && (
                      <p className="text-sm whitespace-pre-wrap">{run.result_summary}</p>
                    )}

                    {(run.total_cost_usd !== null || run.output_tokens !== null) && (
                      <div className="grid grid-cols-2 gap-2 rounded border p-2 text-xs sm:grid-cols-4">
                        <Stat label={t("usage.inputTokens")} value={fmtInt(run.input_tokens)} />
                        <Stat label={t("usage.outputTokens")} value={fmtInt(run.output_tokens)} />
                        <Stat label={t("usage.cacheRead")} value={fmtInt(run.cache_read_tokens)} />
                        <Stat
                          label={t("usage.costEquivalent")}
                          value={fmtCost(run.total_cost_usd)}
                        />
                        <Stat label={t("usage.turns")} value={fmtInt(run.num_turns)} />
                        <Stat label={t("usage.duration")} value={fmtDuration(run.duration_ms)} />
                        {run.effort && <Stat label={t("effort.label")} value={run.effort} />}
                      </div>
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
                            {ev.text && (
                              <pre className="whitespace-pre-wrap break-words">{ev.text}</pre>
                            )}
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

      {/* The free-text task router, kept reachable after it lost its sidebar button.
          onApplied only closes it: a reload here would throw away an in-flight run
          list and the prompt being written. */}
      <UpdateInput
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        onApplied={() => setUpdateOpen(false)}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
