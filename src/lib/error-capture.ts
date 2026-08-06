"use client";

/**
 * Global client-error capture — the "full" catcher.
 *
 * Three sources feed one pipeline:
 *   1. Failed backend calls        — reported from `api()`/`apiStream()` (client.ts).
 *   2. Uncaught JS errors          — window "error" listener (installed here).
 *   3. Unhandled promise rejections — window "unhandledrejection" listener.
 *
 * What each capture does:
 *   • Backend record: POST /api/client-errors → a log_entries row (level='error',
 *     category='client_error'). That single row is fanned out to every super-admin
 *     by the notify_superadmins_on_error trigger and shows up in the daily health
 *     report — so errors are visible platform-wide, not only on the device they
 *     happened on.
 *   • Bell record: the entry lands in the sidebar SystemMessagesBell archive.
 *
 * Two design choices that keep this clean and non-duplicating:
 *   • API errors are NOT recorded to the bell here. They already produce a sonner
 *     toast at the call site, which SystemMessagesRecorder archives with the exact
 *     active-tab screen. We only STASH the rich detail (endpoint/status/body) keyed
 *     by the message text; the recorder attaches it when it archives that toast.
 *     One entry, right screen, full detail.
 *   • JS/promise errors have NO toast of their own, so here we raise one ourselves
 *     (the recorder then archives it, detail attached from the stash). For a
 *     super-admin the toast carries a "debug in Claude" action.
 *
 * Loop protection: identical errors are de-duplicated within a short window and
 * the whole pipeline is rate-limited, so a render loop can't flood the bell,
 * the network, or log_entries.
 */

import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { ClientErrorDetail } from "@/lib/system-messages";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

/** Whether the current user may launch /claude (super-admin). Set by the mounted
 *  ClientErrorCatcher from AppAccessContext; gates the toast's debug action. */
let debugAffordance = false;
export function setDebugAffordance(on: boolean) {
  debugAffordance = on;
}

/** The event a debug action fires; ClientErrorCatcher (React) navigates on it. */
export const OPEN_CLAUDE_DEBUG_EVENT = "smrtesy:open-claude-debug";
export interface OpenClaudeDebugDetail {
  text: string;
  path: string;
  detail?: ClientErrorDetail;
}

/** Marker set on an error object once client.ts has already reported it, so the
 *  window 'error'/'unhandledrejection' net doesn't report the SAME rejected
 *  ApiError a second time (a bare `await api()` that rejects would otherwise be
 *  logged twice, the second time with weaker stack-only detail). */
export const REPORTED_FLAG = "__smrtErrorReported";
function alreadyReported(reason: unknown): boolean {
  return !!reason && typeof reason === "object" && (reason as Record<string, unknown>)[REPORTED_FLAG] === true;
}

// ── stash: rich detail keyed by message text, for the recorder to attach ──────
// A FIFO QUEUE per key, not a single slot: two concurrent errors sharing the same
// text (e.g. "HTTP 500") must not overwrite each other's endpoint/status — the
// recorder shifts the oldest, matching the order toasts fire in.
interface Stashed { detail: ClientErrorDetail; at: number; }
const STASH_TTL_MS = 15_000;
const STASH_MAX_PER_KEY = 5;
const stash = new Map<string, Stashed[]>();

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 200).toLowerCase();
}

/** Drop expired entries everywhere; delete keys whose queue empties. */
function pruneStash(now: number) {
  for (const [k, q] of stash) {
    const live = q.filter((s) => now - s.at <= STASH_TTL_MS);
    if (live.length) stash.set(k, live);
    else stash.delete(k);
  }
}

/** Record the rich detail for a message so SystemMessagesRecorder can attach it
 *  to the toast entry it archives. */
function stashDetail(text: string, detail: ClientErrorDetail) {
  const now = Date.now();
  pruneStash(now);
  const key = normalize(text);
  const q = stash.get(key) ?? [];
  q.push({ detail, at: now });
  stash.set(key, q.slice(-STASH_MAX_PER_KEY));
}

/** Consumed by SystemMessagesRecorder when archiving an error toast — shifts the
 *  OLDEST live detail for this text (FIFO, matching toast order). */
