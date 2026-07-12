"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api/client";
import {
  type DayToolsState,
  type DayToolSlug,
  type DayToolConfig,
  resolveTool,
} from "@/lib/smrttask/day-tools";

/**
 * Shared client store for the day-tools state (`user_settings.day_tools`).
 *
 * Mirrors useWorkCalendar's module-level cache — several components on the
 * same screen (TaskList, the focus block, the settings section) read the same
 * state — but adds writes: setToolConfig PATCHes /me/settings (tool-level
 * merge on the server) and notifies every subscriber so the UI stays in sync
 * without a refetch.
 */

let cache: DayToolsState | null = null;
let inflight: Promise<DayToolsState> | null = null;
const subscribers = new Set<(s: DayToolsState) => void>();

function notify() {
  for (const fn of subscribers) fn(cache ?? {});
}

async function fetchState(): Promise<DayToolsState> {
  if (cache) return cache;
  if (!inflight) {
    inflight = api<{ settings: { day_tools?: DayToolsState } | null }>("/api/me/settings")
      .then((res) => {
        cache = res.settings?.day_tools ?? {};
        return cache;
      })
      .catch(() => {
        // Never break the UI over a settings fetch — fall back to registry
        // defaults (empty state → resolveTool returns defaults).
        inflight = null;
        return {};
      });
  }
  return inflight;
}

export interface UseDayTools {
  state: DayToolsState;
  loading: boolean;
  /** Merge a partial config into one tool and persist it. */
  setToolConfig: (slug: DayToolSlug, patch: Partial<DayToolConfig>) => Promise<void>;
}

export function useDayTools(): UseDayTools {
  const [state, setState] = useState<DayToolsState>(cache ?? {});
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    subscribers.add(setState);
    fetchState().then((s) => {
      setState(s);
      setLoading(false);
    });
    return () => {
      subscribers.delete(setState);
    };
  }, []);

  const setToolConfig = useCallback(async (slug: DayToolSlug, patch: Partial<DayToolConfig>) => {
    const prev = cache ?? {};
    const next: DayToolsState = { ...prev, [slug]: { ...(prev[slug] ?? {}), ...patch } };
    cache = next;
    notify();
    try {
      // Server merges at the tool-key level, so sending just this tool is safe.
      await api("/api/me/settings", { method: "PATCH", body: { day_tools: { [slug]: next[slug] } } });
    } catch (e) {
      cache = prev; // roll back on failure
      notify();
      throw e;
    }
  }, []);

  return { state, loading, setToolConfig };
}

/** Convenience for a single tool: default-aware `{ enabled, ...config }`. */
export function useDayTool(slug: DayToolSlug): { enabled: boolean; config: DayToolConfig; loading: boolean } {
  const { state, loading } = useDayTools();
  const config = resolveTool(state, slug);
  return { enabled: config.enabled, config, loading };
}
