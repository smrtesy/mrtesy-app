"use client";

/**
 * Claude, as a chat — the screen.
 *
 * What makes it a conversation and not a form: a thread owns the engine's session
 * id, so every message after the first is resumed into it (server threads.ts +
 * runner.ts). Opening an old thread and typing continues that same discussion.
 *
 * COMPACT BY DEFAULT (CLAUDE.md). The screen is a title bar, the conversation, and
 * the composer. The thread list is a rail you open; the working method, repo,
 * model, effort, standing instructions and usage all live behind ONE settings
 * button and are closed until asked for. Nothing configures itself in your face.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useScreenSearchParams } from "@/lib/panes/nav";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { ChatComposer } from "./ChatComposer";
import { PlaybookList } from "./PlaybookList";
import { RepoPicker } from "./RepoPicker";
import { StandingInstructions } from "./StandingInstructions";
import { UpdateInput } from "@/components/smrttask/tasks/UpdateInput";

/**
 * Models, with the id visible — not just a friendly name.
 *
 * The value sent to the engine IS the id shown, so what you read is what runs. An
 * alias ("opus") would track the newest model but then the id on screen would be a
 * guess about what it resolved to.
 */
const MODELS = [
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-fable-5", name: "Fable 5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
] as const;

/** Opus by default, by request. A smarter per-task choice is a later job. */
const DEFAULT_MODEL = "claude-opus-5";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_DEFAULT = "__default__";

const LIVE = ["queued", "running"] as const;
const POLL_MS = 1500;

interface Thread {
  id: string;
  title: string;
  title_source: "auto" | "user";
  session_id: string | null;
  model: string | null;
  effort: string | null;
  repo: string | null;
  git_branch: string | null;
  playbook_id: string | null;
  last_message_at: string;
}

interface TurnEvent {
  seq: number;
  kind: string;
  text: string | null;
  tool_name: string | null;
}

interface Turn {
  id: string;
  turn_index: number;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  user_prompt: string | null;
  result_summary: string | null;
  error: string | null;
  /** The session this turn resumed into. Null on a turn past the first means it
   *  started a NEW session — the conversation lost its earlier context. */
  resumed_session: string | null;
  created_at: string;
  events: TurnEvent[];
  attachments: { id: string; filename: string }[];
}

