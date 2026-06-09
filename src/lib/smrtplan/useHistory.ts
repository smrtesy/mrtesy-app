/**
 * useHistory — an undo/redo command stack for the smrtPlan edit mode.
 *
 * Each editing action (drag a bar, move/add/delete a milestone, rename, add a
 * row) is recorded as a Command with a `redo` and an `undo` (both async, both
 * going through the same API the action already uses). The first execution of
 * an action runs through `run`, so redo and the original action share one path.
 *
 * Stable identity across create→undo→redo: a created entity gets a fresh server
 * id every time it is re-created, which would orphan later commands that
 * reference it. So commands address entities by a STABLE key, and the hook keeps
 * a key⇄live-id registry. `keyOf(liveId)` finds (or creates) the stable key for
 * something currently on screen; `resolve(key)` returns its current real id;
 * `bind(key, realId)` re-points the key after a (re)create. Pre-existing
 * entities use their real id as the key (identity mapping), so the common case
 * is free.
 */

"use client";

import { useCallback, useRef, useState } from "react";

export interface HistoryCmd {
  label: string;
  redo: () => Promise<void>;
  undo: () => Promise<void>;
}

const MAX_DEPTH = 100;

export function useHistory() {
  const undoStack = useRef<HistoryCmd[]>([]);
  const redoStack = useRef<HistoryCmd[]>([]);
  const liveId = useRef(new Map<string, string>()); // stable key → current real id
  const keyByLive = useRef(new Map<string, string>()); // current real id → stable key
  const busy = useRef(false);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const resolve = useCallback((key: string) => liveId.current.get(key) ?? key, []);
  const keyOf = useCallback((live: string) => keyByLive.current.get(live) ?? live, []);
  /** Point a stable key at its (new) real id — call right after a (re)create. */
  const bind = useCallback((key: string, realId: string) => {
    const prev = liveId.current.get(key);
    if (prev) keyByLive.current.delete(prev);
    liveId.current.set(key, realId);
    keyByLive.current.set(realId, key);
  }, []);

  /** Run a fresh action for the first time, then record it for undo. */
  const run = useCallback(
    async (cmd: HistoryCmd) => {
      if (busy.current) return;
      busy.current = true;
      try {
        await cmd.redo();
        undoStack.current = [...undoStack.current.slice(-(MAX_DEPTH - 1)), cmd];
        redoStack.current = [];
        rerender();
      } finally {
        busy.current = false;
      }
    },
    [rerender],
  );

  const undo = useCallback(async () => {
    if (busy.current) return;
    const cmd = undoStack.current[undoStack.current.length - 1];
    if (!cmd) return;
    busy.current = true;
    try {
      await cmd.undo();
      undoStack.current = undoStack.current.slice(0, -1);
      redoStack.current = [...redoStack.current, cmd];
      rerender();
    } finally {
      busy.current = false;
    }
  }, [rerender]);

  const redo = useCallback(async () => {
    if (busy.current) return;
    const cmd = redoStack.current[redoStack.current.length - 1];
    if (!cmd) return;
    busy.current = true;
    try {
      await cmd.redo();
      redoStack.current = redoStack.current.slice(0, -1);
      undoStack.current = [...undoStack.current, cmd];
      rerender();
    } finally {
      busy.current = false;
    }
  }, [rerender]);

  /** Wipe the history (e.g. when the board reloads from scratch). */
  const reset = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    liveId.current.clear();
    keyByLive.current.clear();
    rerender();
  }, [rerender]);

  return {
    run,
    undo,
    redo,
    reset,
    resolve,
    keyOf,
    bind,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    nextUndoLabel: undoStack.current[undoStack.current.length - 1]?.label ?? null,
    nextRedoLabel: redoStack.current[redoStack.current.length - 1]?.label ?? null,
  };
}
