"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { BlockedDays } from "@/lib/workdays";

// Module-level cache: the holiday calendar changes ~never within a session,
// and several components on the same page need it simultaneously.
let cached: BlockedDays | null = null;
let inflight: Promise<BlockedDays> | null = null;

async function fetchBlockedDays(): Promise<BlockedDays> {
  if (cached) return cached;
  if (!inflight) {
    inflight = api<{ blocked_days: string[] }>("/api/work-calendar")
      .then((res) => {
        cached = new Set(res.blocked_days ?? []);
        return cached;
      })
      .catch(() => {
        // Holidays are a refinement on top of the Mon–Fri weekend; failing to
        // load them must never break day math — fall back to weekend-only.
        inflight = null;
        return new Set<string>();
      });
  }
  return inflight;
}

/**
 * The org's blocked (non-working) dates for business-day math. Returns an
 * empty set until loaded — weekend-only math in the meantime, which is a
 * close-enough first paint that corrects itself on arrival.
 */
export function useWorkCalendar(): BlockedDays {
  const [blocked, setBlocked] = useState<BlockedDays>(cached ?? new Set());

  useEffect(() => {
    let alive = true;
    fetchBlockedDays().then((set) => { if (alive) setBlocked(set); });
    return () => { alive = false; };
  }, []);

  return blocked;
}