export function ClaudeChat() {
  const t = useTranslations("claudeChat");
  const locale = useLocale();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The free-text task router ("עדכון"). It lost its sidebar button to the chat,
   *  so it lives here — inside the collapsed panel, not as new permanent chrome. */
  const [updateOpen, setUpdateOpen] = useState(false);
  const [sending, setSending] = useState(false);
  /** Settings chosen BEFORE the thread exists. patchThread cannot persist them yet,
   *  and without holding them the thread was created on the default model — so
   *  picking Sonnet and sending ran Opus with no error shown. */
  const [pending, setPending] = useState<Record<string, unknown>>({});

  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** Mirrors activeId for the async guard in loadThread. Synced in an effect, not
   *  during render — a render-phase write is unsafe under StrictMode's double
   *  invocation. ensureThread also sets it directly, which is fine: that happens
   *  inside a callback, not during rendering. */
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Deep-link: /claude?thread=<id> opens straight onto that conversation (e.g.
  // the "continue with Claude" button on a correction). Applied ONCE, so the
  // user can freely switch threads afterwards without the URL yanking them back.
  const screenSearch = useScreenSearchParams();
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    if (deepLinkedRef.current) return;
    const tid = screenSearch.get("thread");
    if (tid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid)) {
      deepLinkedRef.current = true;
      setActiveId(tid);
      activeIdRef.current = tid;
    }
  }, [screenSearch]);

  const loadThreads = useCallback(async () => {
    try {
      const { threads: list } = await api<{ threads: Thread[] }>("/api/claude/threads");
      setThreads(list ?? []);
      return list ?? [];
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    try {
      const r = await api<{ thread: Thread; turns: Turn[] }>(`/api/claude/threads/${id}`);
      // Ignored when the user has already switched away: a slow response for the
      // previous thread must not paint over the one now on screen.
      if (activeIdRef.current !== id) return;
      setThread(r.thread);
      setTurns(r.turns ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (activeId) void loadThread(activeId);
    else {
      setThread(null);
      setTurns([]);
    }
  }, [activeId, loadThread]);

  // Poll only while a turn is actually moving. A finished conversation is static,
  // so there is nothing to fetch and no reason to keep asking.
  const hasLive = turns.some((x) => (LIVE as readonly string[]).includes(x.status));
  useEffect(() => {
    if (!hasLive || !activeId) return;
    const id = setInterval(() => {
      void loadThread(activeId);
      void loadThreads();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [hasLive, activeId, loadThread, loadThreads]);

  useEffect(() => {
    // nearest, not the default: scrollIntoView on a pane-embedded screen otherwise
    // scrolls the ancestor pane too, yanking the whole workspace.
    bottomRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
  }, [turns.length, hasLive]);

  /** Create the thread on demand — on the first send, or the moment a file is
   *  attached. Threads are never created just by opening the screen: an empty
   *  conversation in the list is noise. */
  const ensureThread = useCallback(async (): Promise<string | null> => {
    if (activeId) return activeId;
    try {
      const { thread: created } = await api<{ thread: Thread }>("/api/claude/threads", {
        method: "POST",
        body: { model: DEFAULT_MODEL, ...pending },
      });
      setPending({});
      setThreads((prev) => [created, ...prev]);
      setThread(created);
      setActiveId(created.id);
      activeIdRef.current = created.id;
      return created.id;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [activeId, pending]);

  const send = useCallback(
    async (message: string, attachmentIds: string[]) => {
      const id = await ensureThread();
      if (!id) return;
      setSending(true);
      // Shown immediately with a queued status, so the message appears the moment
      // Enter is pressed instead of after the round trip.
      const optimistic: Turn = {
        id: `pending-${Date.now()}`,
        turn_index: turns.length + 1,
        status: "queued",
        user_prompt: message,
        result_summary: null,
        error: null,
        resumed_session: null,
        created_at: new Date().toISOString(),
        events: [],
        attachments: [],
      };
      setTurns((prev) => [...prev, optimistic]);
      try {
        await api(`/api/claude/threads/${id}/messages`, {
          method: "POST",
          body: { message, attachment_ids: attachmentIds },
        });
      } catch (e) {
        setTurns((prev) => prev.filter((x) => x.id !== optimistic.id));
        toast.error(e instanceof Error ? e.message : String(e));
        setSending(false);
        // Rethrown so the composer puts the text and the attachment chips back.
        throw e;
      }
      setSending(false);
      // Outside the try on purpose: the turn IS running by now. A blip on this
      // refresh used to remove the optimistic bubble and show a send error, leaving
      // the screen with nothing live to poll while the turn ran on regardless.
      try {
        await loadThread(id);
      } catch {
        // The poll picks it up.
      }
    },
    [ensureThread, turns.length, loadThread],
  );

  const liveTurn = turns.find((x) => (LIVE as readonly string[]).includes(x.status));

  async function stop() {
    if (!liveTurn || liveTurn.id.startsWith("pending-")) return;
    try {
      await api(`/api/claude/runs/${liveTurn.id}/cancel`, { method: "POST" });
      if (activeId) await loadThread(activeId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function patchThread(patch: Record<string, unknown>) {
    if (!activeId) {
      // No thread yet — remember the choice and apply it at creation, instead of
      // dropping it on the floor.
      setPending((prev) => ({ ...prev, ...patch }));
      return;
    }
    try {
      const { thread: updated } = await api<{ thread: Thread }>(`/api/claude/threads/${activeId}`, {
        method: "PATCH",
        body: patch,
      });
      setThread(updated);
      setThreads((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(id: string) {
    if (!window.confirm(t("confirmDelete"))) return;
    try {
      await api(`/api/claude/threads/${id}`, { method: "DELETE" });
      setThreads((prev) => prev.filter((x) => x.id !== id));
      if (activeId === id) setActiveId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const title = thread?.title?.trim() || t("untitled");

  return (
    <div className="flex h-full min-h-0">
      {/* Thread list — a rail, closed by default. */}
      {listOpen && (
        <aside className="flex w-60 shrink-0 flex-col border-e">
          <div className="flex items-center gap-1 border-b p-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 flex-1 justify-start gap-1.5 text-xs"
              onClick={() => {
                setActiveId(null);
                setTurns([]);
              }}
            >
              <MessageSquarePlus className="size-4" />
              {t("newChat")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-2 text-xs text-muted-foreground">…</p>
            ) : threads.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">{t("noThreads")}</p>
            ) : (
              threads.map((x) => (
                <div
                  key={x.id}
                  className={cn(
                    "group flex items-center gap-1 border-b border-dashed px-2 py-1.5",
                    activeId === x.id && "bg-muted",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(x.id)}
                    className="min-w-0 flex-1 truncate text-start text-xs"
                    dir="auto"
                  >
                    {x.title?.trim() || t("untitled")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(x.id)}
                    aria-label={t("delete")}
                    title={t("delete")}
                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Header: the title, and two quiet buttons. Everything configurable is
            behind the second one. */}
        <div className="flex items-center gap-1 border-b p-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => setListOpen((v) => !v)}
            aria-label={listOpen ? t("hideList") : t("showList")}
            title={listOpen ? t("hideList") : t("showList")}
          >
            {listOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </Button>

          {renaming !== null ? (
            <Input
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renaming.trim()) {
                  void patchThread({ title: renaming.trim() });
                  setRenaming(null);
                } else if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={() => setRenaming(null)}
              className="h-8 flex-1 text-sm"
              dir="auto"
            />
          ) : (
            <button
              type="button"
              onClick={() => thread && setRenaming(thread.title || "")}
              disabled={!thread}
              className="group flex min-w-0 flex-1 items-center gap-1.5 text-start"
              title={thread ? t("rename") : undefined}
            >
              <span className="truncate text-sm font-medium" dir="auto">
                {title}
              </span>
              {thread && (
                <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => {
              setActiveId(null);
              setTurns([]);
            }}
            aria-label={t("newChat")}
            title={t("newChat")}
          >
            <MessageSquarePlus className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={settingsOpen ? "secondary" : "ghost"}
            className="h-8 w-8 p-0"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label={t("settings")}
            title={t("settings")}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>

        {/* The one collapsed panel that holds everything else. */}
        {settingsOpen && (
          <div className="max-h-72 space-y-3 overflow-y-auto border-b bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={(thread?.model ?? (pending.model as string | undefined)) ?? DEFAULT_MODEL}
                onValueChange={(v) => void patchThread({ model: v })}
              >
                <SelectTrigger className="h-8 w-64 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-2">
                        <span>{m.name}</span>
                        <span dir="ltr" className="font-mono text-[10px] text-muted-foreground">
                          {m.id}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={(thread?.effort ?? (pending.effort as string | undefined)) ?? EFFORT_DEFAULT}
                onValueChange={(v) => void patchThread({ effort: v === EFFORT_DEFAULT ? "" : v })}
              >
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EFFORT_DEFAULT}>{t("effortDefault")}</SelectItem>
                  {EFFORTS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {t(`effort.${e}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <RepoPicker
              locale={locale}
              repo={thread?.repo ?? ((pending.repo as string | null) ?? null)}
              branch={thread?.git_branch ?? ((pending.git_branch as string | null) ?? null)}
              onChange={(next) => void patchThread({ repo: next.repo, git_branch: next.branch })}
            />

            <PlaybookList
              locale={locale}
              selectedId={thread?.playbook_id ?? ((pending.playbook_id as string | null) ?? null)}
              onSelect={(id) => void patchThread({ playbook_id: id })}
            />

            <StandingInstructions locale={locale} />

            {/* Stated where it is settable, not buried: the method and the standing
                instructions only reach the engine on the FIRST message, because the
                resumed session already holds them afterwards. */}
            <p className="text-[11px] leading-snug text-muted-foreground">{t("firstTurnNote")}</p>

            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => setUpdateOpen(true)}
            >
              <Sparkles className="size-3.5" />
              {t("taskRouter")}
            </Button>
          </div>
        )}

        {/* Conversation */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {turns.length === 0 ? (
            <p className="pt-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {turns.map((turn) => (
                <TurnView key={turn.id} turn={turn} />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <UpdateInput
          open={updateOpen}
          onClose={() => setUpdateOpen(false)}
          onApplied={() => setUpdateOpen(false)}
        />

        <ChatComposer
          threadId={activeId}
          ensureThread={ensureThread}
          busy={sending || !!liveTurn}
          onSend={send}
          onStop={() => void stop()}
        />
      </div>
    </div>
  );
}

/** One exchange: what you said, then what came back. */
function TurnView({ turn }: { turn: Turn }) {
  const t = useTranslations("claudeChat");
  const [toolsOpen, setToolsOpen] = useState(false);

  const { answer, tools } = useMemo(() => {
    const texts: string[] = [];
    const toolNames: string[] = [];
    for (const ev of turn.events) {
      if (ev.kind === "assistant" && ev.text) texts.push(ev.text);
      else if (ev.kind === "tool_use" && ev.tool_name) toolNames.push(ev.tool_name);
    }
    // result_summary is the engine's final answer. Preferred when the streamed
    // assistant text is empty (a turn that only used tools), so the bubble is
    // never blank on a turn that did finish.
    const joined = texts.join("\n\n").trim();
    return { answer: joined || (turn.result_summary ?? "").trim(), tools: toolNames };
  }, [turn.events, turn.result_summary]);

  const live = turn.status === "queued" || turn.status === "running";

  return (
    <div className="flex flex-col gap-2">
      {(turn.user_prompt || turn.attachments.length > 0) && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
            {turn.user_prompt && (
              <p className="whitespace-pre-wrap break-words" dir="auto">
                {turn.user_prompt}
              </p>
            )}
            {turn.attachments.length > 0 && (
              <p className="mt-1 text-[11px] opacity-80" dir="auto">
                {turn.attachments.map((a) => a.filename).join(" · ")}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-start">
        <div className="min-w-0 max-w-[92%] space-y-1.5">
          {tools.length > 0 && (
            // Collapsed by default: the tool trail is how the answer was reached,
            // not the answer.
            <div>
              <button
                type="button"
                onClick={() => setToolsOpen((v) => !v)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {toolsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {t("toolCount", { count: tools.length })}
              </button>
              {toolsOpen && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {tools.map((name, i) => (
                    <span
                      key={`${name}-${i}`}
                      dir="ltr"
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {answer && (
            <p className="whitespace-pre-wrap break-words text-sm" dir="auto">
              {answer}
            </p>
          )}

          {live && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("thinking")}
            </p>
          )}

          {turn.status === "failed" && turn.error && (
            <p className="whitespace-pre-wrap text-xs text-destructive" dir="auto">
              {turn.error}
            </p>
          )}
          {turn.status === "canceled" && (
            <p className="text-xs text-muted-foreground">{t("stopped")}</p>
          )}

          {/* Said out loud rather than hidden: a turn past the first that resumed
              nothing began a fresh session, so it does not know what came before —
              and the screen would otherwise show one seamless conversation. */}
          {turn.turn_index > 1 && turn.status === "done" && !turn.resumed_session && (
            <p className="text-[11px] text-status-warn">{t("contextLost")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
