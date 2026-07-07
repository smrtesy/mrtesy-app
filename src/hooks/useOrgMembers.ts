"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";

/** The member fields every consumer of this hook reads (a subset of the full
 *  /api/org/members row — see src/lib/api/use-org-members.ts for the admin
 *  shape with role/app_slugs, which has its own refresh-on-demand hook). */
export interface OrgMember {
  user_id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
}

// Module-level cache: the org roster changes ~never within a session, and
// many components on the same page (board detail, table, dialogs, assignee
// buttons) need it simultaneously — fetch once, share.
let cached: OrgMember[] | null = null;
let inflight: Promise<OrgMember[]> | null = null;
// Cache generation, bumped on every invalidation (org switch). A fetch
// captures the generation it started under and only writes the module cache
// (or hook state — see the effect below) if it still matches when it lands.
// Without this, a roster request in flight when the org changes resolves late
// and poisons the cache with the OLD org's members permanently.
let generation = 0;

async function fetchMembers(): Promise<OrgMember[]> {
  if (cached) return cached;
  if (!inflight) {
    const startedGen = generation;
    inflight = api<{ members: OrgMember[] }>("/api/org/members")
      .then((res) => {
        const members = res.members ?? [];
        // Stale-generation responses are returned to their callers (which
        // apply the same check) but never cached.
        if (startedGen === generation) cached = members;
        return members;
      })
      .catch(() => {
        // Member names are a display refinement — a failed fetch must never
        // break the surrounding screen. Fall back to an empty roster (ids
        // render abbreviated) and allow a retry on the next mount. Only clear
        // OUR inflight slot — a stale failure must not wipe a newer fetch.
        if (startedGen === generation) inflight = null;
        return [];
      });
  }
  return inflight;
}

// The roster is org-scoped: drop the cache when the user switches org so the
// next fetch hits the new org. Registered once, before any per-hook refetch
// listener, so all mounted hooks then join a single fresh inflight fetch.
let invalidationBound = false;
function bindInvalidation() {
  if (invalidationBound || typeof window === "undefined") return;
  invalidationBound = true;
  window.addEventListener("smrtesy:active-org-changed", () => {
    generation++;
    cached = null;
    inflight = null;
  });
}

/**
 * useOrgMembers — the active org's member roster, shared via a session cache.
 * Returns `[]` (with `loading: true`) until the first fetch lands; failures
 * resolve to an empty roster. Pass `enabled: false` to skip fetching (e.g.
 * a control hidden for non-managers).
 */
export function useOrgMembers(enabled = true): { members: OrgMember[]; loading: boolean } {
  const [members, setMembers] = useState<OrgMember[]>(cached ?? []);
  const [loading, setLoading] = useState(enabled && cached == null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    bindInvalidation();
    let alive = true;
    // Same stale-generation guard as the module cache: an org switch while
    // this fetch is in flight makes the result garbage for the current org —
    // don't write it into state (the org-changed refetch below re-runs with
    // the new generation and supplies the fresh roster). loading is still
    // cleared so the surface never hangs on a spinner.
    const startedGen = generation;
    fetchMembers().then((m) => {
      if (alive) {
        if (startedGen === generation) setMembers(m);
        setLoading(false);
      }
    });
    const refetch = () => {
      const refetchGen = generation;
      fetchMembers().then((m) => {
        if (alive && refetchGen === generation) setMembers(m);
      });
    };
    window.addEventListener("smrtesy:active-org-changed", refetch);
    return () => {
      alive = false;
      window.removeEventListener("smrtesy:active-org-changed", refetch);
    };
  }, [enabled]);

  return { members, loading };
}
