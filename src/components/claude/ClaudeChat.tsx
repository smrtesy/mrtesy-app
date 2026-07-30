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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/common/Markdown";
import { CopyButton } from "@/components/common/CopyButton";
import { ChatComposer } from "./ChatComposer";
import { PlaybookList } from "./PlaybookList";
import { RepoPicker } from "./RepoPicker";
import { StandingInstructions } from "./StandingInstructions";
import { SplitReview, type ProposedTopic } from "./SplitReview";
import { DecomposeReview, type ProposedPart } from "./DecomposeReview";
import { ProjectPanel } from "./ProjectPanel";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { UpdateInput } from "@/components/smrttask/tasks/UpdateInput";
import { Scissors, FolderTree, ExternalLink, ListTree } from "lucide-react";

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
  // Older models kept available on request. The id is sent to the engine verbatim,
  // so only ids known to resolve are listed — a guessed id would fail the run.
  { id: "claude-opus-4-8", name: "Opus 4.8" },
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
  /** Set when this turn was moved to a split child — folded away on the parent. */
  moved_to_thread_id: string | null;
  created_at: string;
  events: TurnEvent[];
  attachments: { id: string; filename: string }[];
}

interface SplitProposal {
  id: string;
  proposal: { topics: ProposedTopic[]; confidence: number | null };
}

interface ChildThread {
  id: string;
  title: string;
}