export function takeStashedDetail(text: string): ClientErrorDetail | undefined {
  const now = Date.now();
  const key = normalize(text);
  const q = stash.get(key);
  if (!q) return undefined;
  while (q.length) {
    const head = q.shift()!;
    if (now - head.at <= STASH_TTL_MS) {
      if (!q.length) stash.delete(key);
      return head.detail;
    }
  }
  stash.delete(key);
  return undefined;
}

// ── recent-events ring buffer ─────────────────────────────────────────────────
// A small rolling record of the last uncaught errors and failed API calls, kept
// so the user-facing "report a problem" dialog can SHOW the user what it will
// send (privacy: nothing is transmitted until they press send). Fed from the two
// capture points below, unconditionally (before dedup/rate-limit), so a report
// filed right after a swallowed error still carries it.
export interface RecentClientEvent {
  /** "js" / "promise" (a console error) or "api" (a failed backend request). */
  type: "js" | "promise" | "api";
  message: string;
  at: number;
  /** For an api event: the failed request's method / url / status. */
  method?: string;
  url?: string;
  status?: number;
}
const RECENT_MAX = 10;
const recentEvents: RecentClientEvent[] = [];

function pushRecent(e: RecentClientEvent) {
  recentEvents.push(e);
  if (recentEvents.length > RECENT_MAX) recentEvents.splice(0, recentEvents.length - RECENT_MAX);
}

/** The recent client events, newest last. Read by the report dialog for preview. */
export function getRecentClientEvents(): RecentClientEvent[] {
  return recentEvents.slice();
}

// ── dedup + rate limit ────────────────────────────────────────────────────────
const DEDUP_WINDOW_MS = 10_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 25;
const lastSeen = new Map<string, number>();
let windowStart = 0;
let windowCount = 0;

/** True when this signature should be handled (not a recent duplicate and not
 *  over the per-minute cap). Signature folds digit runs so id-varying repeats of
 *  the same error collapse together. */
function shouldHandle(signature: string): boolean {
  const now = Date.now();
  const sig = signature.replace(/[0-9a-f-]{8,}/gi, "#").slice(0, 160);

  const prev = lastSeen.get(sig);
  if (prev && now - prev < DEDUP_WINDOW_MS) return false;
  lastSeen.set(sig, now);
  if (lastSeen.size > 200) for (const [k, v] of lastSeen) if (now - v > DEDUP_WINDOW_MS) lastSeen.delete(k);

  if (now - windowStart > RATE_WINDOW_MS) { windowStart = now; windowCount = 0; }
  if (windowCount >= RATE_MAX) return false;
  windowCount += 1;
  return true;
}

function currentPath(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search}`;
}

/** Fire-and-forget POST to the backend recorder. Never throws, never reports its
 *  OWN failure (that would recurse), and never goes through `api()` (same reason
 *  + avoids a circular import). */
async function postToBackend(body: Record<string, unknown>): Promise<boolean> {
  try {
    const { data: { session } } = await createClient().auth.getSession();
    if (!session) return false; // not signed in — nothing to attribute the row to
    const res = await fetch(`${BACKEND}/api/client-errors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
      keepalive: true, // survive a navigation triggered by the same error
    });
    return res.ok;
  } catch {
    // Best-effort: the bell entry still captured it locally.
    return false;
  }
}

/**
 * Report a failed backend call. Called from client.ts right before it throws the
 * ApiError, so the detail is stashed BEFORE the call site's toast fires and the
 * recorder can attach it. Does not itself touch the bell (the toast will).
 */
export function reportApiError(input: {
  message: string;
  method: string;
  url: string;
  status: number;
  responseBody?: string;
}) {
  if (typeof window === "undefined") return;
  const detail: ClientErrorDetail = {
    kind: "api",
    status: input.status,
    method: input.method,
    url: input.url,
    responseBody: input.responseBody?.slice(0, 800),
  };
  // Stash unconditionally (cheap) so a de-duplicated repeat still enriches its
  // toast; only the network/log side is rate-limited.
  stashDetail(input.message, detail);
  pushRecent({ type: "api", message: input.message, at: Date.now(), method: input.method, url: input.url, status: input.status });
  if (!shouldHandle(`api ${input.status} ${input.url} ${input.message}`)) return;
  void postToBackend({
    kind: "api",
    message: input.message,
    route: currentPath(),
    status: input.status,
    method: input.method,
    url: input.url,
    responseBody: detail.responseBody,
    userAgent: navigator.userAgent,
  });
}

