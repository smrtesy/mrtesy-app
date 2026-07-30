"use client";

/**
 * A general system-status strip for the sidebar — NOT tied to Claude.
 *
 * One quiet row of three labelled dots: F (frontend / Vercel), B (backend / Railway),
 * DB (database / Supabase). Each dot's colour is the surface's current state — green
 * ready, amber building/transitional, red error, grey unknown/not-configured — and
 * hovering shows the full label + detail. The DB dot reflects the Supabase project's
 * health (not a build), which is why it was added: the database going unhealthy/paused
 * is exactly the kind of outage that otherwise surfaces only when something breaks.
 *
 * Data comes from GET /api/claude/deploy-status (server deploy-status.ts). That route
 * is super-admin gated, so this strip is only mounted for admins (alongside the Claude
 * button in the sidebar). Polls on a slow interval; silent on error (ambient chrome).
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface ProviderStatus {
  configured: boolean;
  state?: "building" | "ready" | "error" | "unknown";
  rawState?: string;
  commitSha?: string | null;
  createdAt?: string | null;
  hint?: string;
  error?: string;
}

/** Deploy time in New York (CLAUDE.md: all user-facing times are America/New_York). */
function nyTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

interface SystemStatus {
  vercel: ProviderStatus;
  railway: ProviderStatus;
  supabase: ProviderStatus;
}

const POLL_MS = 30_000;

const DOT: Record<string, string> = {
  ready: "bg-status-ok",
  building: "bg-status-warn",
  error: "bg-destructive",
  unknown: "bg-muted-foreground/50",
};

function Dot({ label, full, s }: { label: string; full: string; s: ProviderStatus | undefined }) {
  const state = s?.configured === false ? "unknown" : s?.state ?? "unknown";
  // Hover detail: the error if any, else "not configured" + where to set the token,
  // else state · version (short commit) · deploy date+time in New York — so hovering
  // tells you exactly which version each surface is on and when it shipped.
  const when = nyTime(s?.createdAt);
  const detail = s?.error
    ? s.error
    : s?.configured === false
      ? s?.hint ?? "—"
      : [
          state,
          s?.commitSha ? `v ${s.commitSha.slice(0, 7)}` : null,
          when ? `${when} NY` : null,
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <span className="inline-flex items-center gap-1" title={`${full}: ${detail}`}>
      <span className={cn("size-2.5 rounded-full", DOT[state] ?? DOT.unknown)} />
      <span className="font-medium tabular-nums">{label}</span>
    </span>
  );
}

export function SystemStatusStrip() {
  const t = useTranslations("claudeChat");
  const [data, setData] = useState<SystemStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<SystemStatus>("/api/claude/deploy-status"));
    } catch {
      // Silent — this is ambient status chrome, not an action the user awaits.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!data) return null;

  return (
    <div
      className="flex items-center gap-3 px-1 pt-0.5 text-[10px] text-muted-foreground"
      aria-label={t("deploy.label")}
    >
      <Dot label="F" full={t("deploy.frontend")} s={data.vercel} />
      <Dot label="B" full={t("deploy.backend")} s={data.railway} />
      <Dot label="DB" full={t("deploy.database")} s={data.supabase} />
    </div>
  );
}