interface DecomposeProposal {
  id: string;
  parts: ProposedPart[];
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
  /** The open split proposal for the current thread, its children, and whether the
   *  review dialog / a manual analysis is in flight. */
  const [splitProposal, setSplitProposal] = useState<SplitProposal | null>(null);
  const [children, setChildren] = useState<ChildThread[]>([]);
  const [parent, setParent] = useState<ChildThread | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  /** The project panel (decompose / parts / board), and a decompose proposal awaiting
   *  review. Board attach is armed here and read by `send` for exactly one turn. */
  const [projectOpen, setProjectOpen] = useState(false);
  const [decomposeProposal, setDecomposeProposal] = useState<DecomposeProposal | null>(null);
  const [decomposeOpen, setDecomposeOpen] = useState(false);
  const [attachBoard, setAttachBoard] = useState(false);
  /** Topics for the grouped rail. Off by default (flat list); the folder icon
   *  toggles it, so grouping is opt-in chrome, not permanent. */
  const [topics, setTopics] = useState<{ id: string; title: string; thread_ids: string[] }[]>([]);
  const [grouped, setGrouped] = useState(false);
  const [regrouping, setRegrouping] = useState(false);

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
      const r = await api<{
        thread: Thread;
        turns: Turn[];
        split_proposal: SplitProposal | null;
        children: ChildThread[];
        parent: ChildThread | null;
      }>(`/api/claude/threads/${id}`);
      // Ignored when the user has already switched away: a slow response for the
      // previous thread must not paint over the one now on screen.
      if (activeIdRef.current !== id) return;
      setThread(r.thread);
      setTurns(r.turns ?? []);
      setSplitProposal(r.split_proposal ?? null);
      setChildren(r.children ?? []);
      setParent(r.parent ?? null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    }
  }, []);

  const loadTopics = useCallback(async () => {
    try {
      const { topics: list } = await api<{
        topics: { id: string; title: string; threads: { thread_id: string }[] }[];
      }>("/api/claude/topics");
      setTopics((list ?? []).map((tp) => ({ id: tp.id, title: tp.title, thread_ids: tp.threads.map((x) => x.thread_id) })));
    } catch {
      // Grouping is a convenience; its failure must not blank the rail.
    }
  }, []);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // Continue where you left off: open the most recent conversation automatically on
  // arrival, so the screen is a running chat rather than a blank one every time.
  // Fires ONCE (autoOpenedRef) — after that, "New chat" (activeId=null) and the poll
  // that keeps refreshing `threads` must not yank the user back into a thread.
  // A ?thread deep-link and an already-open thread both win over the auto-open.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || loading) return;
    autoOpenedRef.current = true;
    if (deepLinkedRef.current || activeIdRef.current) return;
    if (threads.length > 0) {
      setActiveId(threads[0].id);
      activeIdRef.current = threads[0].id;
    }
  }, [loading, threads]);

  useEffect(() => {
    if (grouped) void loadTopics();
  }, [grouped, loadTopics]);

  async function regroup() {
    if (regrouping) return;
    setRegrouping(true);
    try {
      await api("/api/claude/topics/regroup", { method: "POST" });
      await loadTopics();
      toast.success(t("group.done"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRegrouping(false);
    }
  }

  useEffect(() => {
    // Clear the previous thread's split state up front, BEFORE the new thread's
    // fetch returns. Otherwise A→B leaves A's proposal on screen under B — and an
    // open SplitReview would POST A's analysis_id/selections against B (it uses the
    // now-active threadId). Reset first; the reload repopulates for B.
    setSplitProposal(null);
    setSplitOpen(false);
    setChildren([]);
    setParent(null);
    // A board armed on one chat must not leak onto another; the panel and any open
    // decompose review belong to the chat that opened them.
    setAttachBoard(false);
    setProjectOpen(false);
    setDecomposeOpen(false);
    setDecomposeProposal(null);
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
        moved_to_thread_id: null,
        created_at: new Date().toISOString(),
        events: [],
        attachments: [],
      };
      setTurns((prev) => [...prev, optimistic]);
      // Read the board into THIS turn only if the user armed it in the project panel.
      const includeBoard = attachBoard;
      try {
        await api(`/api/claude/threads/${id}/messages`, {
          method: "POST",
          body: { message, attachment_ids: attachmentIds, include_board: includeBoard },
        });
      } catch (e) {
        setTurns((prev) => prev.filter((x) => x.id !== optimistic.id));
        toast.error(e instanceof Error ? e.message : String(e));
        setSending(false);
        // Rethrown so the composer puts the text and the attachment chips back.
        throw e;
      }
      // On-demand means once: disarm after a successful send so the next message is
      // clean unless the user arms it again.
      if (includeBoard) setAttachBoard(false);
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
    [ensureThread, turns.length, loadThread, attachBoard],
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

  /** The "פצל" button — run the analysis now and open the review if it found topics. */
  async function analyzeSplit() {
    if (!activeId || analyzing) return;
    setAnalyzing(true);
    try {
      const r = await api<{ analysis: SplitProposal | null; split: boolean }>(
        `/api/claude/threads/${activeId}/analyze-split`,
        { method: "POST" },
      );
      if (r.analysis) {
        setSplitProposal(r.analysis);
        setSplitOpen(true);
      } else {
        toast.message(t("split.none"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function dismissSplit() {
    if (!splitProposal) return;
    const id = splitProposal.id;
    setSplitProposal(null);
    try {
      await api(`/api/claude/analyses/${id}/dismiss`, { method: "POST" });
    } catch {
      // Best-effort: the banner is already gone; a failed dismiss just means it may
      // reappear on reload, which is harmless.
    }
  }

  function onSplitDone(created: ChildThread[]) {
    setSplitOpen(false);
    setSplitProposal(null);
    // Reload so the moved turns fold and the new children appear, and refresh the
    // rail so the children are listed.
    if (activeId) void loadThread(activeId);
    void loadThreads();
    if (created.length > 0) toast.success(t("split.created", { count: created.length }));
  }

  /** The project panel proposed a decomposition — swap the panel for the review. */
  function onDecomposeProposed(analysis: DecomposeProposal) {
    setProjectOpen(false);
    setDecomposeProposal(analysis);
    setDecomposeOpen(true);
  }

  function onDecomposeDone(created: ChildThread[]) {
    setDecomposeOpen(false);
    setDecomposeProposal(null);
    if (activeId) void loadThread(activeId);
    void loadThreads();
    if (created.length > 0) toast.success(t("decompose.created", { count: created.length }));
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
            {/* Group-by-topic toggle. Off by default so the rail is a plain list;
                the folder icon opts in, matching the compact-UI convention. */}
            <Button
              size="sm"
              variant={grouped ? "secondary" : "ghost"}
              className="h-8 w-8 p-0"
              onClick={() => setGrouped((v) => !v)}
              aria-label={t("group.toggle")}
              title={t("group.toggle")}
            >
              <FolderTree className="size-4" />
            </Button>
            {grouped && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={() => void regroup()}
                disabled={regrouping}
                aria-label={t("group.now")}
                title={t("group.now")}
              >
                {regrouping ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-2 text-xs text-muted-foreground">…</p>
            ) : threads.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">{t("noThreads")}</p>
            ) : grouped ? (
              renderGroupedRail(threads, topics, activeId, t, setActiveId, remove)
            ) : (
              threads.map((x) => (
                <ThreadRow
                  key={x.id}
                  thread={x}
                  active={activeId === x.id}
                  onOpen={() => setActiveId(x.id)}
                  onRemove={() => void remove(x.id)}
                  t={t}
                />
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
          {/* Split — only meaningful once there's a conversation to split. Quiet
              icon; a spinner while the analysis run is in flight. */}
          {activeId && turns.length >= 4 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={() => void analyzeSplit()}
              disabled={analyzing}
              aria-label={t("split.button")}
              title={t("split.button")}
            >
              {analyzing ? <Loader2 className="size-4 animate-spin" /> : <Scissors className="size-4" />}
            </Button>
          )}
          {/* Project — decompose into parts, jump between parts, the shared board.
              Shown once a thread exists; a dot marks a chat that already has parts or
              a parent (i.e. is part of a project). */}
          {activeId && (
            <Button
              size="sm"
              variant={projectOpen ? "secondary" : "ghost"}
              className="relative h-8 w-8 p-0"
              onClick={() => setProjectOpen((v) => !v)}
              aria-label={t("project.button")}
              title={t("project.button")}
            >
              <ListTree className="size-4" />
              {(children.length > 0 || parent) && (
                <span className="absolute end-1 top-1 size-1.5 rounded-full bg-primary" />
              )}
            </Button>
          )}
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

        {/* Split proposal banner — the automatic gate found topics. One quiet row:
            review, or dismiss. Nothing has moved yet. */}
        {splitProposal && !splitOpen && (
          <div className="flex items-center gap-2 border-b bg-primary/5 px-3 py-2 text-xs">
            <Scissors className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1" dir="auto">
              {t("split.bannerFound", { count: splitProposal.proposal.topics.length })}
            </span>
            <Button size="sm" variant="default" className="h-7" onClick={() => setSplitOpen(true)}>
              {t("split.review")}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => void dismissSplit()}>
              {t("split.dismiss")}
            </Button>
          </div>
        )}

        {/* Pending destructive-migration approvals — the human side of the autonomy
            gate. Renders nothing when the queue is empty, so it adds no permanent
            chrome; it is org-wide (not per-thread), which is why it sits here rather
            than inside a thread's conversation. */}
        <ApprovalsPanel />

        {/* The one collapsed panel that holds everything else. Model and effort used
            to live here; they moved down to the composer toolbar (like Claude Code),
            so the per-turn choices sit where you type and this panel keeps the
            heavier, set-once configuration. */}
        {settingsOpen && (
          <div className="max-h-72 space-y-3 overflow-y-auto border-b bg-muted/20 p-3">
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
              {renderTurns(turns, children, t, (id) => setActiveId(id))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <UpdateInput
          open={updateOpen}
          onClose={() => setUpdateOpen(false)}
          onApplied={() => setUpdateOpen(false)}
        />

        {/* On-demand board read, armed in the project panel — a quiet, dismissible
            line so the user knows the next message will carry the shared board. */}
        {attachBoard && (
          <div className="flex items-center gap-2 border-t bg-primary/5 px-3 py-1.5 text-[11px]">
            <ListTree className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1" dir="auto">
              {t("project.boardArmed")}
            </span>
            <button
              type="button"
              onClick={() => setAttachBoard(false)}
              className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
            >
              {t("project.boardDisarm")}
            </button>
          </div>
        )}

        <ChatComposer
          threadId={activeId}
          ensureThread={ensureThread}
          busy={sending || !!liveTurn}
          onSend={send}
          onStop={() => void stop()}
          models={MODELS}
          model={(thread?.model ?? (pending.model as string | undefined)) ?? DEFAULT_MODEL}
          onModelChange={(v) => void patchThread({ model: v })}
          efforts={EFFORTS}
          effort={(thread?.effort ?? (pending.effort as string | undefined)) || EFFORT_DEFAULT}
          onEffortChange={(v) => void patchThread({ effort: v === EFFORT_DEFAULT ? "" : v })}
          effortDefaultValue={EFFORT_DEFAULT}
        />
      </div>

      {activeId && splitProposal && (
        <SplitReview
          threadId={activeId}
          analysisId={splitProposal.id}
          topics={splitProposal.proposal.topics}
          open={splitOpen}
          onClose={() => setSplitOpen(false)}
          onDone={onSplitDone}
        />
      )}

      {activeId && projectOpen && (
        <ProjectPanel
          threadId={activeId}
          parent={parent}
          childThreads={children}
          open={projectOpen}
          onClose={() => setProjectOpen(false)}
          locale={locale}
          onOpenThread={(id) => {
            setProjectOpen(false);
            setActiveId(id);
          }}
          onDecomposeProposed={onDecomposeProposed}
          onChildCreated={() => {
            if (activeId) void loadThread(activeId);
            void loadThreads();
          }}
          attachBoard={attachBoard}
          setAttachBoard={setAttachBoard}
        />
      )}

      {activeId && decomposeProposal && (
        <DecomposeReview
          // Force a fresh mount per proposal: the draft rows are seeded from `parts`
          // in a useState initializer that runs only on mount, so without this a
          // second "פרק לחלקים" would keep showing the FIRST proposal's parts.
          key={decomposeProposal.id}
          threadId={activeId}
          analysisId={decomposeProposal.id}
          parts={decomposeProposal.parts}
          open={decomposeOpen}
          onClose={() => setDecomposeOpen(false)}
          onDone={onDecomposeDone}
        />
      )}
    </div>
  );
}

/** One row in the thread rail — open on click, delete on the hover trash. */
function ThreadRow({
  thread,
  active,
  onOpen,
  onRemove,
  t,
}: {
  thread: Thread;
  active: boolean;
  onOpen: () => void;
  onRemove: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 border-b border-dashed px-2 py-1.5",
        active && "bg-muted",
      )}
    >
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-start text-xs" dir="auto">
        {thread.title?.trim() || t("untitled")}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("delete")}
        title={t("delete")}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * The rail grouped by topic: each topic heading with its threads, then the ones no
 * topic claims under "ללא נושא". A thread in two topics appears under both — that is
 * the many-to-many by design, not a bug. Nothing is hidden: every thread that shows
 * in the flat list shows here too, somewhere.
 */
function renderGroupedRail(
  threads: Thread[],
  topics: { id: string; title: string; thread_ids: string[] }[],
  activeId: string | null,
  t: ReturnType<typeof useTranslations>,
  setActiveId: (id: string) => void,
  remove: (id: string) => void,
): ReactNode {
  const byId = new Map(threads.map((x) => [x.id, x]));
  const claimed = new Set<string>();
  const groups: ReactNode[] = [];

  for (const topic of topics) {
    const rows = topic.thread_ids.map((id) => byId.get(id)).filter((x): x is Thread => Boolean(x));
    if (rows.length === 0) continue;
    rows.forEach((r) => claimed.add(r.id));
    groups.push(
      <div key={topic.id}>
        <p className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70" dir="auto">
          {topic.title}
        </p>
        {rows.map((r) => (
          <ThreadRow
            key={`${topic.id}-${r.id}`}
            thread={r}
            active={activeId === r.id}
            onOpen={() => setActiveId(r.id)}
            onRemove={() => remove(r.id)}
            t={t}
          />
        ))}
      </div>,
    );
  }

  const orphans = threads.filter((x) => !claimed.has(x.id));
  if (orphans.length > 0) {
    groups.push(
      <div key="__none">
        <p className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {t("group.none")}
        </p>
        {orphans.map((r) => (
          <ThreadRow
            key={`none-${r.id}`}
            thread={r}
            active={activeId === r.id}
            onOpen={() => setActiveId(r.id)}
            onRemove={() => remove(r.id)}
            t={t}
          />
        ))}
      </div>,
    );
  }

  return <>{groups}</>;
}

/**
 * Render the conversation, folding any run of consecutive moved turns into a single
 * "N turns moved to <child>" row. The moved turns are still present in the data —
 * this only collapses them visually, and the row links to where they went.
 */
function renderTurns(
  turns: Turn[],
  children: ChildThread[],
  t: ReturnType<typeof useTranslations>,
  openThread: (id: string) => void,
): ReactNode[] {
  const childName = new Map(children.map((c) => [c.id, c.title]));
  const out: ReactNode[] = [];
  let i = 0;
  while (i < turns.length) {
    const turn = turns[i];
    if (!turn.moved_to_thread_id) {
      out.push(<TurnView key={turn.id} turn={turn} />);
      i += 1;
      continue;
    }
    // Gather the consecutive run moved to the SAME child, so three moved turns read
    // as one line, not three.
    const target = turn.moved_to_thread_id;
    let j = i;
    while (j < turns.length && turns[j].moved_to_thread_id === target) j += 1;
    const count = j - i;
    out.push(
      <button
        key={`moved-${turn.id}`}
        type="button"
        onClick={() => openThread(target)}
        className="mx-auto flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-[11px] text-muted-foreground transition hover:bg-muted"
      >
        <Scissors className="size-3" />
        {t("split.movedTo", { count, title: childName.get(target) ?? "" })}
        <ExternalLink className="size-3" />
      </button>,
    );
    i = j;
  }
  return out;
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
        <div className="group/msg flex items-start justify-end gap-1">
          {/* Copy sits OUTSIDE the bubble, on its leading edge, so it never
              overlaps the text and reads for the whole message. */}
          {turn.user_prompt && (
            <CopyButton
              text={turn.user_prompt}
              label={t("copyMessage")}
              copiedLabel={t("copied")}
              reveal="msg"
              className="mt-0.5"
            />
          )}
          {/* Subtle tint + normal foreground, matching the app's own chat bubbles
              (WhatsApp/SMS readers) — not the heavy primary fill with white text
              the earlier version used, which was hard to read for a long message. */}
          <div className="max-w-[85%] rounded-2xl bg-status-ok-bg px-3 py-2 text-sm text-foreground">
            {turn.user_prompt && (
              <p className="whitespace-pre-wrap break-words text-start" dir="auto">
                {turn.user_prompt}
              </p>
            )}
            {turn.attachments.length > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground" dir="auto">
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
            <div className="group/msg flex items-start gap-1">
              {/* Rich rendering, chat density: headings, lists, tables and code
                  the same way the .md docs render, tightened to a bubble. */}
              <Markdown density="chat" className="min-w-0 flex-1">
                {answer}
              </Markdown>
              <CopyButton
                text={answer}
                label={t("copyMessage")}
                copiedLabel={t("copied")}
                reveal="msg"
                className="mt-0.5 shrink-0"
              />
            </div>
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
