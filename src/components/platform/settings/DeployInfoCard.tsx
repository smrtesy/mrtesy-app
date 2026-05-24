"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitCommit, Server, Globe, Loader2 } from "lucide-react";

interface DeployInfo {
  commit:         string | null;
  commit_short:   string | null;
  branch:         string | null;
  commit_message: string | null;
  deployment_id:  string | null;
  boot_at:        string;
  env?:           string | null;
  uptime_seconds?: number | null;
}

/**
 * Shows the commit SHA + boot time of BOTH the Next.js frontend (Vercel)
 * and the Express backend (Railway). The user can spot a stale browser
 * cache or a backend that hasn't redeployed by comparing the short SHA
 * here against the latest commit on `main` on GitHub.
 *
 * Frontend info comes from /api/deploy-info (this Next.js route reads
 * VERCEL_GIT_* env vars at runtime). Backend info comes from
 * /api/version on the Express server (RAILWAY_GIT_* env vars). Both
 * endpoints return null SHA in local dev where the env isn't injected.
 */
export function DeployInfoCard() {
  const t = useTranslations("settings");
  const [frontend, setFrontend] = useState<DeployInfo | null>(null);
  const [backend,  setBackend]  = useState<DeployInfo | null>(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Fetch directly, bypassing the api() helper — these are public-ish
        // diagnostic endpoints (no auth needed for the deploy SHA), and we
        // don't want a /version 401 to spam the toast layer.
        const [fRes, bRes] = await Promise.allSettled([
          fetch("/api/deploy-info", { cache: "no-store" }).then((r) => r.json()),
          fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001"}/api/version`, { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (fRes.status === "fulfilled") setFrontend(fRes.value as DeployInfo);
        if (bRes.status === "fulfilled") setBackend(bRes.value as DeployInfo);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("deployInfoTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("deployInfoLoading")}
          </div>
        ) : (
          <>
            <DeployRow
              label={t("deployFrontend")}
              icon={<Globe className="h-4 w-4 text-blue-500" />}
              info={frontend}
            />
            <DeployRow
              label={t("deployBackend")}
              icon={<Server className="h-4 w-4 text-emerald-500" />}
              info={backend}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DeployRow({
  label,
  icon,
  info,
}: {
  label: string;
  icon: React.ReactNode;
  info: DeployInfo | null;
}) {
  const t = useTranslations("settings");
  if (!info) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 font-medium">
          {icon}
          {label}
        </span>
        <span className="text-muted-foreground">{t("deployUnreachable")}</span>
      </div>
    );
  }

  const sha = info.commit_short;
  const commitLink = info.commit
    ? `https://github.com/smrtesy/mrtesy-app/commit/${info.commit}`
    : null;
  const bootedAgo = formatTimeAgo(info.boot_at);
  const fullMsg = (info.commit_message ?? "").split("\n")[0];

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 font-medium">
          {icon}
          {label}
        </span>
        <div className="flex items-center gap-2">
          {sha ? (
            commitLink ? (
              <a
                href={commitLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs"
              >
                <Badge variant="outline" className="gap-1 font-mono">
                  <GitCommit className="h-3 w-3" />
                  {sha}
                </Badge>
              </a>
            ) : (
              <Badge variant="outline" className="gap-1 font-mono">
                <GitCommit className="h-3 w-3" />
                {sha}
              </Badge>
            )
          ) : (
            <Badge variant="outline" className="text-xs">dev</Badge>
          )}
        </div>
      </div>
      <div className="ms-6 space-y-0.5 text-[11px] text-muted-foreground">
        {fullMsg && (
          <p className="line-clamp-1" dir="auto" title={info.commit_message ?? ""}>
            {fullMsg}
          </p>
        )}
        <p>
          {t("deployBootedAgo", { when: bootedAgo })}
          {info.branch && info.branch !== "main" ? ` · ${info.branch}` : ""}
        </p>
      </div>
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
