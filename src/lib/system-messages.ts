"use client";

/**
 * Client-side log of every system message (sonner toast) the user was shown.
 *
 * Persistence is localStorage on purpose: these are ephemeral UI notices, not
 * tenant data — a per-browser rolling window is exactly the "let me look back
 * at what flashed by" the center exists for. No read/unread state (explicit
 * user decision, 2026-07): the list is a plain archive, newest first, capped.
 *
 * Writes dispatch SYSTEM_MESSAGES_EVENT so an open bell popover re-renders
 * live; readers must also handle a cold read (storage parsed on mount).
 */

export type SystemMessageType = "error" | "warning" | "success" | "info";

/**
 * The rich diagnostic context the global error catcher attaches to an error
 * entry (see `src/lib/error-capture.ts`). Optional and backward-compatible:
 * old entries (and every non-error toast) simply have no `detail`. When present
 * it turns a bare "thread not found" into a debuggable record — which endpoint
 * failed, with what status and body, or which JS stack threw.
 */
export interface ClientErrorDetail {
  /** Where the error originated. */
  kind: "api" | "js" | "promise" | "toast";
  /** HTTP status, for `kind:"api"`. */
  status?: number;
  /** HTTP method, for `kind:"api"`. */
  method?: string;
  /** The API path that failed, for `kind:"api"` (e.g. `/api/claude/threads/<id>`). */
  url?: string;
  /** The server's response body (truncated), for `kind:"api"`. */
  responseBody?: string;
  /** The JS error stack (truncated), for `kind:"js"`/`kind:"promise"`. */
  stack?: string;
}

export interface SystemMessageEntry {
  /** Unique per entry (toast id + timestamp — toast ids repeat across reloads). */
  id: string;
  type: SystemMessageType;
  text: string;
  /** Where it happened: pathname + search of the top window, locale included. */
  path: string;
  /** ISO UTC; converted to America/New_York only at display. */
  at: string;
  /** Rich diagnostic context for error entries (undefined for plain toasts). */
  detail?: ClientErrorDetail;
}

const STORAGE_KEY = "smrtesy-system-messages";
const MAX_ENTRIES = 100;

export const SYSTEM_MESSAGES_EVENT = "smrtesy:system-messages-changed";

export function readSystemMessages(): SystemMessageEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SystemMessageEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as SystemMessageEntry).text === "string" &&
        typeof (e as SystemMessageEntry).path === "string" &&
        typeof (e as SystemMessageEntry).at === "string",
    );
  } catch {
    // Corrupt/blocked storage — behave as an empty archive, never throw into UI.
    return [];
  }
}

function write(entries: SystemMessageEntry[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage full/blocked — the toast itself was still shown; dropping the
    // archive entry is the acceptable failure mode.
  }
  window.dispatchEvent(new Event(SYSTEM_MESSAGES_EVENT));
}

export function recordSystemMessage(entry: SystemMessageEntry) {
  write([entry, ...readSystemMessages()]);
}

export function clearSystemMessages() {
  write([]);
}
