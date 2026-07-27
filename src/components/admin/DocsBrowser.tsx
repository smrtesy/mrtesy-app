"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Code2, Download, FileText } from "lucide-react";
import { Markdown } from "@/components/common/Markdown";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

interface Doc {
  filename: string;
  content: string;
  created: string | null;
  updated: string | null;
}

/** New York, per CLAUDE.md — never the viewer's local zone, never raw UTC. */
function fmt(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString(locale === "he" ? "he-IL" : "en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function DocsBrowser({
  docs,
  pathPrefix = "docs/",
  emptyMessage,
  linkBase,
}: {
  docs: Doc[];
  /** Path label shown above the rendered doc (e.g. "docs/apps/smrtvoice/"). */
  pathPrefix?: string;
  emptyMessage?: string;
  /**
   * Where these documents live, for resolving their relative cross-references
   * (`./plan.md`). Repo docs pass their GitHub directory URL; documents stored
   * in the DB have no such home, so they omit it and relative links stay inert
   * instead of 404-ing against the app's own origin.
   */
  linkBase?: string;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const preferred = docs.findIndex((d) => d.filename === "new-app-guide.md");
  const [idx, setIdx] = useState(preferred >= 0 ? preferred : 0);
  /** Rendered by default; the raw source is one quiet toggle away. */
  const [raw, setRaw] = useState(false);

  if (docs.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage ?? t("docsEmpty")}</p>;
  }

  const active = docs[idx] ?? docs[0];

  function handleDownload() {
    const blob = new Blob([active.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = active.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <nav className="flex flex-col gap-1">
        {docs.map((d, i) => (
          <button
            key={d.filename}
            onClick={() => setIdx(i)}
            title={d.filename}
            className={cn(
              "text-start rounded-md px-3 py-2 text-xs font-mono transition-colors",
              i === idx
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <span className="block truncate">{d.filename}</span>
            {fmt(d.created, locale) && (
              <span className={cn("block text-[10px] mt-0.5", i === idx ? "opacity-80" : "opacity-60")}>
                {t("docsCreated")}: {fmt(d.created, locale)}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <code className="block text-xs text-muted-foreground truncate">{pathPrefix}{active.filename}</code>
            {fmt(active.created, locale) && (
              <span className="block text-[11px] text-muted-foreground mt-0.5">
                {t("docsCreated")}: {fmt(active.created, locale)}
                {fmt(active.updated, locale) && active.updated !== active.created
                  ? ` · ${t("docsUpdated")}: ${fmt(active.updated, locale)}`
                  : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <IconButton
              label={raw ? t("docsRendered") : t("docsSource")}
              color="primary"
              onClick={() => setRaw((v) => !v)}
            >
              {raw ? <FileText className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
            </IconButton>
            <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />
              {t("docsDownload")}
            </Button>
          </div>
        </div>
        {raw ? (
          <pre
            dir="ltr"
            className="rounded-lg border bg-muted/40 p-4 text-xs font-mono leading-relaxed overflow-auto max-h-[75vh] whitespace-pre-wrap break-words text-start"
          >
            {active.content}
          </pre>
        ) : (
          <div className="rounded-lg border bg-card p-5 overflow-auto max-h-[75vh]">
            <Markdown linkBase={linkBase}>{active.content}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
