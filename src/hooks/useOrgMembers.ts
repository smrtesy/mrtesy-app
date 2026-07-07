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

async function fetchMembers(): Promise<OrgMember[]> {
  if (cached) return cached;
  if (!inflight) {
    inflight = api<{ members: OrgMember[] }>("/api/org/members")
      .then((res) => {
        cached = res.members ?? [];
        return cached;
      })
      .catch(() => {
        // Member names are a display refinement — a failed fetch must never
        // break the surrounding screen. Fall back to an empty roster (ids
        // render abbreviated) and allow a retry on the next mount.
        inflight = null;
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
    fetchMembers().then((m) => {
      if (alive) {
        setMembers(m);
        setLoading(false);
      }
    });
    const refetch = () => {
      fetchMembers().then((m) => {
        if (alive) setMembers(m);
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
