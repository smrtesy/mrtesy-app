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
import { useScreenPathname, useScreenRouter, useScreenSearchParams, useOptionalPaneNav } from "@/lib/panes/nav";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Crosshair,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, apiStream, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { isEmbeddedPane } from "@/lib/navigate";
import { AnswerContent } from "./interactive/AnswerContent";
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

/** Opus 4.8 by default, by request (2026-08-04). This is the built-in default
 *  used only when the org set none (claude_instructions.default_model); a stored
 *  org default still wins. A smarter per-task choice is a later job. */
const DEFAULT_MODEL = "claude-opus-4-8";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_DEFAULT = "__default__";

/** Statuses that keep the screen polling. 'waiting' is a message queued behind a
 *  live turn — it will start on its own, so the poll must keep watching it. */
const LIVE = ["queued", "running", "waiting"] as const;
/** The subset that means an engine process is (about to be) executing — what the
 *  Stop button targets. A 'waiting' turn has no process to stop; it is removed
 *  from the queue instead. */
const EXECUTING = ["queued", "running"] as const;
const POLL_MS = 900;
/** The rail (threads list) refresh cadence while a turn is live. Much slower than
 *  the turn poll on purpose: the rail only shows a status dot, and refreshing it
 *  at 900ms re-ran the list's status queries every second for no visible gain. */
const THREADS_POLL_MS = 5000;

/** The runner parks a turn hit by the subscription usage limit back in 'queued'
 *  with this prefix on `error` (server runner.ts USAGE_LIMIT_SENTINEL) — the
 *  live status line reads it to say "waiting for the window", not "starting". */
const USAGE_WAIT_PREFIX = "usage-limit-wait:";

/** Dedupe-merge new events into a turn's list by seq (the poll and the live
 *  stream both feed the same list, and either can arrive first). */
function mergeEvents(oldEvents: TurnEvent[], newEvents: TurnEvent[]): TurnEvent[] {
  if (newEvents.length === 0) return oldEvents;
  const seen = new Set(oldEvents.map((e) => e.seq));
  const add = newEvents.filter((e) => !seen.has(e.seq));
  if (add.length === 0) return oldEvents;
  return [...oldEvents, ...add].sort((a, b) => a.seq - b.seq);
}

/** The live poll's per-run patch — the mutable fields of a Turn, minus events. */
interface LiveRunPatch {
  id: string;
  turn_index: number;
  status: Turn["status"];
  error: string | null;
  result_summary: string | null;
  resumed_session: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
  started_at?: string | null;
  updated_at?: string | null;
  ended_at?: string | null;
  resume_attempts?: number | null;
}

/** 12345 → "12.3K" — the compact way the usage figures read in the chrome. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

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
  /** Which Claude subscription account this thread runs on. Null = the primary
   *  account (the default); any other id (e.g. "automation") is one of the extra
   *  accounts the server's registry exposes. */
  claude_account: string | null;
  last_message_at: string;
  /** When the user marked this thread handled from the rail (green check). Null =
   *  not handled. A handled thread dims and sorts to the bottom of the rail. */
  handled_at?: string | null;
  /** The smrtTask serial (e.g. "T1699") of the task this thread was opened for,
   *  when it came from the corrections flow. Null for ordinary chats. */
  task_serial?: string | null;
  /** True when the thread has a run executing/queued right now — the rail's live
   *  (pulsing amber/brown) status dot. Set by GET /claude/threads. */
  live?: boolean;
  /** The newest run's status (done/failed/…) — the rail's resting dot colour when
   *  not live. Null when the thread has never run. */
  last_status?: string | null;
  /** Deterministic fallback title (first user message, clipped), sent by the list
   *  endpoint ONLY when the AI `title` is absent — so an untitled thread still reads
   *  as something in the rail. Null when a title exists or there's no clean prompt. */
  preview?: string | null;
}

/** One selectable Claude subscription account, as GET /api/claude/accounts reports it. */
interface Account {
  id: string;
  /** Operator-set label, or null to fall back to the per-id default label. */
  label: string | null;
  configured: boolean;
}

const DEFAULT_ACCOUNT = "primary";
/** localStorage key for the last Claude account the user used — the new-chat default. */
const LAST_ACCOUNT_KEY = "claude-last-account";

interface TurnEvent {
  seq: number;
  kind: string;
  text: string | null;
  tool_name: string | null;
  /** When the event was stored — the live status line reads the newest one to name
   *  the current activity. */
  created_at?: string;
}

