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

export interface SystemMessageEntry {
  /** Unique per entry (toast id + timestamp — toast ids repeat across reloads). */
  id: string;
  type: SystemMessageType;
  text: string;
  /** Where it happened: pathname + search of the top window, locale included. */
  path: string;
  /** ISO UTC; converted to America/New_York only at display. */
  at: string;
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
        !!e && typeof e === "object" && typeof (e as SystemMessageEntry).text === "string",
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
