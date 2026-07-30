"use client";

/**
 * A quiet deploy-status badge — the visible consumer of the Vercel/Railway tokens.
 *
 * Two small dots (frontend = Vercel, backend = Railway) coloured by build state:
 * green ready, amber building, red error, grey unknown. It polls
 * /api/claude/deploy-status (deploy-status.ts), which reports each provider as
 * `configured:false` when its token isn't set — and this renders NOTHING for an
 * unconfigured provider, so before any token is saved the badge is invisible (no
 * permanent chrome, per CLAUDE.md). The moment a token is added under
 * /admin/apps/smrttask/secrets the matching dot appears on the next poll.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface ProviderStatus {
  provider: "vercel" | "railway";
  configured: boolean;
  state?: "building" | "ready" | "error" | "unknown";
  rawState?: string;
  commitSha?: string | null;
  error?: string;
}

const POLL_MS = 30_000;

const DOT: Record<string, string> = {
  ready: "bg-status-ok",
  building: "bg-status-warn",
  error: "bg-destructive",
  unknown: "bg-muted-foreground",
};

function Dot({ label, s, t }: { label: string; s: ProviderStatus; t: (k: string) => string }) {
  const state = s.state ?? "unknown";
  // The hover title is the honest detail: which surface, the raw provider state, the
  // short commit if known, or the error. Kept in the title so the badge itself stays
  // to two characters + a dot.
  const detail =
    s.error ??
    [t(`deploy.${state}`), s.commitSha ? s.commitSha.slice(0, 7) : null].filter(Boolean).join(" · ");
  return (
    <span className="inline-flex items-center gap-1" title={`${label}: ${detail}`}>
      <span className={cn("size-2 rounded-full", DOT[state] ?? DOT.unknown)} />
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </span>
  );
}

export function DeployStatusBadge() {
  const t = useTranslations("claude");
  const [data, setData] = useState<{ vercel: ProviderStatus; railway: ProviderStatus } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<{ vercel: ProviderStatus; railway: ProviderStatus }>("/api/claude/deploy-status"));
    } catch {
      // Silent: this is ambient chrome, not an action the user is awaiting.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!data) return null;
  const show: Array<{ label: string; s: ProviderStatus }> = [];
  if (data.vercel?.configured) show.push({ label: t("deploy.frontend"), s: data.vercel });
  if (data.railway?.configured) show.push({ label: t("deploy.backend"), s: data.railway });
  if (show.length === 0) return null; // no token configured → invisible

  return (
    <span className="inline-flex items-center gap-2" aria-label={t("deploy.label")}>
      {show.map((x) => (
        <Dot key={x.label} label={x.label} s={x.s} t={t} />
      ))}
    </span>
  );
}
