"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Doc {
  filename: string;
  content: string;
  created: string | null;
  updated: string | null;
}

function fmt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function DocsBrowser({
  docs,
  pathPrefix = "docs/",
  emptyMessage = "אין מסמכים.",
}: {
  docs: Doc[];
  /** Path label shown above the rendered doc (e.g. "docs/apps/smrtvoice/"). */
  pathPrefix?: string;
  emptyMessage?: string;
}) {
  const preferred = docs.findIndex((d) => d.filename === "new-app-guide.md");
  const [idx, setIdx] = useState(preferred >= 0 ? preferred : 0);

  if (docs.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
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
            {fmt(d.created) && (
              <span className={cn("block text-[10px] mt-0.5", i === idx ? "opacity-80" : "opacity-60")}>
                נוצר: {fmt(d.created)}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <code className="block text-xs text-muted-foreground truncate">{pathPrefix}{active.filename}</code>
            {fmt(active.created) && (
              <span className="block text-[11px] text-muted-foreground mt-0.5">
                נוצר: {fmt(active.created)}
                {fmt(active.updated) && active.updated !== active.created ? ` · עודכן: ${fmt(active.updated)}` : ""}
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5 shrink-0">
            <Download className="h-3.5 w-3.5" />
            הורד .md
          </Button>
        </div>
        <pre className="rounded-lg border bg-muted/40 p-4 text-xs font-mono leading-relaxed overflow-auto max-h-[75vh] whitespace-pre-wrap break-words">
          {active.content}
        </pre>
      </div>
    </div>
  );
}
