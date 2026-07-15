"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Bot, ExternalLink, Check, Plus } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/**
 * "Work with Claude" from the workclock bar (docs/workclock-plan.md §11): opens
 * Claude Code in a side popup, records a claude_action, and lists the open ones
 * with their (best-effort) status + a reopen link. Live status/URL is refined
 * by the smrtesy browser extension reading the claude.ai tab; GitHub gives the
 * authoritative outcome. Absent the extension, this still tracks the launch and
 * lets the user mark it done.
 */

// Reuse one Claude window across opens (claude.ai blocks in-page iframes).
let claudeWindow: Window | null = null;
const CLAUDE_URL = "https://claude.ai/code";
const POPUP = "popup=yes,width=1000,height=900";

interface CAction {
  id: string;
  title: string | null;
  session_url: string | null;
  status: "open" | "running" | "waiting" | "done" | "failed";
  pr_url: string | null;
}

export function ClaudeActions({ dir }: { dir: "rtl" | "ltr" }) {
  const t = useTranslations("workclock");
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<CAction[]>([]);

  const load = useCallback(() => {
    api<{ actions: CAction[] }>("/api/tasks/claude-actions").then((r) => setActions(r.actions ?? [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  function openClaude() {
    if (claudeWindow && !claudeWindow.closed) claudeWindow.focus();
    else claudeWindow = window.open(CLAUDE_URL, "smrtesy-claude", POPUP);
    api("/api/tasks/claude-actions", { method: "POST", body: { status: "open", title: t("claudeDefaultTitle") } })
      .then(() => load()).catch(() => {});
  }

  function reopen(a: CAction) {
    const url = a.session_url || CLAUDE_URL;
    if (claudeWindow && !claudeWindow.closed && !a.session_url) claudeWindow.focus();
    else claudeWindow = window.open(url, "smrtesy-claude", POPUP);
  }

  function markDone(a: CAction) {
    setActions((prev) => prev.filter((x) => x.id !== a.id));
    api(`/api/tasks/claude-actions/${a.id}`, { method: "PATCH", body: { status: "done" } }).then(() => load()).catch(() => load());
  }

  const count = actions.length;
  const waiting = actions.some((a) => a.status === "waiting");

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) load(); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("claudeTitle")}
          aria-label={t("claudeTitle")}
          className={cn(
            "relative grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            waiting && "text-status-warn",
          )}
        >
          <Bot className="h-4 w-4" />
          {count > 0 && (
            <span className={cn(
              "absolute -top-1 -inline-end-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[9px] font-bold text-primary-foreground",
              waiting ? "bg-status-warn" : "bg-primary",
            )} style={{ insetInlineEnd: "-0.25rem" }}>
              {count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" dir={dir} className="w-72 p-2.5 space-y-2">
        <Button size="sm" className="w-full justify-center gap-1.5" onClick={openClaude}>
          <Plus className="h-4 w-4" />{t("claudeOpen")}
        </Button>
        {actions.length === 0 ? (
          <p className="py-1 text-center text-xs text-muted-foreground" dir="auto">{t("claudeNone")}</p>
        ) : (
          <div className="space-y-1">
            {actions.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                <StatusDot status={a.status} />
                <span className="min-w-0 flex-1 truncate text-xs" dir="auto">{a.title || "Claude"}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{t(`claudeStatus_${a.status}`)}</span>
                <button type="button" onClick={() => reopen(a)} title={t("claudeReopen")} aria-label={t("claudeReopen")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => markDone(a)} title={t("claudeMarkDone")} aria-label={t("claudeMarkDone")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-status-ok">
                  <Check className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] leading-snug text-muted-foreground/70" dir="auto">{t("claudeHint")}</p>
      </PopoverContent>
    </Popover>
  );
}

function StatusDot({ status }: { status: CAction["status"] }) {
  const color =
    status === "waiting" ? "bg-status-warn" :
    status === "running" ? "bg-primary" :
    status === "failed" ? "bg-status-late" :
    status === "done" ? "bg-status-ok" : "bg-muted-foreground/40";
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} />;
}