/** Shared handling for an uncaught JS error / rejection: raise a toast (so it is
 *  visible AND archived by the recorder), stash the stack, and record it in the
 *  backend. */
function reportUncaught(kind: "js" | "promise", message: string, stack?: string) {
  if (typeof window === "undefined") return;
  const clean = (message || "Unknown error").trim().slice(0, 300);
  const detail: ClientErrorDetail = { kind, stack: stack?.slice(0, 4000) };
  stashDetail(clean, detail);
  pushRecent({ type: kind, message: clean, at: Date.now() });
  if (!shouldHandle(`${kind} ${clean}`)) return;

  const path = currentPath();
  toast.error(clean, {
    action: debugAffordance
      ? {
          label: "🛠",
          onClick: () =>
            window.dispatchEvent(
              new CustomEvent<OpenClaudeDebugDetail>(OPEN_CLAUDE_DEBUG_EVENT, {
                detail: { text: clean, path, detail },
              }),
            ),
        }
      : undefined,
  });

  void postToBackend({
    kind,
    message: clean,
    route: path,
    stack: detail.stack,
    userAgent: navigator.userAgent,
  });
}

/**
 * Install the window-level listeners. Idempotent, returns a cleanup fn. Mounted
 * once by ClientErrorCatcher.
 */
export function installGlobalErrorCatcher(): () => void {
  if (typeof window === "undefined") return () => {};

  const onError = (e: ErrorEvent) => {
    // Resource-load failures (a broken <img>/<script>) surface as an "error"
    // event with no `error` object — not a JS exception, and usually noise.
    if (!e.error && !e.message) return;
    if (alreadyReported(e.error)) return; // client.ts already logged this one richly
    const msg = e.message || "";
    // Benign, famously-spammy, and non-actionable — the ResizeObserver notice
    // and cross-origin "Script error." with zero detail.
    if (/ResizeObserver loop/i.test(msg)) return;
    if (/^Script error\.?$/i.test(msg) && !e.error) return;
    reportUncaught("js", msg || String(e.error), (e.error as Error | undefined)?.stack);
  };

  const onRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    if (alreadyReported(reason)) return; // a bare `await api()` that rejected — client.ts logged it
    const message =
      reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportUncaught("promise", message, stack);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

// ── feature-channels telemetry (docs/feature-channels-plan.md §8) ───────────────
// The same backend sink (POST /api/client-errors → a log_entries row) carries the
// feature log too — no new endpoint. Two categories set it apart from the plain
// client_error rows: 'feature' (auto — a boundary caught a crash) and
// 'feature_report' (the user pressed "report a problem").

/**
 * Source 1 — automatic. Called by PaneHost's PaneErrorBoundary from
 * componentDidCatch: the crash is still caught and the fallback still shown, this
 * only records it. category='feature'. Best-effort, never throws.
 */
export function reportFeatureCrash(input: {
  featureId: string | null;
  screenKey: string;
  message: string;
  stack?: string;
  url: string;
}): void {
  if (typeof window === "undefined") return;
  if (!shouldHandle(`feature-crash ${input.screenKey} ${input.featureId ?? ""} ${input.message}`)) return;
  void postToBackend({
    kind: "react",
    category: "feature",
    message: (input.message || "Feature crash").slice(0, 2000),
    route: input.url,
    feature_id: input.featureId ?? undefined,
    screen_key: input.screenKey,
    stack: input.stack?.slice(0, 4000),
    url: input.url,
    userAgent: navigator.userAgent,
  });
}

/**
 * Source 2 — user-initiated. Called by the "report a problem" dialog after the
 * user has SEEN the collected context and pressed send. category='feature_report'.
 * Returns whether the backend accepted it, so the dialog can toast success/failure.
 */
export async function submitFeatureReport(input: {
  featureId: string | null;
  screenKey: string;
  description: string;
  report: Record<string, unknown>;
}): Promise<boolean> {
  if (typeof window === "undefined") return false;
  return postToBackend({
    kind: "user",
    category: "feature_report",
    message: (input.description || "(no description)").slice(0, 2000),
    route: input.screenKey,
    feature_id: input.featureId ?? undefined,
    screen_key: input.screenKey,
    report: input.report,
    userAgent: navigator.userAgent,
  });
}