interface Turn {
  id: string;
  turn_index: number;
  status: "queued" | "running" | "waiting" | "done" | "failed" | "canceled";
  user_prompt: string | null;
  result_summary: string | null;
  error: string | null;
  /** The session this turn resumed into. Null on a turn past the first means it
   *  started a NEW session — the conversation lost its earlier context. */
  resumed_session: string | null;
  /** Set when this turn was moved to a split child — folded away on the parent. */
  moved_to_thread_id: string | null;
  /** The model this turn ran on — shown as a quiet per-turn label so you can see
   *  which model produced which answer (the console's "everything visible" rule).
   *  Null = the engine's default was used (no explicit model on the run). */
  model: string | null;
  /** Consumption the engine reported for this turn — what the usage line shows. */
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
  /** When the engine actually started this turn (null until it leaves 'queued') —
   *  the live status line's elapsed clock counts from here. */
  started_at?: string | null;
  /** Bumped by the runner's ~20s heartbeat while the turn runs, so its age is how
   *  the live status line tells an active turn from an orphaned one. */
  updated_at?: string | null;
  /** How many times the recoverer auto-continued this turn after a restart. */
  resume_attempts?: number | null;
  /** CLIENT-ONLY: the in-progress assistant text streamed as token deltas
   *  (kind:"delta" on the live stream) — the growing tail of the bubble. Reset
   *  whenever a completed assistant block (which contains it) arrives. Never
   *  sent by the server. */
  live_text?: string;
  events: TurnEvent[];
  attachments: {
    id: string;
    filename: string;
    /** 'user' = sent with the message (chip); 'run' = produced by the run itself
     *  (browser screenshot — rendered inline when signed_url is present). */
    source?: "user" | "run";
    signed_url?: string | null;
  }[];
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
  // Inside a tabs-workspace pane the floating grip (TabsWorkspace PaneControls)
  // sits in the top-inline-end corner; reserve room so the end-most header
  // button (settings) clears it. No reserve on the standalone /claude route.
  const inPane = useOptionalPaneNav() != null;
  // Whether THIS ClaudeChat runs inside the floating drawer's iframe (?embed=1 /
  // framed). Drives the postMessage bridge with the drawer chrome: the drawer,
  // being a separate top-window document, otherwise can't reach the open chat.
  // Starts false so SSR and first client render agree; flips after mount.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    setEmbedded(isEmbeddedPane());
  }, []);
  // The Claude account the user last USED — a NEW chat opens on it instead of the
  // primary default. Updated both by an explicit dropdown pick AND by opening a
  // thread that runs on a non-primary account (see loadThread), so the default
  // follows the account you were last working in, not only the last manual pick.
  // Read once on mount; a stable module-level helper writes it back.
  const [lastAccount, setLastAccount] = useState<string | null>(null);
  const rememberAccount = useCallback((id: string | null) => {
    const acct = (id ?? "").trim();
    if (!acct) return;
    setLastAccount(acct);
    try {
      window.localStorage.setItem(LAST_ACCOUNT_KEY, acct);
    } catch {
      /* localStorage unavailable — session-only memory still applies */
    }
  }, []);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LAST_ACCOUNT_KEY);
      if (v) setLastAccount(v);
    } catch {
      /* localStorage unavailable — the primary default still applies */
    }
  }, []);
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
  /** The Claude accounts the console can run on — feeds the header switcher. Loaded
   *  once; empty until then, which hides the switcher rather than showing a guess. */
  const [accounts, setAccounts] = useState<Account[]>([]);
  /** Org-wide defaults a NEW chat opens on (from claude_instructions). Null until
   *  fetched / until the operator picks one — a null falls back to the app's
   *  built-in default (DEFAULT_MODEL / engine-chosen effort). */
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [defaultEffort, setDefaultEffort] = useState<string | null>(null);

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

  // Continue-where-you-left-off guard, declared here because the seed effect below
  // must be able to claim it BEFORE the auto-open effect fires.
  const autoOpenedRef = useRef(false);

  // Reset to a blank composer — the shared body of "new chat" (the ?new param, the
  // two new-chat buttons, and the drawer's per-open new-chat message). Claims the
  // auto-open guard so the open-latest effect and the rail poll don't yank a thread
  // back in. Does NOT touch deepLinkedRef, so a later ?thread deep-link still wins.
  const resetToNewChat = useCallback(() => {
    autoOpenedRef.current = true;
    setActiveId(null);
    activeIdRef.current = null;
    setTurns([]);
  }, []);

  // The Claude button opens a NEW chat: it navigates to /claude?new=<timestamp>,
  // and this effect resets to the blank composer. Keyed on the VALUE so every
  // click is fresh (openTab dedupes the tab by path and only updates its href —
  // a static param would fire once and never again), and deliberately NOT
  // touching deepLinkedRef, so a later ?thread=<id> deep-link (corrections'
  // "continue with Claude") still opens its conversation.
  const newParamRef = useRef<string | null>(null);
  const screenRouter = useScreenRouter();
  const screenPathname = useScreenPathname();
  useEffect(() => {
    const fresh = screenSearch.get("new");
    if (!fresh || fresh === newParamRef.current) return;
    newParamRef.current = fresh;
    resetToNewChat();
    // Consume the param OUT of the URL: it is a one-shot command, and left in
    // place it persists (workspace localStorage / mobile history), replaying
    // "blank chat" on every reload and burying continue-where-you-left-off.
    const params = new URLSearchParams(screenSearch.toString());
    params.delete("new");
    const q = params.toString();
    screenRouter.replace(q ? `${screenPathname}?${q}` : screenPathname);
  }, [screenSearch, screenRouter, screenPathname, resetToNewChat]);

  // The mobile Claude button opens the THREAD LIST (rail), not a new chat:
  // /claude?list=<timestamp> → open the rail. Keyed on the VALUE (like ?new)
  // so every tap re-opens it even if the user already closed it. The
  // continue-where-you-left-off effect still runs underneath; on mobile the
  // rail is a full-screen overlay so it covers that chat until the user picks
  // one. Consumed out of the URL so it doesn't re-fire on reload.
  const listParamRef = useRef<string | null>(null);
  useEffect(() => {
    const wantList = screenSearch.get("list");
    if (!wantList || wantList === listParamRef.current) return;
    listParamRef.current = wantList;
    setListOpen(true);
    const params = new URLSearchParams(screenSearch.toString());
    params.delete("list");
    const q = params.toString();
    screenRouter.replace(q ? `${screenPathname}?${q}` : screenPathname);
  }, [screenSearch, screenRouter, screenPathname]);

  /** The inspect-mode seed: the user marked an element somewhere in the app and
   *  landed here. Applied from sessionStorage on mount (the chat wasn't open when
   *  the mark happened) AND from a live window event (it was — a mount-time read
   *  would never re-run). Result: fresh chat, the app repo pre-selected, and the
   *  captured context waiting in the composer for the user to complete and send. */
  const [seedText, setSeedText] = useState<string | null>(null);
  const applySeed = useCallback((seed: { text?: string; repo?: string; branch?: string }) => {
    if (!seed?.text) return;
    // The seed wins over both the ?thread deep-link and the open-latest default:
    // the user came here to file THIS, not to resume something else.
    deepLinkedRef.current = true;
    autoOpenedRef.current = true;
    setActiveId(null);
    activeIdRef.current = null;
    if (seed.repo) {
      setPending((prev) => ({ ...prev, repo: seed.repo, git_branch: seed.branch ?? null }));
    }
    setSeedText(seed.text);
  }, []);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("smrtesy-claude-inspect-seed");
      if (raw) {
        sessionStorage.removeItem("smrtesy-claude-inspect-seed");
        applySeed(JSON.parse(raw) as { text?: string });
      }
    } catch {
      // A malformed seed is a no-op — the screen opens normally.
    }
    const onSeed = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text?: string } | undefined;
      if (!detail) return;
      // This pane consumed it live; the stored copy must not re-apply on a later mount.
      try {
        sessionStorage.removeItem("smrtesy-claude-inspect-seed");
      } catch {
        // Nothing stored / storage blocked — the live application already happened.
      }
      applySeed(detail);
    };
    window.addEventListener("smrtesy:claude-inspect-seed", onSeed);
    return () => window.removeEventListener("smrtesy:claude-inspect-seed", onSeed);
  }, [applySeed]);

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

  /** Monotonic ticket for full thread loads. Loads are triggered from several
   *  places (thread switch, send, terminal edge, the poll's unknown-run path)
   *  and their responses can complete OUT OF ORDER — a stale response applying
   *  last would replace the turns with an older snapshot, making a message the
   *  screen already showed vanish until the next refresh. Only the response
   *  holding the NEWEST ticket may apply. */
  const loadSeqRef = useRef(0);

  const loadThread = useCallback(async (id: string) => {
    const ticket = ++loadSeqRef.current;
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
      // Ignored when a NEWER load was issued meanwhile (see loadSeqRef).
      if (ticket !== loadSeqRef.current) return;
      setThread(r.thread);
      setTurns(r.turns ?? []);
      setSplitProposal(r.split_proposal ?? null);
      setChildren(r.children ?? []);
      setParent(r.parent ?? null);
      // The account you're now working in becomes the new-chat default. Only a
      // non-null (explicitly non-primary) account overrides — opening an old
      // default thread never resets an account you deliberately picked.
      rememberAccount(r.thread.claude_account);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    }
  }, [rememberAccount]);

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

  // The account list is org-wide config, not per-thread — load it once. A failure
  // leaves `accounts` empty, which hides the switcher; the run still uses the
  // thread's stored account server-side, so nothing breaks.
  useEffect(() => {
    void (async () => {
      try {
        const { accounts: list } = await api<{ accounts: Account[] }>("/api/claude/accounts");
        setAccounts(list ?? []);
      } catch {
        // Non-fatal: no switcher, default account still runs.
      }
    })();
  }, []);

  // Continue where you left off: open the most recent conversation automatically on
  // arrival, so the screen is a running chat rather than a blank one every time.
  // Fires ONCE (autoOpenedRef) — after that, "New chat" (activeId=null) and the poll
  // that keeps refreshing `threads` must not yank the user back into a thread.
  // A ?thread deep-link, an inspect seed, and an already-open thread all win over
  // the auto-open.
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
    // Clear the conversation area IMMEDIATELY on a switch — showing thread A's
    // turns under thread B's title while B loads is exactly the "messages
    // vanished / came back" confusion, and it also stops the live poll from
    // reading A's turns as if they were B's.
    setThread(null);
    setTurns([]);
    if (activeId) void loadThread(activeId);
  }, [activeId, loadThread]);

  // Poll only while a turn is actually moving. A finished conversation is static,
  // so there is nothing to fetch and no reason to keep asking.
  const hasLive = turns.some((x) => (LIVE as readonly string[]).includes(x.status));

  // The poll reads the freshest turns through a ref, so the interval itself does
  // not have to be torn down and re-armed on every merged event batch.
  const turnsRef = useRef<Turn[]>(turns);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  /**
   * One light poll tick — GET /threads/:id/live, which returns only the
   * non-terminal runs and the executing run's NEW events (seq-incremental).
   * This replaced the full-thread refetch that ran every 900ms: that one
   * re-read every turn, every event and every attachment signature on each
   * tick, so a long conversation got slower and heavier exactly while it was
   * working. The full reload now happens once, on the turn's terminal edge.
   */
  const tickLive = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    const cur = turnsRef.current;
    const exec = cur.find(
      (x) => (EXECUTING as readonly string[]).includes(x.status) && !x.id.startsWith("pending-"),
    );
    const lastSeq =
      exec && exec.events.length > 0 ? exec.events[exec.events.length - 1].seq : 0;
    const ticketAtStart = loadSeqRef.current;
    try {
      const r = await api<{ runs: LiveRunPatch[]; events: TurnEvent[] }>(
        `/api/claude/threads/${id}/live?run=${exec?.id ?? ""}&after=${lastSeq}`,
      );
      if (activeIdRef.current !== id) return;
      // A full load was issued while this tick was in flight — its snapshot is
      // newer than what this tick read; merging on top could resurrect stale
      // statuses. Skip; the next tick works from the fresh snapshot.
      if (ticketAtStart !== loadSeqRef.current) return;
      const known = new Set(cur.map((t) => t.id));
      // A run this screen doesn't know (sent from another tab / the recoverer) or
      // the watched turn reaching a terminal state → one full reload for the
      // canonical view (attachments, split proposal, usage figures).
      const unknown = r.runs.some((x) => !known.has(x.id));
      const execPatch = exec ? r.runs.find((x) => x.id === exec.id) : undefined;
      const finished = execPatch && !(LIVE as readonly string[]).includes(execPatch.status);
      if (unknown || finished) {
        void loadThread(id);
        void loadThreads();
        return;
      }
      setTurns((prev) =>
        prev.map((t) => {
          const patch = r.runs.find((x) => x.id === t.id);
          if (!patch) return t;
          // A turn back in 'queued' with no started_at while it already has
          // events = the recoverer (or the usage-limit park) reclaimed it and
          // CLEARED its event rows — the re-execution restarts seq from 1.
          // Keeping the dead attempt's events would hide the new ones behind a
          // stale `after=` and interleave two attempts on screen; reset instead.
          const reExecuted =
            patch.status === "queued" && !patch.started_at && t.events.length > 0;
          const merging = !reExecuted && exec && t.id === exec.id;
          const events = reExecuted
            ? []
            : merging
              ? mergeEvents(t.events, r.events)
              : t.events;
          // A completed assistant block arriving via the poll contains the
          // streamed deltas — drop the live tail so the text isn't doubled.
          const blockDone = merging && r.events.some((e) => e.kind === "assistant");
          const live_text = reExecuted || blockDone ? "" : t.live_text;
          return { ...t, ...patch, events, live_text };
        }),
      );
    } catch {
      // A poll blip — the next tick retries; the turn runs on regardless.
    }
  }, [loadThread, loadThreads]);

  useEffect(() => {
    if (!hasLive || !activeId) return;
    const id = setInterval(() => {
      void tickLive();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [hasLive, activeId, tickLive]);

  // The rail refresh, on its own slow cadence — see THREADS_POLL_MS.
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => {
      void loadThreads();
    }, THREADS_POLL_MS);
    return () => clearInterval(id);
  }, [hasLive, loadThreads]);

  /**
   * Live stream — the accelerator on top of the poll. While a turn is 'running'
   * in this backend process, GET /runs/:id/stream tails the runner's in-memory
   * event bus as NDJSON, so text appears the moment the engine emits it instead
   * of after flush+poll (~1.4s worst case). Merged by seq into the same list the
   * poll feeds; 204 / any error just means "no stream — the poll has it".
   */
  // Opened as soon as a turn is EXECUTING (queued included, not just running):
  // isRunLive on the server is true from the moment executeRun claims the row,
  // so connecting during 'queued' catches the very first engine output instead
  // of waiting for a poll to report 'running'. A 204 (not claimed yet / other
  // instance) is retried briefly, then left to the poll.
  const streamRunId =
    turns.find(
      (x) =>
        (EXECUTING as readonly string[]).includes(x.status) &&
        !x.id.startsWith("pending-") &&
        // A turn parked on the usage window sits 'queued' for hours with no
        // process — 12 retry probes per mount would all 204 for nothing.
        !x.error?.startsWith(USAGE_WAIT_PREFIX),
    )?.id ?? null;
  useEffect(() => {
    if (!streamRunId) return;
    const ctrl = new AbortController();
    let gone = false;
    void (async () => {
      try {
        let res: Response | null = null;
        for (let attempt = 0; attempt < 12 && !gone; attempt++) {
          res = await apiStream(`/api/claude/runs/${streamRunId}/stream`, {
            signal: ctrl.signal,
          });
          if (res.status === 200 && res.body) break;
          res = null;
          await new Promise((r) => setTimeout(r, 700));
        }
        if (!res?.body || gone) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || gone) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          const evs: TurnEvent[] = [];
          let deltaText = "";
          for (const ln of lines) {
            const s = ln.trim();
            if (!s) continue; // the server's keep-alive newline
            try {
              const ev = JSON.parse(s) as TurnEvent;
              if (ev?.kind === "delta") {
                // A token-level fragment of the block being written — the
                // growing tail of the bubble, never a stored event.
                if (ev.text) deltaText += ev.text;
              } else if (typeof ev?.seq === "number" && ev.seq > 0) {
                evs.push(ev);
              }
            } catch {
              // A torn line mid-chunk — the remainder rides in `buf`.
            }
          }
          if (evs.length > 0 || deltaText) {
            // A completed assistant block supersedes the deltas that built it —
            // its stored text contains them, so the live tail resets to what
            // arrived AFTER it in this same ordered batch.
            const blockDone = evs.some((e) => e.kind === "assistant");
            setTurns((prev) =>
              prev.map((t) =>
                t.id === streamRunId
                  ? {
                      ...t,
                      events: evs.length > 0 ? mergeEvents(t.events, evs) : t.events,
                      live_text: blockDone ? deltaText : (t.live_text ?? "") + deltaText,
                    }
                  : t,
              ),
            );
          }
        }
      } catch {
        // Stream unavailable (abort, proxy, scaled-out instance) — poll covers it.
      }
    })();
    return () => {
      gone = true;
      ctrl.abort();
    };
  }, [streamRunId]);

  const scrollToBottom = useCallback(() => {
    // nearest, not the default: scrollIntoView on a pane-embedded screen otherwise
    // scrolls the ancestor pane too, yanking the whole workspace.
    bottomRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
  }, []);
  useEffect(() => {
    scrollToBottom();
  }, [turns.length, hasLive, scrollToBottom]);
  // Coming back to the Claude tab (un-minimized / re-focused) jumps to the latest
  // messages — the bottom is what the user wants on return, not wherever they'd
  // scrolled to. rAF so the paint after the tab shows has laid the content out.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) requestAnimationFrame(scrollToBottom);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [scrollToBottom]);

  // Bridge to the drawer chrome hosting this chat in an iframe (bugs 1/3/5/8): the
  // drawer is a separate top-window document, so it drives new-chat / seed / scroll
  // via postMessage, and receives the live thread title back for its slim header.
  useEffect(() => {
    if (!embedded) return;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const d = e.data as { type?: string } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "claude-drawer:new") {
        resetToNewChat();
      } else if (d.type === "claude-drawer:seed") {
        // The mark was captured in the top window; the seed sits in the shared
        // sessionStorage — read and apply it into THIS open drawer chat.
        try {
          const raw = sessionStorage.getItem("smrtesy-claude-inspect-seed");
          if (raw) {
            sessionStorage.removeItem("smrtesy-claude-inspect-seed");
            applySeed(JSON.parse(raw) as { text?: string });
          }
        } catch {
          /* malformed / blocked — no-op */
        }
      } else if (d.type === "claude-drawer:shown") {
        requestAnimationFrame(scrollToBottom);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [embedded, resetToNewChat, applySeed, scrollToBottom]);

  // Report the open thread's title up to the drawer's compact header. Empty string
  // for a fresh/untitled chat — the drawer shows its own placeholder then.
  const firstPrompt = turns[0]?.user_prompt ?? null;
  useEffect(() => {
    if (!embedded) return;
    try {
      window.parent.postMessage(
        {
          type: "claude-chat:title",
          title: thread?.title?.trim() || firstMessagePreview(firstPrompt) || "",
        },
        window.location.origin,
      );
    } catch {
      /* cross-origin parent — ignored */
    }
  }, [embedded, thread?.title, firstPrompt]);

  // The org's default model/effort for new chats. Read once on mount; a failure is
  // ambient (the app's built-in default stays in effect).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await api<{ default_model: string | null; default_effort: string | null }>(
          "/api/claude/instructions",
        );
        if (!alive) return;
        setDefaultModel(d.default_model ?? null);
        setDefaultEffort(d.default_effort ?? null);
      } catch {
        // Ambient — leave the built-in default in effect.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** Persist a new-chat default. Sends "" to clear a field back to the app default
   *  (the PUT is partial, so this never touches the standing-instructions body). */
  const saveDefault = useCallback(
    async (patch: { default_model?: string; default_effort?: string }) => {
      try {
        await api("/api/claude/instructions", { method: "PUT", body: patch });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  /** Create the thread on demand — on the first send, or the moment a file is
   *  attached. Threads are never created just by opening the screen: an empty
   *  conversation in the list is noise. */
  const ensureThread = useCallback(async (): Promise<string | null> => {
    if (activeId) return activeId;
    try {
      const { thread: created } = await api<{ thread: Thread }>("/api/claude/threads", {
        method: "POST",
        // New chats open on the org default (the backend applies the same default
        // as a backstop); a per-session override in `pending` still wins.
        body: {
          model: defaultModel ?? DEFAULT_MODEL,
          ...(defaultEffort ? { effort: defaultEffort } : {}),
          // The last-picked account is the new-chat default (bug 10); an explicit
          // per-session pick in `pending` still wins over it.
          ...(lastAccount ? { claude_account: lastAccount } : {}),
          ...pending,
        },
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
  }, [activeId, pending, defaultModel, defaultEffort, lastAccount]);

  const send = useCallback(
    async (message: string, attachmentIds: string[]) => {
      const id = await ensureThread();
      if (!id) return;
      setSending(true);
      // Shown immediately, so the message appears the moment Enter is pressed
      // instead of after the round trip. 'waiting' when a turn is already live —
      // the server will queue it exactly the same way.
      const behindLive = turns.some((x) => (EXECUTING as readonly string[]).includes(x.status));
      const optimistic: Turn = {
        id: `pending-${Date.now()}`,
        turn_index: turns.length + 1,
        status: behindLive ? "waiting" : "queued",
        user_prompt: message,
        result_summary: null,
        error: null,
        resumed_session: null,
        moved_to_thread_id: null,
        model: null,
        input_tokens: null,
        output_tokens: null,
        duration_ms: null,
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
    [ensureThread, turns, loadThread, attachBoard],
  );

  /** The turn an engine process is executing (what Stop signals). Distinct from
   *  the LIVE poll set: a 'waiting' turn is live for polling but has no process. */
  const runningTurn = turns.find((x) => (EXECUTING as readonly string[]).includes(x.status));

  async function stop() {
    if (!runningTurn || runningTurn.id.startsWith("pending-")) return;
    try {
      await api(`/api/claude/runs/${runningTurn.id}/cancel`, { method: "POST" });
      if (activeId) await loadThread(activeId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  /** Remove a queued ('waiting') message from the line before it runs. */
  async function cancelWaiting(runId: string) {
    if (runId.startsWith("pending-")) return;
    try {
      await api(`/api/claude/runs/${runId}/cancel`, { method: "POST" });
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

  /** Toggle the rail's "handled" mark. Optimistic — the row dims and drops to the
   *  bottom immediately; a failed PATCH reverts by reloading the server truth. */
  async function setHandled(id: string, handled: boolean) {
    const stamp = handled ? new Date().toISOString() : null;
    setThreads((prev) => prev.map((x) => (x.id === id ? { ...x, handled_at: stamp } : x)));
    try {
      await api(`/api/claude/threads/${id}`, { method: "PATCH", body: { handled } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      void loadThreads();
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

  const title =
    thread?.title?.trim() || firstMessagePreview(turns[0]?.user_prompt) || t("untitled");

  /** Open a thread (or a fresh chat when id is null). On mobile the rail is a
   *  full-screen overlay covering the chat, so picking closes it to reveal the
   *  conversation; on desktop the rail stays open beside the chat. matchMedia is
   *  read at click time (event handler, not render) — no hydration mismatch. */
  const pickThread = useCallback((id: string | null) => {
    setActiveId(id);
    if (id === null) setTurns([]);
    try {
      if (window.matchMedia("(max-width: 767.98px)").matches) setListOpen(false);
    } catch {
      /* no matchMedia (SSR) — desktop side-by-side needs no close */
    }
  }, []);

  // "כמות טוקנים בשימוש" — the conversation's own consumption, summed from what the
  // engine reported per turn. Shown as a quiet chip in the header; the tooltip
  // carries the exact split.
  const usage = useMemo(() => {
    let input = 0;
    let output = 0;
    for (const x of turns) {
      input += x.input_tokens ?? 0;
      output += x.output_tokens ?? 0;
    }
    return { input, output, total: input + output };
  }, [turns]);

  return (
    <div className="flex h-full min-h-0">
      {/* Thread list — a rail, closed by default. Full-screen on mobile (covers the
          chat), a fixed-width column beside the chat on desktop (md+). */}
      {listOpen && (
        <aside className="flex w-full shrink-0 flex-col border-e md:w-60">
          <div className="flex items-center gap-1 border-b p-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 flex-1 justify-start gap-1.5 text-xs"
              onClick={() => pickThread(null)}
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
            {/* Mobile-only close: the rail covers the chat here, and the header's
                toggle button is hidden with it, so the rail carries its own close. */}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 md:hidden"
              onClick={() => setListOpen(false)}
              aria-label={t("hideList")}
              title={t("hideList")}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-2 text-xs text-muted-foreground">…</p>
            ) : threads.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">{t("noThreads")}</p>
            ) : grouped ? (
              renderGroupedRail(threads, topics, activeId, t, pickThread, remove, (id, h) =>
                void setHandled(id, h),
              )
            ) : (
              sortHandledLast(threads).map((x) => (
                <ThreadRow
                  key={x.id}
                  thread={x}
                  active={activeId === x.id}
                  onOpen={() => pickThread(x.id)}
                  onRemove={() => void remove(x.id)}
                  onToggleHandled={() => void setHandled(x.id, !x.handled_at)}
                  t={t}
                />
              ))
            )}
          </div>
        </aside>
      )}

      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", listOpen && "hidden md:flex")}>
        {/* Header: the title, and two quiet buttons. Everything configurable is
            behind the second one. */}
        <div className={cn("sticky top-0 z-20 flex items-center gap-1 border-b bg-background p-2", inPane && "pe-10")}>
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

          {embedded ? (
            // In the drawer, the slim header ABOVE the iframe already shows the
            // thread title (bridged via `claude-chat:title`). Rendering the title
            // again here produced the redundant double placeholder the user saw —
            // "שיחה חדשה" over "ללא כותרת". Drop the internal title in embed; keep a
            // flex spacer so the rail toggle and the account/config controls stay put.
            <div className="min-w-0 flex-1" />
          ) : renaming !== null ? (
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
              <span className="line-clamp-2 break-words text-sm font-medium" dir="auto">
                {title}
              </span>
              {thread && (
                <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
          )}

          {/* Tokens used in this conversation — always visible, one quiet number. */}
          {usage.total > 0 && (
            <span
              dir="ltr"
              className="shrink-0 rounded px-1.5 text-[11px] tabular-nums text-muted-foreground"
              title={t("usage.tooltip", {
                input: usage.input.toLocaleString(),
                output: usage.output.toLocaleString(),
              })}
            >
              {fmtTokens(usage.total)}
            </span>
          )}

          {/* Which Claude account this conversation runs on, and how to switch it.
              Shown only once the account list loaded, so it never guesses. Writing
              persists to the thread; before a thread exists it is held in `pending`
              and applied on the first message (same path as model/effort). */}
          {accounts.length > 0 && (
            <AccountSwitcher
              accounts={accounts}
              value={
                thread?.claude_account ??
                (pending.claude_account as string | undefined) ??
                lastAccount ??
                DEFAULT_ACCOUNT
              }
              disabled={!!runningTurn}
              onChange={(id) => {
                // Remember it as the new-chat default (bug 10) — before the thread
                // write, so it sticks even if that fails.
                rememberAccount(id);
                if (activeId) void patchThread({ claude_account: id });
                else setPending((p) => ({ ...p, claude_account: id }));
              }}
            />
          )}

          {/* Mark a place in the app: arms the global inspect mode (ClaudeInspector,
              mounted in the app layout). Click a component in a neighboring pane /
              any screen, and the captured context lands here as a draft message. */}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => window.dispatchEvent(new CustomEvent("smrtesy:claude-inspect-arm"))}
            aria-label={t("inspect.arm")}
            title={t("inspect.arm")}
          >
            <Crosshair className="size-4" />
          </Button>

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

            {/* New-chat defaults: pick the model + effort every new conversation
                opens on, so you set it once here instead of per-thread in the
                composer (which still overrides for a single chat). */}
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("defaults.heading")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={defaultModel ?? DEFAULT_MODEL}
                  onValueChange={(v) => {
                    setDefaultModel(v);
                    void saveDefault({ default_model: v });
                  }}
                >
                  <SelectTrigger className="h-8 w-auto gap-1 text-xs" aria-label={t("defaults.model")}>
                    <span className="truncate">
                      {MODELS.find((m) => m.id === (defaultModel ?? DEFAULT_MODEL))?.name ??
                        (defaultModel ?? DEFAULT_MODEL)}
                    </span>
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
                  value={defaultEffort ?? EFFORT_DEFAULT}
                  onValueChange={(v) => {
                    const next = v === EFFORT_DEFAULT ? null : v;
                    setDefaultEffort(next);
                    // "" clears the stored default back to engine-chosen (partial PUT).
                    void saveDefault({ default_effort: next ?? "" });
                  }}
                >
                  <SelectTrigger className="h-8 w-auto gap-1 text-xs" aria-label={t("defaults.effort")}>
                    <span className="truncate">
                      {defaultEffort ? t(`effort.${defaultEffort}`) : t("effortDefault")}
                    </span>
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
            </div>

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
            // Keyed by the thread so switching conversations remounts cleanly,
            // while WITHIN a thread the turns stay keyed by turn_index (below) —
            // the optimistic bubble and its server row share that key, so send no
            // longer remounts the whole list (the flicker, bug 7).
            <div key={activeId ?? "new"} className="mx-auto flex max-w-3xl flex-col gap-3">
              {renderTurns(
                turns,
                children,
                t,
                (id) => setActiveId(id),
                (id) => void cancelWaiting(id),
                // Returns the send promise so an interactive block can revert its
                // "sent" latch if the turn fails to queue (send rethrows on error).
                (message) => send(message, []),
                // The live status line's "stop" — cancels the executing turn (and,
                // for an orphaned row, clears it so the screen stops polling).
                () => void stop(),
              )}
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
          busy={sending}
          running={!!runningTurn}
          seedText={seedText}
          onSend={send}
          onStop={() => void stop()}
          models={MODELS}
          // The org default is the fallback for a BRAND-NEW chat only. An existing
          // thread shows its own stored value (→ app default for display if null),
          // so the composer never shows a default the run won't actually use.
          model={
            thread
              ? (thread.model ?? DEFAULT_MODEL)
              : ((pending.model as string | undefined) ?? defaultModel ?? DEFAULT_MODEL)
          }
          onModelChange={(v) => void patchThread({ model: v })}
          efforts={EFFORTS}
          effort={
            thread
              ? ((thread.effort ?? "") || EFFORT_DEFAULT)
              : ((pending.effort as string | undefined) || defaultEffort || EFFORT_DEFAULT)
          }
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

/** Handled threads sink to the bottom of the rail; order is otherwise preserved
 *  (Array.sort is stable), so within each group the newest-activity order stays. */
function sortHandledLast(list: Thread[]): Thread[] {
  return [...list].sort((a, b) => (a.handled_at ? 1 : 0) - (b.handled_at ? 1 : 0));
}

/** The rail title: lead with the task serial and never show a "תיקון אוטומטי"
 *  prefix. The server titler already enforces this; this display pass also covers
 *  titles written before that fix (and user-set titles, which it leaves alone
 *  aside from the meta-prefix strip). */
/** First non-empty line of the open thread's first message, clipped — the client
 *  fallback title (header + drawer bridge) when the AI title hasn't landed. Mirrors
 *  the server's firstLinePreview so an untitled OPEN chat reads the same as the rail. */
function firstMessagePreview(s: string | null | undefined): string {
  const line = (s ?? "")
    .split("\n")
    .map((x) => x.trim())
    .find(Boolean);
  return (line ?? "").slice(0, 80);
}

function railThreadTitle(thread: Thread, untitled: string): string {
  let title = (thread.title ?? "").trim().replace(/^\s*תיקון\s+אוטומטי\s*[:\-–—.]*\s*/u, "").trim();
  const serial = (thread.task_serial ?? "").trim();
  if (serial) {
    if (!title) title = serial;
    else if (!title.startsWith(serial)) title = `${serial} · ${title}`;
  }
  // No AI title → the deterministic first-message preview, so the rail is never a
  // wall of "ללא כותרת" for untitled/backlog threads. The serial still leads.
  if (!title) {
    const preview = (thread.preview ?? "").trim();
    if (preview) return serial ? `${serial} · ${preview}` : preview;
  }
  return title || untitled;
}

/** The live/last-status dot at the head of a rail row. Pulsing amber (brown) while a
 *  turn runs; otherwise a resting colour for the newest run's outcome. */
function ThreadDot({ thread, t }: { thread: Thread; t: ReturnType<typeof useTranslations> }) {
  if (thread.live) {
    return (
      <span className="relative flex size-2 shrink-0" title={t("dot.live")} aria-label={t("dot.live")}>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-800 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-amber-800" />
      </span>
    );
  }
  const s = thread.last_status;
  const cls = s === "done" ? "bg-status-ok" : s === "failed" ? "bg-destructive" : "bg-muted-foreground/30";
  const label = s === "done" ? t("dot.done") : s === "failed" ? t("dot.failed") : t("dot.idle");
  return <span className={cn("size-2 shrink-0 rounded-full", cls)} title={label} aria-label={label} />;
}

/** One row in the thread rail — status dot, title (RTL, ≤2 lines), a faint "handled"
 *  check that turns green, and the hover trash. */
function ThreadRow({
  thread,
  active,
  onOpen,
  onRemove,
  onToggleHandled,
  t,
}: {
  thread: Thread;
  active: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onToggleHandled: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const handled = !!thread.handled_at;
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 border-b border-dashed px-2 py-1.5",
        active && "bg-muted",
        handled && "opacity-50",
      )}
    >
      <ThreadDot thread={thread} t={t} />
      {/* dir="rtl" (not "auto"): the title reads right-to-left even when it starts
          with a Latin serial like "T1699", because the rest is Hebrew. */}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 line-clamp-2 break-words text-start text-xs" dir="rtl">
        {railThreadTitle(thread, t("untitled"))}
      </button>
      {/* Handled mark: faint until hover, solid green once set (stays visible so a
          handled thread is legible at a glance). */}
      <button
        type="button"
        onClick={onToggleHandled}
        aria-label={handled ? t("handled.unmark") : t("handled.mark")}
        title={handled ? t("handled.unmark") : t("handled.mark")}
        className={cn(
          "shrink-0 rounded p-0.5 transition-all",
          handled
            ? "text-status-ok"
            : "text-muted-foreground/40 opacity-0 hover:text-status-ok group-hover:opacity-100",
        )}
      >
        <Check className="size-3.5" />
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
  toggleHandled: (id: string, handled: boolean) => void,
): ReactNode {
  const byId = new Map(threads.map((x) => [x.id, x]));
  const claimed = new Set<string>();
  const groups: ReactNode[] = [];

  for (const topic of topics) {
    const rows = sortHandledLast(
      topic.thread_ids.map((id) => byId.get(id)).filter((x): x is Thread => Boolean(x)),
    );
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
            onToggleHandled={() => toggleHandled(r.id, !r.handled_at)}
            t={t}
          />
        ))}
      </div>,
    );
  }

  const orphans = sortHandledLast(threads.filter((x) => !claimed.has(x.id)));
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
            onToggleHandled={() => toggleHandled(r.id, !r.handled_at)}
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
  onCancelWaiting: (id: string) => void,
  onAction: (message: string) => Promise<void> | void,
  onStop: () => void,
): ReactNode[] {
  const childName = new Map(children.map((c) => [c.id, c.title]));
  const out: ReactNode[] = [];
  // The last turn that actually renders (moved turns collapse into a link row,
  // not a TurnView) — the only turn whose interactive blocks stay live. Using
  // turns.length-1 would strand a live block behind trailing moved turns.
  let lastLiveIndex = -1;
  for (let k = turns.length - 1; k >= 0; k -= 1) {
    if (!turns[k].moved_to_thread_id) {
      lastLiveIndex = k;
      break;
    }
  }
  let i = 0;
  // Tracks whether an earlier COMPLETED turn of this thread has been seen. The
  // context-restored banner is gated on it: the runner rebuilds context only from
  // prior done turns (transcript.ts), so with no earlier done turn there is nothing
  // to restore and the banner must stay silent rather than over-claim. Moved turns
  // don't count — their run left this thread, so the rebuild (queried by thread_id)
  // won't include them either.
  let seenPriorDone = false;
  while (i < turns.length) {
    const turn = turns[i];
    if (!turn.moved_to_thread_id) {
      out.push(
        <TurnView
          key={turn.turn_index}
          turn={turn}
          hadPriorDoneTurn={seenPriorDone}
          onCancelWaiting={onCancelWaiting}
          isLast={i === lastLiveIndex}
          onAction={onAction}
          onStop={onStop}
        />,
      );
      if (turn.status === "done") seenPriorDone = true;
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

/**
 * The header account switcher — shows which Claude subscription account the open
 * conversation runs on, and lets the user move it to another account.
 *
 * Why it exists: several accounts can be configured (primary + one or more extras),
 * and when one hits its rolling usage limit the conversation should be movable to one
 * that still has budget — without leaving the console. NOTE: separate accounts only
 * give separate budget when their tokens belong to genuinely separate subscriptions;
 * two tokens minted from the same account share one limit. Compact by default
 * (CLAUDE.md): a small
 * labelled icon button that opens a menu only on click. An account with no token
 * configured is listed but greyed out, so the user can see it exists yet cannot
 * route a thread to a credential that would silently fall back to the primary.
 */
function AccountSwitcher({
  accounts,
  value,
  disabled,
  onChange,
}: {
  accounts: Account[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const t = useTranslations("claudeChat");
  // Explicit id→key map (not a template key) so next-intl's typed keys still check.
  // A third/Nth account the operator added (any id past the two built-ins) has no
  // fixed translation — fall back to the raw id, which the operator can override
  // with a CLAUDE_ACCOUNT_LABEL_<ID> secret that arrives as `a.label`.
  const defaultLabel = (id: string) =>
    id === "primary"
      ? t("account.primary")
      : id === "automation"
        ? t("account.automation")
        : id;
  const labelFor = (a: Account) => a.label?.trim() || defaultLabel(a.id);

  const current = accounts.find((a) => a.id === value);
  const currentLabel = current ? labelFor(current) : defaultLabel(value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          className="h-8 max-w-[9rem] shrink-0 gap-1 px-2 text-[11px] text-muted-foreground"
          aria-label={t("account.aria", { name: currentLabel })}
          title={t("account.aria", { name: currentLabel })}
        >
          <CircleUser className="size-4 shrink-0" />
          <span className="truncate" dir="auto">
            {currentLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <DropdownMenuLabel>{t("account.menuTitle")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accounts.map((a) => {
          const selected = a.id === value;
          // The current account is always shown selectable (it may be an
          // unconfigured value stored earlier); other accounts need a token.
          const selectable = a.configured || selected;
          return (
            <DropdownMenuItem
              key={a.id}
              disabled={!selectable}
              onSelect={() => {
                if (!selected && selectable) onChange(a.id);
              }}
              className="gap-2"
            >
              <Check className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {labelFor(a)}
              </span>
              {!a.configured && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t("account.notConnected")}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One exchange: what you said, then what came back. */
/** After this much silence from a RUNNING turn, the live line flags it as possibly
 *  stuck. The runner pings every ~20s, so three missed pings ≈ a dead process. The
 *  server recoverer is the real fix (it re-runs the turn); this is the honest UI
 *  ahead of it. */
const STALL_NOTE_MS = 65_000;

/** A duration as a compact m:ss / h:mm:ss clock — language-neutral, rendered LTR. */
function clockFmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The one detail worth showing for a tool call — the command, file, or query it
 *  ran on — pulled defensively from the stored tool input. */
function toolDetail(ev: TurnEvent): string | null {
  if (!ev.text) return null;
  try {
    const o = JSON.parse(ev.text) as Record<string, unknown>;
    const v = o.description ?? o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url;
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 70);
  } catch {
    // Not JSON (a plain-text tool input) — the tool name alone is enough.
  }
  return null;
}

/** Name what the turn is doing right now, from its newest stored event. */
function activityLabel(turn: Turn, t: ReturnType<typeof useTranslations>): string {
  // Token deltas are flowing — the model is writing RIGHT NOW, whatever the
  // last stored event was (stored events lag the live tail by a block).
  if (turn.live_text) return t("live.writing");
  const ev = turn.events.length > 0 ? turn.events[turn.events.length - 1] : null;
  if (!ev) return t("live.starting");
  if (ev.kind === "tool_use") {
    const name = ev.tool_name ?? "?";
    const detail = toolDetail(ev);
    return detail ? t("live.toolWith", { name, detail }) : t("live.tool", { name });
  }
  if (ev.kind === "assistant") return t("live.writing");
  if (ev.kind === "tool_result") return t("live.reading");
  return t("live.working");
}

/**
 * A Claude-Code-style live status line for a turn in flight: what it is doing now,
 * how long it has been running, how many steps it has taken — refreshed on every
 * poll (~1s while live). A 'queued' turn shows a plain "starting" line (it has no
 * process yet). A 'running' turn whose heartbeat (updated_at) has gone quiet past
 * STALL_NOTE_MS gets a "no response — maybe stuck" note with a stop affordance; the
 * server recoverer will re-run it on its own, but this tells the user what is (not)
 * happening in the meantime.
 */
function LiveRunStatus({ turn, onStop }: { turn: Turn; onStop: () => void }) {
  const t = useTranslations("claudeChat");

  if (turn.status !== "running") {
    // queued, parked on the subscription usage window — the server resumes it by
    // itself (recover.ts): at the reset moment when the CLI's message named one
    // (shown here, in New York time), otherwise on a 15-minute probe. Either
    // way, tell the user that — not "starting".
    if (turn.error?.startsWith(USAGE_WAIT_PREFIX)) {
      // Anchored to the sentinel prefix (mirrors the server's USAGE_UNTIL_RE):
      // an `until=` that merely appears inside the quoted CLI text is not a
      // schedule.
      const untilMatch = turn.error.match(/^usage-limit-wait:until=([0-9TZ:.+-]+);/);
      const untilMs = untilMatch ? Date.parse(untilMatch[1]) : NaN;
      const untilLabel = Number.isFinite(untilMs)
        ? new Intl.DateTimeFormat("he-IL", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(untilMs))
        : null;
      return (
        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500" dir="auto">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>
            {untilLabel ? t("live.usageWaitUntil", { time: untilLabel }) : t("live.usageWait")}
          </span>
        </p>
      );
    }
    // queued — dispatched but not yet started (or just re-queued by the recoverer).
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin shrink-0" />
        <span>{t("live.starting")}</span>
      </p>
    );
  }

  const now = Date.now();
  const startMs = turn.started_at
    ? Date.parse(turn.started_at)
    : Date.parse(turn.created_at);
  const beatMs = turn.updated_at ? Date.parse(turn.updated_at) : startMs;
  const elapsed = Number.isFinite(startMs) ? now - startMs : 0;
  const idle = Number.isFinite(beatMs) ? now - beatMs : 0;
  const steps = turn.events.length;
  const resumed = (turn.resume_attempts ?? 0) > 0;
  const stalled = idle > STALL_NOTE_MS;

  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground" dir="auto">
        <span className="flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          <span>{activityLabel(turn, t)}</span>
        </span>
        <span dir="ltr" className="tabular-nums text-muted-foreground/70">
          {clockFmt(elapsed)}
        </span>
        {steps > 0 && (
          <span className="text-muted-foreground/70">· {t("live.steps", { n: steps })}</span>
        )}
        {resumed && (
          <span className="text-muted-foreground/70">· {t("live.resumed")}</span>
        )}
      </p>
      {stalled && (
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-500" dir="auto">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>{t("live.noOutput", { d: clockFmt(idle) })}</span>
          <button
            type="button"
            onClick={onStop}
            className="rounded px-1 underline-offset-2 hover:underline"
          >
            {t("live.stopHint")}
          </button>
        </p>
      )}
    </div>
  );
}

function TurnView({
  turn,
  hadPriorDoneTurn,
  onCancelWaiting,
  isLast,
  onAction,
  onStop,
}: {
  turn: Turn;
  hadPriorDoneTurn: boolean;
  onCancelWaiting: (id: string) => void;
  /** This is the last turn of the thread — the only turn whose interactive
   *  blocks are still live (older turns render them read-only). */
  isLast: boolean;
  /** Send a follow-up turn when the user answers an interactive block. Returns
   *  the send promise so a block can revert its latch if the turn fails. */
  onAction: (message: string) => Promise<void> | void;
  /** Stop the executing turn — used by the live status line's "stop" affordance
   *  when a run looks stalled. */
  onStop: () => void;
}) {
  const t = useTranslations("claudeChat");
  const [toolsOpen, setToolsOpen] = useState(false);

  const { answer, tools } = useMemo(() => {
    const texts: string[] = [];
    const toolNames: string[] = [];
    for (const ev of turn.events) {
      if (ev.kind === "assistant" && ev.text) texts.push(ev.text);
      else if (ev.kind === "tool_use" && ev.tool_name) toolNames.push(ev.tool_name);
    }
    // The live tail: the assistant block currently being written, streamed as
    // token deltas — appended after the completed blocks so the bubble grows
    // word-by-word. Cleared (upstream) the moment the completed block arrives.
    const liveTail = (turn.live_text ?? "").trim();
    if (liveTail) texts.push(liveTail);
    // result_summary is the engine's final answer. Preferred when the streamed
    // assistant text is empty (a turn that only used tools), so the bubble is
    // never blank on a turn that did finish.
    const joined = texts.join("\n\n").trim();
    return { answer: joined || (turn.result_summary ?? "").trim(), tools: toolNames };
  }, [turn.events, turn.result_summary, turn.live_text]);

  const live = turn.status === "queued" || turn.status === "running";
  const waiting = turn.status === "waiting";
  const turnTokens = (turn.input_tokens ?? 0) + (turn.output_tokens ?? 0);
  // Friendly model name for the quiet per-turn label; fall back to the raw id for a
  // model not in the picker list (older runs), null when the run pinned no model.
  const modelName = turn.model ? (MODELS.find((m) => m.id === turn.model)?.name ?? turn.model) : null;

  // A failed turn often records the SAME text twice — the runner stores the engine's
  // last message as both result_summary (rendered as the answer bubble) and error
  // (rendered as the red line). A usage-limit hit — "You've hit your weekly limit ·
  // resets 4am (UTC)" — is the case in point, and it showed up once in grey and once
  // in red. Suppress the grey duplicate whenever the error line already contains the
  // whole answer text, so it is stated once, in red. Lossless: the error line is
  // always shown on failure and here holds the answer verbatim. A failed turn whose
  // answer carries MORE than the error (a real partial answer) keeps both.
  const errText = (turn.error ?? "").trim();
  const answerDupesError = turn.status === "failed" && !!answer && errText.startsWith(answer);
  const showAnswer = !!answer && !answerDupesError;
  // Two kinds of files on one turn: what the user SENT (chips on their message)
  // and what the run PRODUCED — browser screenshots posted back mid-run, shown
  // as inline images with the reply. `source` is absent on rows created before
  // the column existed; those are all user uploads.
  const userAttachments = turn.attachments.filter((a) => a.source !== "run");
  const runAttachments = turn.attachments.filter((a) => a.source === "run");
  const screenshots = runAttachments.filter((a) => a.signed_url);
  // A run file whose signed URL failed to mint still gets named — invisible
  // evidence is worse than an unclickable filename.
  const unsignedRunFiles = runAttachments.filter((a) => !a.signed_url);

  return (
    <div className="flex flex-col gap-2">
      {(turn.user_prompt || userAttachments.length > 0) && (
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
            {userAttachments.length > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground" dir="auto">
                {userAttachments.map((a) => a.filename).join(" · ")}
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

          {showAnswer && (
            <div className="group/msg flex items-start gap-1">
              {/* Rich rendering, chat density: headings, lists, tables and code
                  the same way the .md docs render, tightened to a bubble.
                  AnswerContent additionally turns any embedded smrt-ask /
                  smrt-plan block into a live widget (interactive only on the
                  last turn); a plain answer takes the single-Markdown fast
                  path so nothing changes for ordinary replies. */}
              <AnswerContent
                answer={answer}
                interactive={isLast && turn.status === "done"}
                onAction={onAction}
                className="min-w-0 flex-1"
              />
              <CopyButton
                text={answer}
                label={t("copyMessage")}
                copiedLabel={t("copied")}
                reveal="msg"
                className="mt-0.5 shrink-0"
              />
            </div>
          )}

          {unsignedRunFiles.length > 0 && (
            <p className="text-[11px] text-muted-foreground" dir="auto">
              {unsignedRunFiles.map((a) => a.filename).join(" · ")}
            </p>
          )}

          {screenshots.length > 0 && (
            // What the run SAW: browser screenshots it posted back. Thumbnails,
            // not full-size — a click opens the real image (signed URL, ~1h).
            <div className="flex flex-wrap gap-2">
              {screenshots.map((s) => (
                <a
                  key={s.id}
                  href={s.signed_url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={s.filename}
                  className="block overflow-hidden rounded-lg border border-border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed
                      Supabase URL with ~1h expiry; next/image optimization would
                      cache/proxy a URL that dies, and these are ephemeral proofs,
                      not site assets. */}
                  <img
                    src={s.signed_url!}
                    alt={s.filename}
                    loading="lazy"
                    className="max-h-48 w-auto max-w-full"
                  />
                </a>
              ))}
            </div>
          )}

          {live && <LiveRunStatus turn={turn} onStop={onStop} />}

          {/* Queued behind the live turn — it will run on its own; the one action
              it offers is leaving the line. */}
          {waiting && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("queue.waiting")}</span>
              <button
                type="button"
                onClick={() => onCancelWaiting(turn.id)}
                className="rounded px-1 text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
              >
                {t("queue.remove")}
              </button>
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

          {/* The turn's own consumption + which model produced it, stated quietly
              once it finished. Model shows even when no token figures came back. */}
          {!live && !waiting && (turnTokens > 0 || modelName) && (
            <p dir="ltr" className="text-[10px] tabular-nums text-muted-foreground/70 text-start">
              {turnTokens > 0 && (
                <>
                  {fmtTokens(turnTokens)} {t("usage.tokens")}
                  {typeof turn.duration_ms === "number" && turn.duration_ms > 0
                    ? ` · ${Math.round(turn.duration_ms / 1000)}s`
                    : ""}
                </>
              )}
              {modelName ? `${turnTokens > 0 ? " · " : ""}${modelName}` : ""}
            </p>
          )}

          {/* Said out loud rather than hidden: a turn past the first that resumed
              no engine session had its context rebuilt from our DB (the runner's
              recovery path prepends the prior turns from claude_runs) — the live
              session reset on a container restart, but the conversation carried
              over. Gated on an earlier completed turn existing (hadPriorDoneTurn):
              the rebuild draws only on prior done turns, so with none there was
              nothing to restore and we stay silent instead of over-claiming. A
              transient DB read failure during the rebuild is the one residual case
              this can't see — it's logged server-side (transcript.ts). Info, not a
              warning. */}
          {turn.turn_index > 1 &&
            turn.status === "done" &&
            !turn.resumed_session &&
            hadPriorDoneTurn && (
              <p className="text-[11px] text-muted-foreground">{t("contextRestored")}</p>
            )}
        </div>
      </div>
    </div>
  );
}
