"use client";

/**
 * חיבור לגיטהאב — pick the repository a run works on.
 *
 * One token on the backend gives the app the list of every repo it can reach, so a
 * run is aimed at a repo chosen from the list rather than a path typed from memory.
 * The runner clones the chosen repo into a temporary workspace, so the run reads
 * and edits real files.
 *
 * The full list is shown OPEN by default (the user's request: "כברירת מחדל כל
 * הריפו מופיעים" — like picking a repo in Claude Code on the web): the moment the
 * settings panel renders this component and a token is connected, every repo the
 * token reaches is listed, newest push first, with the search box to narrow. The
 * component itself only mounts when the settings panel opens, so the GitHub API
 * call still happens on demand, not on every screen load. When no token is
 * configured the component says exactly where to put one — the key name and the
 * screen — instead of failing with "not connected".
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FolderGit2, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface Repo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  html_url: string;
}

export function RepoPicker({
  locale,
  repo,
  branch,
  onChange,
}: {
  locale: string;
  repo: string | null;
  branch: string | null;
  onChange: (next: { repo: string | null; branch: string | null }) => void;
}) {
  const t = useTranslations("claudeRuns.github");
  const [open, setOpen] = useState(true);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [secretLocation, setSecretLocation] = useState("/admin/apps/smrttask/secrets");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  // Cheap boolean call on mount so the button can say "connect GitHub" vs "pick a
  // repo" without spending a repo-list request.
  useEffect(() => {
    api<{ connected: boolean; secret_location: string }>("/api/claude/github")
      .then((r) => {
        setConnected(r.connected);
        if (r.secret_location) setSecretLocation(r.secret_location);
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) setConnected(false);
      });
  }, []);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    try {
      const { repos: list } = await api<{ repos: Repo[] }>("/api/claude/github/repos");
      setRepos(list ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setRepos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // All repos appear by default: as soon as the token is confirmed connected,
  // fetch the list once — no extra click needed to see what can be picked.
  useEffect(() => {
    // Re-entry safe: `loading` blocks a second call mid-fetch, and loadRepos
    // always leaves `repos` non-null (an error sets []), so it fires once.
    if (connected && repos === null && !loading) void loadRepos();
  }, [connected, repos, loading, loadRepos]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && repos === null && connected) void loadRepos();
  }

  const shown = (repos ?? []).filter((r) =>
    query.trim() ? r.full_name.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={open ? "secondary" : "outline"} onClick={toggle} className="gap-1.5">
          <FolderGit2 className="size-4" />
          {repo ?? t("pick")}
        </Button>
        {repo && (
          <>
            <Input
              dir="ltr"
              value={branch ?? ""}
              onChange={(e) => onChange({ repo, branch: e.target.value.trim() || null })}
              placeholder={t("branchPlaceholder")}
              className="h-8 w-40 text-xs"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange({ repo: null, branch: null })}
              aria-label={t("clear")}
              title={t("clear")}
            >
              <X className="size-4" />
            </Button>
          </>
        )}
      </div>

      {connected === false && (
        // Names the exact key and the exact screen (CLAUDE.md: never leave the user
        // hunting for where a credential goes).
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t("notConnected", { key: "GITHUB_TOKEN", where: `/${locale}${secretLocation}` })}
        </p>
      )}

      {open && connected && (
        <div className="space-y-1.5 rounded-md border p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            className="h-8 text-xs"
          />
          {loading ? (
            <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("loading")}
            </p>
          ) : shown.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">{t("noRepos")}</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {shown.map((r) => (
                <li key={r.full_name}>
                  <button
                    type="button"
                    onClick={() => {
                      // Default branch comes along, so the clone targets a branch
                      // that exists rather than assuming "main".
                      onChange({ repo: r.full_name, branch: r.default_branch });
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-1.5 py-1 text-start text-xs hover:bg-muted",
                      repo === r.full_name && "bg-muted",
                    )}
                  >
                    <span dir="ltr" className="min-w-0 flex-1 truncate font-mono">
                      {r.full_name}
                    </span>
                    {r.private && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {t("private")}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
